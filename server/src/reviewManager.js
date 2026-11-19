'use strict';
const { randomUUID } = require('node:crypto');
const { tokens, edits } = require('./mergeEngine');
const { hash } = require('./files');
const { scan } = require('./structures');
const movement = require('./movement');
const { compact } = require('./reviewCompaction');

function changes(before, after) {
  const base = tokens(before), offsets = [0];
  for (const token of base) offsets.push(offsets.at(-1) + token.length);
  let shift = 0;
  return edits(base, tokens(after)).map(edit => {
    const start = offsets[edit.start], end = offsets[edit.end], text = edit.insert.join('');
    const result = { start, end, newStart: start + shift, newEnd: start + shift + text.length, before: before.slice(start, end), after: text };
    shift += text.length - (end - start);
    return result;
  });
}
function position(offset, hunks, right = false) {
  let shift = 0;
  for (const h of hunks) {
    if (offset < h.start || offset === h.start && !right) break;
    if (offset < h.end || offset === h.start && h.start === h.end) return right ? h.newEnd : h.newStart;
    shift += (h.newEnd - h.newStart) - (h.end - h.start);
  }
  return offset + shift;
}
function touched(range, hunks) {
  return hunks.some(h => h.start < range.end && h.end > range.start || h.start === h.end && h.start > range.start && h.start < range.end);
}
function wholeRange(range, hunks) {
  const start = position(range.start, hunks, false), end = position(range.end, hunks, true);
  // A completely removed node has no surviving extent, even if a replacement
  // elsewhere happens to look similar.
  if (hunks.some(h => h.start <= range.start && h.end >= range.end && h.newStart === h.newEnd)) return null;
  return end > start ? { start, end } : null;
}
function contentVersion(sourceVersion, sourceContentHash, contentHash) {
  return contentHash === sourceContentHash ? sourceVersion : hash(`${sourceVersion}:human:${contentHash}`);
}
function remapLegacy(reviews, before, after, actor = 'human', suppliedHunks) {
  if (before === after) return structuredClone(reviews);
  const hunks = suppliedHunks || changes(before, after), result = [];
  for (const review of reviews) {
    if (review.kind === 'delete') {
      const start = position(review.start, hunks, true);
      result.push({ ...review, start, end: start });
      continue;
    }
    let ranges;
    if (review.kind !== 'token') ranges = [wholeRange(review, hunks)].filter(Boolean);
    else if (actor === 'human') {
      // Editing is not approval: pending marks follow replacement text.
      const mapped = [];
      let cursor = review.start;
      for (const h of hunks) {
        if (h.end <= review.start || h.start >= review.end) continue;
        if (h.start > cursor) mapped.push({ start: position(cursor, hunks, true), end: position(Math.min(h.start, review.end), hunks, false) });
        if (h.newEnd > h.newStart) mapped.push({ start: h.newStart, end: h.newEnd });
        cursor = Math.max(cursor, h.end);
      }
      if (cursor < review.end) mapped.push({ start: position(cursor, hunks, true), end: position(review.end, hunks, false) });
      ranges = mapped.filter(r => r.end > r.start).sort((a, b) => a.start - b.start).reduce((result, range) => {
        const last = result.at(-1);
        if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
        else result.push(range);
        return result;
      }, []);
    } else {
      let segments = [{ start: review.start, end: review.end }];
      for (const h of hunks) segments = segments.flatMap(s => {
        if (h.start >= s.end || h.end <= s.start) return [s];
        return [{ start: s.start, end: Math.min(s.end, h.start) }, { start: Math.max(s.start, h.end), end: s.end }].filter(r => r.end > r.start);
      });
      ranges = segments.map(r => ({ start: position(r.start, hunks, true), end: position(r.end, hunks, false) })).filter(r => r.end > r.start);
    }
    for (const range of ranges) {
      const text = after.slice(range.start, range.end);
      if (!text.trim()) continue;
      const changed = text !== review.text;
      const contentHash = hash(text);
      // Human saves share one AI generation: identical current text must have
      // the same version whether reached in one edit or several saved edits.
      let sourceVersion = review.sourceVersion || review.version;
      let sourceContentHash = review.sourceContentHash || review.contentHash || hash(review.text);
      if (actor === 'ai' && (changed || ranges.length > 1 || touched(review, hunks))) {
        sourceVersion = randomUUID(); sourceContentHash = contentHash;
      }
      result.push({ ...review, ...range, text, contentHash,
        id: ranges.length > 1 ? hash(`${review.id}:${range.start - position(review.start, hunks, true)}:${text}`) : review.id,
        sourceVersion, sourceContentHash,
        version: contentVersion(sourceVersion, sourceContentHash, contentHash),
        original: review.kind === 'token' && changed ? null : review.original,
        status: actor === 'ai' && touched(review, hunks) ? 'unreviewed' : review.status });
    }
  }
  return compact(result);
}
function applyAILegacy(previous, before, after, revision, sessionId, mapped, hunks) {
  hunks ||= changes(before, after);
  const reviews = mapped || remapLegacy(previous, before, after, 'ai', hunks), events = [];
  // Invert the same alignment; a second budgeted Diff could choose coarser gaps.
  const reverse = hunks.map(h => ({ start: h.newStart, end: h.newEnd, newStart: h.start, newEnd: h.end, before: h.after, after: h.before }));
  const nodes = scan(after), oldNodes = scan(before);
  for (const h of hunks) {
    const id = randomUUID();
    events.push({ id, sessionId, revision, before: h.before, after: h.after, start: h.newStart, end: h.newEnd, baseStart: h.start, baseEnd: h.end,
      type: !h.before ? 'insert' : !h.after ? 'delete' : 'replace', time: Date.now() });
    if (h.newStart === h.newEnd) {
      if (h.before.trim()) reviews.push({ id: randomUUID(), eventId: id, eventIds: [id], start: h.newStart, end: h.newEnd,
        kind: 'delete', status: 'unreviewed', text: '', deletedText: h.before, initialText: '', original: h.before,
        rejectionMode: 'event', version: randomUUID(), contentHash: hash(''), revision });
      continue;
    }
    const whole = nodes.filter(n => n.type !== 'paragraph' && h.newStart <= n.start && h.newEnd >= n.end)
      .map(n => ({ start: n.start, end: n.end, kind: 'structure' }));
    const split = /\n[ \t]*\n|\\par\b/.test(h.after) && oldNodes.some(n => n.type === 'paragraph' && n.start < h.start && n.end > h.end);
    for (const node of nodes.filter(n => n.type === 'paragraph')) {
      const overlaps = node.start < h.newEnd && node.end > h.newStart;
      const adjacentSplit = split && node.start <= h.newEnd && node.end >= h.newStart;
      const inserted = position(node.start, reverse) === position(node.end, reverse, true);
      if (adjacentSplit || overlaps && (inserted || /\n[ \t]*\n|\\par\b/.test(h.after))) whole.push({ start: node.start, end: node.end, kind: 'paragraph' });
    }
    const ranges = whole.filter((r, index) => !whole.some((other, j) => j !== index && other.start <= r.start && other.end >= r.end && (other.end - other.start > r.end - r.start || j < index)));
    let residual = [{ start: h.newStart, end: h.newEnd, kind: 'token' }];
    for (const group of ranges) residual = residual.flatMap(r => group.start >= r.end || group.end <= r.start ? [r] :
      [{ ...r, end: Math.min(r.end, group.start) }, { ...r, start: Math.max(r.start, group.end) }].filter(r => r.end > r.start));
    for (const range of ranges.concat(residual)) {
      const { kind } = range;
      const covering = reviews.find(r => !['token', 'move', 'delete'].includes(r.kind) && r.start <= range.start && r.end >= range.end);
      if (covering) { covering.eventIds ||= [covering.eventId]; if (!covering.eventIds.includes(id)) covering.eventIds.push(id); covering.revision = revision; continue; }
      // Current state + current edit only. History never decides review status.
      const original = before.slice(position(range.start, reverse), position(range.end, reverse, true));
      const text = after.slice(range.start, range.end);
      if (!text.trim()) continue;
      for (let i = reviews.length - 1; i >= 0; i--) if (reviews[i].kind !== 'delete' && range.start <= reviews[i].start && range.end >= reviews[i].end) reviews.splice(i, 1);
      reviews.push({ id: randomUUID(), eventId: id, eventIds: [id], start: range.start, end: range.end, kind, status: 'unreviewed',
        text, initialText: text, original, rejectionMode: split && kind === 'paragraph' ? 'event' : 'range', version: randomUUID(), contentHash: hash(text), revision });
    }
  }
  return { reviews: compact(reviews), events };
}
function movementAnalysis(before, after, options) {
  const analysis = movement.analyze(before, after, movement.options(options));
  return analysis.pairs.some(pair => pair.eligible && pair.moved) ? analysis : null;
}
function fragment(review, start, end, text) {
  const full = start === review.start && end === review.end, value = text.slice(start, end);
  if (!value.trim()) return null;
  if (full) return { ...review, start, end, text: value, contentHash: hash(value) };
  const sourceVersion = hash((review.sourceVersion || review.version) + ':slice:' + (start - review.start) + ':' + (end - review.start));
  return { ...review, id: hash(review.id + ':slice:' + (start - review.start) + ':' + (end - review.start)),
    start, end, text: value, contentHash: hash(value), sourceVersion, sourceContentHash: hash(value),
    version: sourceVersion, initialText: value, original: null, rejectionMode: 'event' };
}
function outside(reviews, ranges, text) {
  return reviews.flatMap(review => {
    if (review.kind === 'delete') return [review];
    let pieces = [{ start: review.start, end: review.end }];
    for (const range of ranges) pieces = pieces.flatMap(piece => range.start >= piece.end || range.end <= piece.start ? [piece] :
      [{ start: piece.start, end: Math.min(piece.end, range.start) }, { start: Math.max(piece.start, range.end), end: piece.end }].filter(p => p.end > p.start));
    return pieces.map(piece => fragment(review, piece.start, piece.end, text)).filter(Boolean);
  });
}
function pairHunks(pair) {
  return pair.changes.map(change => {
    let { oldStart: start, oldEnd: end, start: newStart, end: newEnd } = change;
    const before = pair.from.raw, after = pair.to.raw;
    while (start < end && newStart < newEnd && /\s/u.test(before[start - pair.from.start]) &&
      before[start - pair.from.start] === after[newStart - pair.to.start]) { start++; newStart++; }
    while (start < end && newStart < newEnd && /\s/u.test(before[end - pair.from.start - 1]) &&
      before[end - pair.from.start - 1] === after[newEnd - pair.to.start - 1]) { end--; newEnd--; }
    return { start, end, newStart, newEnd, before: before.slice(start - pair.from.start, end - pair.from.start),
      after: after.slice(newStart - pair.to.start, newEnd - pair.to.start) };
  });
}
function remap(reviews, before, after, actor = 'human', suppliedHunks, options, suppliedAnalysis) {
  reviews = compact(reviews);
  if (before === after || !reviews.length) return reviews;
  const hunks = suppliedHunks || changes(before, after), analysis = suppliedAnalysis === undefined ? movementAnalysis(before, after, options) : suppliedAnalysis;
  const legacy = remapLegacy(reviews, before, after, actor, hunks);
  if (!analysis) return legacy;
  const pairs = analysis.pairs.filter(pair => pair.eligible), result = outside(legacy, pairs.map(pair => pair.to), after);
  for (const pair of pairs) {
    const local = pairHunks(pair).map(h => ({ ...h, start: h.start - pair.from.start, end: h.end - pair.from.start,
      newStart: h.newStart - pair.to.start, newEnd: h.newEnd - pair.to.start }));
    for (const review of reviews) {
      // A new AI relocation requires a new placement decision. Its text reviews
      // retain their own identities and status independently.
      if (review.kind === 'move' && actor === 'ai' && pair.moved) continue;
      const start = Math.max(review.start, pair.from.start), end = Math.min(review.end, pair.from.end);
      if (end <= start) continue;
      let pieces = [{ start, end }];
      if (actor === 'ai') for (const h of local) pieces = pieces.flatMap(piece => {
        const a = h.start + pair.from.start, b = h.end + pair.from.start;
        if (a >= piece.end || b <= piece.start) return [piece];
        return [{ start: piece.start, end: Math.min(piece.end, a) }, { start: Math.max(piece.start, b), end: piece.end }].filter(p => p.end > p.start);
      });
      for (const piece of pieces) {
        const clipped = fragment(review, piece.start, piece.end, before); if (!clipped) continue;
        const localReview = { ...clipped, start: piece.start - pair.from.start, end: piece.end - pair.from.start };
        if (actor === 'ai') {
          const start = position(localReview.start, local, true), end = position(localReview.end, local, false);
          if (end > start && pair.to.raw.slice(start, end) === clipped.text) result.push({ ...clipped, start: start + pair.to.start, end: end + pair.to.start });
        } else for (const mapped of remapLegacy([localReview], pair.from.raw, pair.to.raw, actor, local)) {
          result.push({ ...mapped, start: mapped.start + pair.to.start, end: mapped.end + pair.to.start });
        }
      }
    }
  }
  return compact(result);
}
function movementEvent(analysis, before, after, revision, sessionId) {
  const ordered = [...analysis.pairs].sort((a, b) => a.to.index - b.to.index), original = [...ordered].sort((a, b) => a.from.index - b.from.index);
  const different = ordered.map((pair, i) => pair === original[i] ? -1 : i).filter(i => i >= 0);
  if (!different.length) return null;
  const first = different[0], last = different.at(-1), slots = ordered.slice(first, last + 1);
  const source = [...slots].sort((a, b) => a.from.index - b.from.index);
  const start = slots[0].to.start, end = slots.at(-1).to.end;
  const cleanGaps = (list, key, text) => list.slice(1).every((pair, i) => !text.slice(list[i][key].end, pair[key].start).trim());
  const canReject = cleanGaps(slots, 'to', after) && cleanGaps(source, 'from', before);
  let inverse = '', at = start;
  for (let i = 0; i < slots.length; i++) {
    inverse += after.slice(at, slots[i].to.start) + source[i].to.raw; at = slots[i].to.end;
  }
  inverse += after.slice(at, end);
  return { id: randomUUID(), sessionId, revision, type: 'move', start, end,
    before: canReject ? inverse : before.slice(source[0].from.start, source.at(-1).from.end), after: after.slice(start, end),
    movement: { canReject, slots: slots.map(pair => ({ start: pair.to.start, end: pair.to.end, order: pair.from.index })), count: slots.filter(pair => pair.eligible && pair.moved).length }, time: Date.now() };
}
function applyAI(previous, before, after, revision, sessionId, options) {
  previous = compact(previous);
  const hunks = changes(before, after);
  const analysis = movementAnalysis(before, after, options);
  const mapped = remap(previous, before, after, 'ai', hunks, options, analysis);
  const audit = applyAILegacy(previous, before, after, revision, sessionId, structuredClone(mapped), hunks);
  if (!analysis) return audit;
  const pairs = analysis.pairs.filter(pair => pair.eligible), targets = pairs.map(pair => pair.to);
  // An ordinary Diff represents a move as delete + insert. Do not display or
  // offer to restore that same text as a second independent deletion.
  audit.reviews = audit.reviews.filter(review => {
    if (review.kind !== 'delete') return true;
    const event = audit.events.find(event => event.id === review.eventId);
    if (!event) return true;
    let ranges = [{ start: event.baseStart, end: event.baseEnd }];
    for (const pair of pairs) ranges = ranges.flatMap(range => pair.from.start >= range.end || pair.from.end <= range.start ? [range] :
      [{ start: range.start, end: Math.min(range.end, pair.from.start) }, { start: Math.max(range.start, pair.from.end), end: range.end }].filter(r => r.end > r.start));
    return ranges.some(range => before.slice(range.start, range.end).trim());
  });
  const reviews = outside(audit.reviews, targets, after);
  // Restore the current content reviews projected through the same exact pairs.
  for (const review of mapped) for (const pair of pairs) {
    const start = Math.max(review.start, pair.to.start), end = Math.min(review.end, pair.to.end);
    if (end > start) { const piece = fragment(review, start, end, after); if (piece) reviews.push(piece); }
  }
  const relocation = movementEvent(analysis, before, after, revision, sessionId);
  if (relocation) audit.events.push(relocation);
  for (const pair of pairs) {
    for (const h of pairHunks(pair)) {
      const event = { id: randomUUID(), sessionId, revision, before: h.before, after: h.after, start: h.newStart, end: h.newEnd,
        type: !h.before ? 'insert' : !h.after ? 'delete' : 'replace', time: Date.now() };
      audit.events.push(event);
      if (!h.after.trim()) {
        if (h.before.trim() && h.newStart === h.newEnd) reviews.push({ id: randomUUID(), eventId: event.id, eventIds: [event.id], start: h.newStart, end: h.newEnd,
          kind: 'delete', status: 'unreviewed', text: '', deletedText: h.before, initialText: '', original: h.before,
          rejectionMode: 'event', version: randomUUID(), contentHash: hash(''), revision });
        continue;
      }
      reviews.push({ id: randomUUID(), eventId: event.id, eventIds: [event.id], start: h.newStart, end: h.newEnd, kind: 'token', status: 'unreviewed',
        text: h.after, initialText: h.after, original: h.before, version: randomUUID(), contentHash: hash(h.after), revision });
    }
    if (pair.moved && relocation) reviews.push({ id: randomUUID(), eventId: relocation.id, eventIds: [relocation.id],
      start: pair.to.start, end: pair.to.end, kind: 'move', status: 'unreviewed', text: pair.to.raw, initialText: pair.to.raw,
      original: null, rejectionMode: 'event', version: randomUUID(), contentHash: hash(pair.to.raw), revision,
      movement: { sourceStart: pair.from.start, sourceEnd: pair.from.end, similarity: pair.score,
        sourceIndex: pair.from.index, targetIndex: pair.to.index, ambiguous: pair.orderAmbiguous, canReject: relocation.movement.canReject } });
  }
  return { reviews: compact(reviews), events: audit.events };
}
function matches(review, operation) {
  return review.id === operation.reviewId && review.version === operation.version && review.contentHash === operation.contentHash;
}
function initialReviews(text) {
  // Preserve whole recognized environments; partition the remainder into paragraphs.
  const structures = scan(text).filter(node => !['paragraph', 'section', 'subsection'].includes(node.type));
  const outer = structures.filter(node => !structures.some(other => other !== node && other.start <= node.start && other.end >= node.end))
    .sort((a, b) => a.start - b.start);
  const ranges = [];
  function paragraphs(start, end) {
    const source = text.slice(start, end);
    let offset = start;
    for (const divider of source.matchAll(/\n[ \t]*\n|\\par\b/g)) {
      const boundary = start + divider.index + divider[0].length;
      ranges.push({ start: offset, end: boundary, kind: 'paragraph' }); offset = boundary;
    }
    ranges.push({ start: offset, end, kind: 'paragraph' });
  }
  let offset = 0;
  for (const node of outer) {
    paragraphs(offset, node.start); ranges.push({ start: node.start, end: node.end, kind: 'structure' }); offset = node.end;
  }
  paragraphs(offset, text.length);
  return ranges.map(range => {
    const value = text.slice(range.start, range.end), leading = value.length - value.trimStart().length;
    const content = value.trim();
    return { id: randomUUID(), eventId: randomUUID(), ...range, start: range.start + leading,
      end: range.start + leading + content.length, origin: 'initial', status: 'unreviewed', text: content,
      initialText: content, original: null, version: randomUUID(), contentHash: hash(content), revision: 1 };
  }).filter(review => review.text);
}
function restoreDeletedEvents(snapshot, current, events) {
  // The deletion offset is already recorded. Re-diffing its inverse can place
  // repeated whitespace on either side. Verify the later edit alignment in
  // both directions, then restore only at the exact mapped snapshot offsets.
  const hunks = changes(snapshot, current), reverse = changes(current, snapshot).map(h => [h.newStart, h.newEnd, h.start, h.end]);
  if (JSON.stringify(hunks.map(h => [h.start, h.end, h.newStart, h.newEnd])) !== JSON.stringify(reverse)) return { ok: false };
  const restored = [];
  for (const event of events) {
    if (hunks.some(h => h.start <= event.end && event.start <= h.end)) return { ok: false };
    const start = position(event.start, hunks, false), end = position(event.end, hunks, true);
    if (current.slice(start, end) !== snapshot.slice(event.start, event.end)) return { ok: false };
    restored.push({ start, end, text: event.before });
  }
  restored.sort((a, b) => b.start - a.start || b.end - a.end);
  let text = current;
  for (let i = 0; i < restored.length; i++) {
    const part = restored[i];
    if (i && part.end > restored[i - 1].start) return { ok: false };
    text = text.slice(0, part.start) + part.text + text.slice(part.end);
  }
  return { ok: true, text };
}
module.exports = { changes, position, wholeRange, contentVersion, remap, applyAI, matches, initialReviews, restoreDeletedEvents };
