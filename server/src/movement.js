'use strict';
// Exact punctuation-bounded matching. This module identifies review correspondences; it never applies text patches.
function createMatcher() {
  const punctuation = /[,。．.，!?！？]/u;
  const references = /^\\(?:cite[a-zA-Z]*|[Cc]ref|eqref|autoref|ref|label|url|path)\*?(?![A-Za-z@])/;
  const segmenter = new Intl.Segmenter('und', { granularity: 'word' });
  function escaped(text, at) { let n = 0; while (at > 0 && text[--at] === '\\') n++; return n % 2 === 1; }
  function protectedAt(text, at) {
    if (text[at] === '%' && !escaped(text, at)) {
      const end = text.indexOf('\n', at); return { start: at, end: end < 0 ? text.length : end, kind: 'comment' };
    }
    let close, length, kind;
    if (text.startsWith('$$', at) && !escaped(text, at)) { close = '$$'; length = 2; kind = 'display'; }
    else if (text[at] === '$' && !escaped(text, at)) { close = '$'; length = 1; kind = 'math'; }
    else if (text.startsWith('\\(', at) && !escaped(text, at)) { close = '\\)'; length = 2; kind = 'math'; }
    else if (text.startsWith('\\[', at) && !escaped(text, at)) { close = '\\]'; length = 2; kind = 'display'; }
    if (close) {
      for (let end = at + length; end < text.length; end++) {
        if (text[end] === '%' && !escaped(text, end)) { const line = text.indexOf('\n', end); if (line < 0) break; end = line; continue; }
        if (text.startsWith(close, end) && !escaped(text, end)) return { start: at, end: end + close.length, kind };
      }
      return { start: at, end: text.length, kind: 'invalid' };
    }
    if (text[at] === '\\' && !escaped(text, at)) {
      const command = references.exec(text.slice(at));
      if (command) {
        let end = at + command[0].length;
        while (true) {
          const begin = end; while (/\s/u.test(text[end] || '') && end < text.length) end++;
          if (!['{', '['].includes(text[end])) { end = begin; break; }
          const open = text[end], close = open === '{' ? '}' : ']'; let depth = 0;
          do { if (!escaped(text, end)) { if (text[end] === open) depth++; if (text[end] === close) depth--; } end++; } while (end < text.length && depth);
          if (depth) return { start: at, end: text.length, kind: 'invalid' };
        }
        return { start: at, end, kind: 'reference' };
      }
      if (text[at + 1] && !/[A-Za-z@]/.test(text[at + 1])) return { start: at, end: at + 2, kind: 'escape' };
    }
  }
  function tokenize(text, start, end) {
    const words = []; let plain = start;
    function flush(to) {
      for (const part of segmenter.segment(text.slice(plain, to))) if (part.isWordLike) {
        words.push({ start: plain + part.index, end: plain + part.index + part.segment.length, key: part.segment, kind: 'word' });
      }
    }
    for (let at = start; at < end;) {
      const unit = protectedAt(text, at);
      if (!unit) { at++; continue; }
      flush(at);
      if (['math', 'reference'].includes(unit.kind)) words.push({ ...unit, key: text.slice(at, unit.end) });
      at = Math.min(end, unit.end); plain = at;
    }
    flush(end); return words;
  }
  function split(text) {
    const result = []; let begin = 0, blocked = false;
    function emit(bodyEnd, end) {
      let start = begin; while (start < bodyEnd && /\s/u.test(text[start])) start++;
      if (start < end && text.slice(start, bodyEnd).trim()) result.push({
        index: result.length, start, end, raw: text.slice(start, end), words: tokenize(text, start, bodyEnd), blocked
      });
      begin = end; blocked = false;
    }
    for (let at = 0; at < text.length;) {
      const unit = protectedAt(text, at);
      if (unit) { blocked ||= ['invalid', 'display'].includes(unit.kind); at = unit.end; continue; }
      // Decimal points are not sentence punctuation.
      if (punctuation.test(text[at]) && !(text[at] === '.' && /\d/.test(text[at - 1] || '') && /\d/.test(text[at + 1] || ''))) {
        let end = at + 1; while (end < text.length && punctuation.test(text[end])) end++;
        emit(at, end); at = end;
      } else at++;
    }
    emit(text.length, text.length);
    return result;
  }
  function lcs(a, b) {
    const width = b.length + 1, table = new Uint16Array((a.length + 1) * width);
    for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] = a[i].key === b[j].key ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
    const pairs = []; let i = 0, j = 0;
    while (i < a.length && j < b.length) {
      if (a[i].key === b[j].key) { pairs.push([i++, j++]); }
      else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) i++;
      else j++;
    }
    return { score: pairs.length / Math.max(a.length, b.length, 1), pairs };
  }
  function relativeOrder(pairs) {
    const ordered = [...pairs].sort((a, b) => a.to.index - b.to.index);
    function lengths(reverse) {
      const tails = [], lengths = [];
      for (let n = 0; n < ordered.length; n++) {
        const i = reverse ? ordered.length - 1 - n : n, value = reverse ? -ordered[i].from.index : ordered[i].from.index;
        let low = 0, high = tails.length;
        while (low < high) { const mid = low + high >>> 1; if (tails[mid] < value) low = mid + 1; else high = mid; }
        tails[low] = value; lengths[i] = low + 1;
      }
      return lengths;
    }
    const forward = lengths(false), backward = lengths(true), longest = forward.reduce((maximum, value) => Math.max(maximum, value), 0), levels = new Map();
    for (let i = 0; i < ordered.length; i++) if (forward[i] + backward[i] - 1 === longest) levels.set(forward[i], (levels.get(forward[i]) || 0) + 1);
    for (let i = 0; i < ordered.length; i++) {
      const possible = forward[i] + backward[i] - 1 === longest;
      ordered[i].moved = !possible || levels.get(forward[i]) !== 1;
      ordered[i].orderAmbiguous = possible && levels.get(forward[i]) !== 1;
    }
  }
  function localChanges(pair) {
    const result = []; let oldAt = 0, newAt = 0;
    for (const [a, b] of pair.alignment.concat([[pair.from.words.length, pair.to.words.length]])) {
      const oldEnd = a < pair.from.words.length ? pair.from.words[a].start - pair.from.start : pair.from.raw.length;
      const newEnd = b < pair.to.words.length ? pair.to.words[b].start - pair.to.start : pair.to.raw.length;
      if (pair.from.raw.slice(oldAt, oldEnd) !== pair.to.raw.slice(newAt, newEnd)) result.push({ oldStart: pair.from.start + oldAt, oldEnd: pair.from.start + oldEnd, start: pair.to.start + newAt, end: pair.to.start + newEnd });
      if (a < pair.from.words.length) oldAt = pair.from.words[a].end - pair.from.start;
      if (b < pair.to.words.length) newAt = pair.to.words[b].end - pair.to.start;
    }
    return result;
  }
  function analyze(before, after, { threshold = 0.8, minWords = 8, maxWords = 400 } = {}) {
    if (!(threshold > 0 && threshold <= 1) || !Number.isInteger(minWords) || minWords < 1 || !Number.isInteger(maxWords) || maxWords > 1000 || maxWords < minWords) throw Error('Invalid movement matching parameters.');
    const old = split(before), fresh = split(after), pairs = [], usedOld = new Set(), usedNew = new Set(), ambiguous = new Set();
    const key = range => JSON.stringify(range.words.map(word => word.key));
    function groups(ranges) {
      const result = new Map();
      for (const range of ranges.filter(r => !r.blocked && r.words.length && r.words.length <= maxWords)) {
        const signature = key(range); if (!result.has(signature)) result.set(signature, []); result.get(signature).push(range);
      }
      return result;
    }
    const a = groups(old), b = groups(fresh);
    const accept = (from, to, comparison) => { pairs.push({ from, to, score: comparison.score, alignment: comparison.pairs }); usedOld.add(from.index); usedNew.add(to.index); };
    for (const [signature, left] of a) {
      const right = b.get(signature); if (!right) continue;
      if (left.length !== 1 || right.length !== 1) { for (const item of left) ambiguous.add('a' + item.index); for (const item of right) ambiguous.add('b' + item.index); continue; }
      accept(left[0], right[0], { score: 1, pairs: left[0].words.map((_, index) => [index, index]) });
    }
    const eligible = range => !range.blocked && range.words.length >= minWords && range.words.length <= maxWords;
    const candidates = []; let comparisons = 0, cells = 0, limited = false;
    function bag(range) { if (!range.bag) { range.bag = new Map(); for (const word of range.words) range.bag.set(word.key, (range.bag.get(word.key) || 0) + 1); } return range.bag; }
    function upperBound(from, to) { let common = 0; for (const [key, count] of bag(from)) common += Math.min(count, bag(to).get(key) || 0); return common / Math.max(from.words.length, to.words.length); }
    search: for (const from of old.filter(r => eligible(r) && !usedOld.has(r.index) && !ambiguous.has('a' + r.index))) {
      for (const to of fresh.filter(r => eligible(r) && !usedNew.has(r.index) && !ambiguous.has('b' + r.index))) {
        if (++comparisons > 10000) { limited = true; break search; }
        if (Math.min(from.words.length, to.words.length) / Math.max(from.words.length, to.words.length) < threshold) continue;
        if (upperBound(from, to) < threshold) continue;
        cells += (from.words.length + 1) * (to.words.length + 1);
        if (cells > 4000000) { limited = true; break search; }
        const comparison = lcs(from.words, to.words);
        if (comparison.score >= threshold) candidates.push({ from, to, comparison });
      }
    }
    // Multiple qualifying partners are ambiguous: never guess using prose similarity.
    for (const candidate of limited ? [] : candidates) {
      if (candidates.filter(c => c.from.index === candidate.from.index).length === 1 && candidates.filter(c => c.to.index === candidate.to.index).length === 1) accept(candidate.from, candidate.to, candidate.comparison);
      else { ambiguous.add('a' + candidate.from.index); ambiguous.add('b' + candidate.to.index); }
    }
    relativeOrder(pairs);
    for (const pair of pairs) {
      pair.eligible = eligible(pair.from) && eligible(pair.to);
      pair.kind = !pair.eligible ? 'anchor-only' : pair.moved ? pair.from.raw === pair.to.raw ? 'move' : 'move-edit' : pair.from.raw === pair.to.raw ? 'unchanged' : 'edit';
      pair.changes = localChanges(pair);
    }
    return { old, fresh, pairs, threshold, minWords, limited, fallback: fresh.filter(r => !pairs.some(p => p.to === r && p.eligible)).map(r => ({
      index: r.index, reason: r.blocked ? '受保护／不完整的 LaTeX 块' : r.words.length < minWords ? '词数不足' : r.words.length > maxWords ? '片段过长' : ambiguous.has('b' + r.index) ? '重复或多候选，无法唯一匹配' : '重合度不足或无对应片段'
    })) };
  }
  return { split, lcs, analyze };
}
const matcher = createMatcher();
const defaults = Object.freeze({ threshold: 0.8, minWords: 8 });
function options(value = {}) {
  return { threshold: Number.isFinite(value?.threshold) && value.threshold >= 0.5 && value.threshold <= 1 ? value.threshold : defaults.threshold,
    minWords: Number.isInteger(value?.minWords) && value.minWords >= 1 && value.minWords <= 400 ? value.minWords : defaults.minWords };
}
module.exports = { ...matcher, options, defaults };
