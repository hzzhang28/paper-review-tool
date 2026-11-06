'use strict';
const { diffArrays } = require('diff');

// Tokens preserve every UTF-16 code unit, including comments and whitespace.
// No fuzzy patch application: all edits refer to the same actual base snapshot.
function tokens(text) {
  return text.match(/\\(?:[A-Za-z@]+\*?|[^\r\n])|[\p{L}\p{N}_]+|[ \t]+|\n|[^]/gu) || [];
}

// Exact unique lines split expensive comparisons into independent local gaps.
// No text is searched for or patched at an approximate position.
function lineAnchors(base, next, a0, a1, b0, b1) {
  function lines(values, start, end) {
    const result = [];
    for (let offset = start; offset < end;) {
      let stop = offset;
      while (stop < end && values[stop++] !== '\n') {}
      result.push({ start: offset, end: stop, key: JSON.stringify(values.slice(offset, stop)) });
      offset = stop;
    }
    return result;
  }
  function unique(values) {
    const map = new Map();
    for (const line of values) map.set(line.key, map.has(line.key) ? null : line);
    return map;
  }
  const left = lines(base, a0, a1), right = unique(lines(next, b0, b1)), counts = unique(left);
  const pairs = left.filter(line => counts.get(line.key) && right.get(line.key))
    .map(line => ({ a: line, b: right.get(line.key) }));
  // Longest increasing sequence excludes moved/crossing anchors.
  const tails = [], previous = [];
  for (let i = 0; i < pairs.length; i++) {
    let low = 0, high = tails.length;
    while (low < high) { const mid = low + high >>> 1; if (pairs[tails[mid]].b.start < pairs[i].b.start) low = mid + 1; else high = mid; }
    previous[i] = low ? tails[low - 1] : -1;
    tails[low] = i;
  }
  const anchors = [];
  for (let i = tails.at(-1); i !== undefined && i !== -1; i = previous[i]) anchors.push(pairs[i]);
  return anchors.reverse();
}
function edits(base, next) {
  const result = [], deadline = Date.now() + 500;
  function refine(a0, a1, b0, b1, depth = 0) {
    while (a0 < a1 && b0 < b1 && base[a0] === next[b0]) { a0++; b0++; }
    while (a0 < a1 && b0 < b1 && base[a1 - 1] === next[b1 - 1]) { a1--; b1--; }
    if (a0 === a1 && b0 === b1) return;
    if (a0 === a1 || b0 === b1) { result.push({ start: a0, end: a1, insert: next.slice(b0, b1) }); return; }
    if (a1 - a0 + b1 - b0 > 2048 && depth < 8) {
      const anchors = lineAnchors(base, next, a0, a1, b0, b1);
      if (anchors.length) {
        for (const anchor of anchors) {
          refine(a0, anchor.a.start, b0, anchor.b.start, depth + 1);
          a0 = anchor.a.end; b0 = anchor.b.end;
        }
        refine(a0, a1, b0, b1, depth + 1);
        return;
      }
    }
    const remaining = deadline - Date.now();
    const changes = remaining > 0 && a1 - a0 + b1 - b0 <= 2048 &&
      diffArrays(base.slice(a0, a1), next.slice(b0, b1), { timeout: Math.min(50, remaining), maxEditLength: 512 });
    if (!changes) {
      // A difficult gap is one exact replacement. Review becomes coarser;
      // concurrent overlapping changes still conflict in the merge below.
      result.push({ start: a0, end: a1, insert: next.slice(b0, b1) }); return;
    }
    let offset = a0, edit;
    const flush = () => { if (edit) result.push(edit); edit = undefined; };
    for (const change of changes) {
      if (!change.added && !change.removed) { flush(); offset += change.count; continue; }
      edit ||= { start: offset, end: offset, insert: [] };
      if (change.removed) { offset += change.count; edit.end = offset; }
      if (change.added) edit.insert.push(...change.value);
    }
    flush();
  }
  refine(0, base.length, 0, next.length);
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
