'use strict';
const { hash } = require('./files');

// Coarse replacements can map many old reviews to the same current interval.
// Keep one decision per interval, preserving all event references and the most
// conservative status. History remains independent of the current overlay.
function accumulator() {
  const groups = new Map();
  function add(review) {
    const category = ['move', 'delete', 'coarse'].includes(review.kind) ? review.kind : 'content';
    const key = `${category}:${review.start}:${review.end}${category === 'delete' ? ':' + review.id : ''}`;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { review: { ...review }, ids: new Set(review.eventIds || [review.eventId].filter(Boolean)), merged: false });
      return;
    }
    const old = existing.review;
    // Different generations with the same ID and content are genuinely equal.
    for (const id of review.eventIds || [review.eventId].filter(Boolean)) existing.ids.add(id);
    if (old.id === review.id && old.version === review.version && old.status === review.status && old.text === review.text) return;
    const chosen = (review.revision || 0) > (old.revision || 0) ? review : old;
    existing.review = { ...chosen, status: old.status === 'needsFix' || review.status === 'needsFix' ? 'needsFix' : 'unreviewed' };
    existing.merged = true;
  }
  function finish() {
    return [...groups.values()].map(({ review, ids, merged }) => {
      const eventIds = [...ids];
      if (!merged) return review.eventIds ? { ...review, eventIds } : review;
      const version = hash(`compacted:${review.start}:${review.end}:${review.text}:${eventIds.slice().sort().join(':')}:${review.status}`);
      return { ...review, id: version, version, sourceVersion: version, sourceContentHash: review.contentHash,
        eventIds, eventId: eventIds.at(-1), original: null, rejectionMode: 'event' };
    });
  }
  return { add, finish };
}
function compact(reviews) { const result = accumulator(); for (const review of reviews || []) result.add(review); return result.finish(); }
module.exports = { compact, accumulator };
