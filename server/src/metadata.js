'use strict';
const { hash } = require('./files');
const { matches } = require('./reviewManager');

function applyReviewOperations(reviews, operations, context) {
  let result = structuredClone(reviews);
  const applied = [], stale = [];
  for (const operation of operations) {
    if (operation.action === 'mark') {
      const marked = context?.mapMark(operation);
      if (!marked) { stale.push(operation); continue; }
      // Old manual marks cannot overwrite newer AI reviews.
      let ranges = [{ start: marked.start, end: marked.end }];
      for (const existing of result) ranges = ranges.flatMap(r => existing.start >= r.end || existing.end <= r.start ? [r] :
        [{ start: r.start, end: Math.min(r.end, existing.start) }, { start: Math.max(r.start, existing.end), end: r.end }].filter(r => r.end > r.start));
      for (const range of ranges) {
        const text = marked.text.slice(range.start - marked.start, range.end - marked.start);
        if (!text.trim()) continue;
        result.push({ ...marked, ...range, text, contentHash: hash(text),
          id: range.start === marked.start && range.end === marked.end ? marked.id : hash(marked.id + ':' + range.start + ':' + range.end) });
      }
      applied.push(operation); continue;
    }
    const review = result.find(r => matches(r, operation));
    if (!review) { stale.push(operation); continue; }
    const selected = operation.selection || { start: 0, end: review.end - review.start };
    const fragments = [
      { start: 0, end: selected.start, status: review.status },
      { ...selected, status: operation.action === 'approve' ? 'approved' : operation.action === 'unreviewed' ? 'unreviewed' : 'needsFix' },
      { start: selected.end, end: review.end - review.start, status: review.status }
    ].filter(s => s.end > s.start && s.status !== 'approved').map(s => {
      const full = s.start === 0 && s.end === review.text.length;
      const text = review.text.slice(s.start, s.end);
      return { ...review, id: full ? review.id : hash(`${review.id}:${s.start}:${s.end}`),
        start: review.start + s.start, end: review.start + s.end, text,
        contentHash: hash(text), status: s.status, original: full ? review.original : null,
        initialText: full ? review.initialText : text };
    }).filter(fragment => fragment.text.trim());
    result = result.flatMap(r => r === review ? fragments : [r]);
    applied.push(operation);
  }
  return { reviews: result, applied, stale };
}
function applyRejections(reviews, rejections) {
  let result = reviews;
  for (const rejected of rejections) result = result.flatMap(review => {
    if (!rejected.wholeEvent && review.id !== rejected.reviewId) return [review];
    const originalIds = review.eventIds || [review.eventId];
    const ids = originalIds.filter(id => !rejected.eventIds.includes(id));
    if (ids.length === originalIds.length) return [review];
    return ids.length ? [{ ...review, eventIds: ids, eventId: ids.at(-1), original: null, rejectionMode: 'event' }] : [];
  });
  return result;
}
module.exports = { applyReviewOperations, applyRejections };
