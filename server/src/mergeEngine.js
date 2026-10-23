'use strict';
const { diffArrays } = require('diff');

// Tokens preserve every UTF-16 code unit, including comments and whitespace.
// No fuzzy patch application: all edits refer to the same actual base snapshot.
function tokens(text) {
  return text.match(/\\(?:[A-Za-z@]+\*?|[^\r\n])|[\p{L}\p{N}_]+|[ \t]+|\n|[^]/gu) || [];
}

function edits(base, next) {
  const changes = diffArrays(base, next, { timeout: 2000, maxEditLength: 20000 });
  if (!changes) throw new Error('Diff budget exceeded; manual merge required.');
  const result = [];
  let offset = 0, edit;
  const flush = () => { if (edit) result.push(edit); edit = undefined; };
  for (const change of changes) {
    if (!change.added && !change.removed) { flush(); offset += change.count; continue; }
    edit ||= { start: offset, end: offset, insert: [] };
    if (change.removed) { offset += change.count; edit.end = offset; }
    if (change.added) edit.insert = edit.insert.concat(change.value);
  }
  flush();
  return result;
}

function overlaps(a, b) {
  if (a.start === a.end || b.start === b.end) {
    // Boundary insertions are deliberately conservative.
    return a.start <= b.end && b.start <= a.end;
  }
  return a.start < b.end && b.start < a.end;
}

function ambiguous(base, edit) {
  // Require a unique local context for rebasing repeated passages. Even an
  // identical two-sided edit can be ambiguous when its base passage repeats.
  const start = Math.max(0, edit.start - 12);
  const end = Math.min(base.length, Math.max(edit.end, edit.start + 1) + 12);
  const context = base.slice(start, end);
  let matches = 0;
  outer: for (let i = 0; i <= base.length - context.length; i++) {
    for (let j = 0; j < context.length; j++) if (base[i + j] !== context[j]) continue outer;
    if (++matches > 1) return true;
  }
  return false;
}

function alignmentAmbiguous(base, next, forward) {
  const backward = edits([...base].reverse(), [...next].reverse()).map(edit => ({
    start: base.length - edit.end,
    end: base.length - edit.start,
    insert: [...edit.insert].reverse()
  })).reverse();
  // Opposite tie-breaking directions must agree on the actual base ranges.
  return JSON.stringify(forward) !== JSON.stringify(backward);
}

function merge(baseText, currentText, incomingText) {
  if (incomingText === baseText) return { ok: true, text: currentText };
  if (currentText === baseText) return { ok: true, text: incomingText };
  try {
    const base = tokens(baseText);
    const currentTokens = tokens(currentText), incomingTokens = tokens(incomingText);
    const current = edits(base, currentTokens);
    const incoming = edits(base, incomingTokens);
    const conflicts = [];
    if (alignmentAmbiguous(base, currentTokens, current) || alignmentAmbiguous(base, incomingTokens, incoming)) {
      return { ok: false, conflicts: [{ reason: 'Token alignment is not unique in both diff directions' }] };
    }
    for (const edit of [...current, ...incoming]) {
      if (ambiguous(base, edit)) conflicts.push({ reason: 'Ambiguous repeated base context', ...edit });
    }
    const accepted = [...current];
    for (const edit of incoming) {
      const shared = current.filter(other => overlaps(edit, other));
      if (shared.length === 1 && JSON.stringify(shared[0]) === JSON.stringify(edit)) continue;
      if (shared.length) conflicts.push({ reason: 'Overlapping token edits', incoming: edit, current: shared });
      else accepted.push(edit);
    }
    if (conflicts.length) return { ok: false, conflicts };
    accepted.sort((a, b) => a.start - b.start || a.end - b.end);
    let cursor = 0;
    const output = [];
    for (const edit of accepted) {
      output.push(base.slice(cursor, edit.start).join(''), edit.insert.join(''));
      cursor = edit.end;
    }
    output.push(base.slice(cursor).join(''));
    return { ok: true, text: output.join('') };
  } catch (error) {
    return { ok: false, conflicts: [{ reason: error.message }] };
  }
}

module.exports = { tokens, edits, merge };
