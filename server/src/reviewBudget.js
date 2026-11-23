'use strict';

// Presentation/audit limits, never merge rules. Exceeding them must not make
// an ambiguous text merge acceptable or silently approve any pending text.
const limits = Object.freeze({ changedChars: 24000, hunks: 300, deletedChars: 8000, deletions: 100, decorations: 1000, inputChars: 1000000 });
const message = '审计范围或删除内容过多，已改为整体标黄，暂不展开逐项差异和删除预览，以避免卡顿。审计仍待人工确认，已提交的完整文本保留在历史快照中。';
function inputReason(before, after) {
  if (Math.abs(before.length - after.length) > limits.changedChars) return 'changed-size';
  if (before.length + after.length <= limits.inputChars) return;
  let start = 0, a = before.length, b = after.length;
  while (start < a && start < b && before[start] === after[start]) start++;
  while (a > start && b > start && before[a - 1] === after[b - 1]) { a--; b--; }
  if (a + b - start * 2 > limits.changedChars) return 'input-size';
}
function hunkReason(hunks) {
  if (hunks.length > limits.hunks) return 'hunk-count';
  let changed = 0, removed = 0, deletions = 0;
  for (const h of hunks) {
    changed += h.before.length + h.after.length;
    if (!h.after.length) { removed += h.before.length; deletions++; }
    if (changed > limits.changedChars) return 'changed-size';
    if (removed > limits.deletedChars || deletions > limits.deletions) return 'deletion-size';
  }
}
function displayReason(reviews) {
  if (reviews.length > limits.decorations) return 'decoration-count';
  let removed = 0, deletions = 0;
  for (const review of reviews) {
    if (review.coarse) return 'coarse';
    if (review.kind !== 'delete') continue;
    removed += (review.deletedText || '').length; deletions++;
    if (removed > limits.deletedChars || deletions > limits.deletions) return 'deletion-size';
  }
}
module.exports = { limits, message, inputReason, hunkReason, displayReason };
