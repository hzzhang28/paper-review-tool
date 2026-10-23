'use strict';
const { randomUUID } = require('node:crypto');
const { tokens, edits } = require('./mergeEngine');
const { hash } = require('./files');
const { scan } = require('./structures');

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
function remap(reviews, before, after, actor = 'human') {
  if (before === after) return structuredClone(reviews);
  const hunks = changes(before, after), result = [];
  for (const review of reviews) {
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
      result.push({ ...review, ...range, text, contentHash: hash(text),
        id: ranges.length > 1 ? hash(`${review.id}:${range.start - position(review.start, hunks, true)}:${text}`) : review.id,
        version: changed || ranges.length > 1 ? hash(`${review.version}:${actor}:${text}`) : review.version,
        original: review.kind === 'token' && changed ? null : review.original,
        status: actor === 'ai' && touched(review, hunks) ? 'unreviewed' : review.status });
    }
  }
  return result;
}
function applyAI(previous, before, after, revision, sessionId) {
  const hunks = changes(before, after), reviews = remap(previous, before, after, 'ai'), events = [];
  const nodes = scan(after), oldNodes = scan(before), reverse = changes(after, before);
  for (const h of hunks) {
    const id = randomUUID();
    events.push({ id, sessionId, revision, before: h.before, after: h.after, start: h.newStart, end: h.newEnd,
      type: !h.before ? 'insert' : !h.after ? 'delete' : 'replace', time: Date.now() });
    if (h.newStart === h.newEnd) continue;
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
      const covering = reviews.find(r => r.kind !== 'token' && r.start <= range.start && r.end >= range.end);
      if (covering) { covering.eventIds = [...(covering.eventIds || [covering.eventId]), id]; covering.revision = revision; continue; }
      // Current state + current edit only. History never decides review status.
      const original = before.slice(position(range.start, reverse), position(range.end, reverse, true));
      const text = after.slice(range.start, range.end);
      if (!text.trim()) continue;
      for (let i = reviews.length - 1; i >= 0; i--) if (range.start <= reviews[i].start && range.end >= reviews[i].end) reviews.splice(i, 1);
      reviews.push({ id: randomUUID(), eventId: id, eventIds: [id], start: range.start, end: range.end, kind, status: 'unreviewed',
        text, initialText: text, original, rejectionMode: split && kind === 'paragraph' ? 'event' : 'range', version: randomUUID(), contentHash: hash(text), revision });
    }
  }
  return { reviews, events };
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
module.exports = { changes, position, wholeRange, remap, applyAI, matches, initialReviews };
