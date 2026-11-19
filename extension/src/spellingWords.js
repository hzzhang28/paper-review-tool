'use strict';
// Mask non-prose TeX while preserving UTF-16 offsets. This is deliberately a
// lightweight scanner, not a parser or a compiler.
function words(text) {
  const blank = value => value.replace(/[^\n]/g, ' ');
  let source = text.replace(/\\verb\*?([^\w\s])[^\n]*?\1/g, blank)
    .replace(/\\begin\{(verbatim\*?|lstlisting|minted|equation\*?|align\*?|gather\*?|displaymath)\}[\s\S]*?\\end\{\1\}/g, blank)
    .replace(/(^|[^\\])(?:\\\\)*%[^\n]*/gm, value => value.slice(0, value.indexOf('%')) + blank(value.slice(value.indexOf('%'))))
    .replace(/(?<!\\)\$\$[\s\S]*?(?<!\\)\$\$|(?<!\\)\$[^$]*?(?<!\\)\$|\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]/g, blank);
  // Unknown/unfinished math is omitted until its closing delimiter is typed.
  source = source.replace(/(?<!\\)\$[^$]*$|\\\([^]*$/, blank);
  const chars = source.split('');
  const command = /\\([A-Za-z@]+)\*?/g;
  const hidden = /^(?:[Cc]ite\w*|[Cc]ref|ref|eqref|autoref|label|url|href|path|input|include|includegraphics|bibliography|bibliographystyle|begin|end|documentclass|usepackage)$/;
  for (const match of source.matchAll(command)) {
    let end = match.index + match[0].length;
    if (hidden.test(match[1])) {
      let argumentsLeft = match[1] === 'href' ? 1 : Infinity;
      while (argumentsLeft) {
        const begin = end; while (/\s/.test(source[end] || '')) end++;
        if (!['[', '{'].includes(source[end])) { end = begin; break; }
        const open = source[end], close = open === '[' ? ']' : '}'; let depth = 0;
        do { if (source[end] === '\\') { end += 2; continue; } if (source[end] === open) depth++; if (source[end] === close) depth--; end++; } while (depth && end < source.length);
        if (open === '{') argumentsLeft--;
      }
    }
    for (let i = match.index; i < end; i++) if (chars[i] !== '\n') chars[i] = ' ';
  }
  const result = [];
  for (const match of chars.join('').matchAll(/[A-Za-z]+(?:['’][A-Za-z]+)*/g)) {
    const word = match[0];
    if (word.length >= 3 && word.length <= 40 && !/^[A-Z]+$/.test(word) && !/[a-z][A-Z]/.test(word)) result.push({ word, start: match.index, end: match.index + word.length });
  }
  return result;
}
module.exports = { words };
