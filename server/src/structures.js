'use strict';
const { hash } = require('./files');
const environments = new Set(['theorem', 'lemma', 'proposition', 'assumption', 'definition', 'remark', 'proof', 'figure']);

function visibleSource(text) {
  // Keep UTF-16 offsets while excluding comments, verbatim and inline verb.
  let masked = text.replace(/\\verb\*?([^\w\s])[^\n]*?\1/g, value => value.replace(/[^\n]/g, ' '));
  masked = masked.replace(/\\begin\{(verbatim\*?|lstlisting|minted)\}[\s\S]*?\\end\{\1\}/g, value => value.replace(/[^\n]/g, ' '));
  return masked.replace(/(^|[^\\])(?:\\\\)*%[^\n]*/gm, value => {
    const index = value.indexOf('%'); return value.slice(0, index) + ' '.repeat(value.length - index);
  });
}
function scan(text) {
  const source = visibleSource(text), nodes = [], stack = [];
  const expression = /\\(begin|end)\{([A-Za-z*]+)\}|\\(subsection|section)\*?(?:\[[^\]\n]*\])?\{([^{}\n]*)\}|\\appendix\b/g;
  for (const match of source.matchAll(expression)) {
    if (match[0] === '\\appendix') {
      nodes.push({ type: 'section', appendix: true, start: match.index, headerEnd: match.index + match[0].length, end: source.length });
    } else if (match[3]) {
      nodes.push({ type: match[3], start: match.index, headerEnd: match.index + match[0].length, end: source.length });
    } else if (match[1] === 'begin') stack.push({ type: match[2].replace(/\*$/, ''), start: match.index, headerEnd: match.index + match[0].length });
    else {
      const open = stack.pop();
      if (!open || open.type !== match[2].replace(/\*$/, '')) { stack.length = 0; continue; }
      if (environments.has(open.type)) nodes.push({ ...open, end: match.index + match[0].length });
    }
  }
  const sections = nodes.filter(n => ['section', 'subsection'].includes(n.type)).sort((a, b) => a.start - b.start);
  for (let i = 0; i < sections.length; i++) {
    const next = sections.slice(i + 1).find(n => n.type === 'section' || sections[i].type === 'subsection');
    sections[i].end = next?.start ?? source.length;
  }
  const boundaries = [0];
  for (const match of source.matchAll(/\n[ \t]*\n|\\par\b/g)) boundaries.push(match.index, match.index + match[0].length);
  boundaries.push(source.length);
  for (let i = 0; i < boundaries.length - 1; i++) {
    let start = boundaries[i], end = boundaries[i + 1];
    while (start < end && /\s/.test(source[start])) start++;
    while (end > start && /\s/.test(source[end - 1])) end--;
    if (end <= start) continue;
    // Paragraphs inside environments are represented by their environment.
    // Split off a section header; an ordinary source newline is not a paragraph.
    const section = sections.find(n => n.start === start);
    if (section) { start = section.headerEnd; while (start < end && /\s/.test(source[start])) start++; }
    if (start < end && !nodes.some(n => environments.has(n.type) && start < n.end && end > n.start) && !/\\(?:begin|end)\{/.test(source.slice(start, end))) {
      nodes.push({ type: 'paragraph', start, end });
    }
  }
  const counts = {};
  return nodes.sort((a, b) => a.start - b.start || a.end - b.end).map(node => {
    const labels = [...source.slice(node.start, node.end).matchAll(/\\label\{([^{}\n]+)\}/g)].map(m => m[1]);
    // A section must not accidentally inherit a nested theorem's label.
    const ownEnd = ['section', 'subsection'].includes(node.type) ? Math.min(node.end, source.indexOf('\n', node.headerEnd) < 0 ? node.headerEnd : source.indexOf('\n', node.headerEnd)) : node.end;
    const ownLabel = /\\label\{([^{}\n]+)\}/.exec(source.slice(node.start, ownEnd));
    return { ...node, label: ['section', 'subsection'].includes(node.type) ? ownLabel?.[1] : labels.length === 1 ? labels[0] : undefined,
      ordinal: counts[node.type] = (counts[node.type] || 0) + 1,
      fingerprint: hash(text.slice(node.start, node.end)), context: text.slice(node.start, Math.min(node.end, node.start + 100)) };
  });
}
function structureAt(text, offset) {
  const candidates = scan(text).filter(n => n.start <= offset && offset < n.end);
  candidates.sort((a, b) => (a.end - a.start) - (b.end - b.start));
  if (!candidates.length) throw new Error('No reliably recognized supported structure at this position.');
  return candidates[0];
}
function headings(text) {
  const source = visibleSource(text), result = [];
  const levels = { part: 0, chapter: 1, section: 2, subsection: 3, subsubsection: 4 };
  const expression = /\\appendix\b|\\(part|chapter|section|subsection|subsubsection)\*?\s*(?:\[[^\]\n]*\]\s*)?\{/g;
  for (const match of source.matchAll(expression)) {
    if (match[0] === '\\appendix') {
      result.push({ type: 'appendix', level: levels.section, start: match.index, end: match.index + match[0].length, title: 'Appendix' });
      continue;
    }
    const start = match.index + match[0].length; let depth = 1, end = start;
    for (; end < source.length && depth; end++) {
      if (source[end] === '\\') { end++; continue; }
      if (source[end] === '{') depth++;
      else if (source[end] === '}') depth--;
    }
    if (depth) continue;
    result.push({ type: match[1], level: levels[match[1]], start: match.index, end,
      title: text.slice(start, end - 1).replace(/\s+/g, ' ').trim() || match[1] });
  }
  return result;
}
function lineNodes(text) {
  const nodes = []; let start = 0;
  for (const value of text.split('\n')) {
    const content = value.trim(), leading = value.length - value.trimStart().length;
    if (content) {
      const labels = [...visibleSource(value).matchAll(/\\label\{([^{}\n]+)\}/g)];
      nodes.push({ type: 'line', start: start + leading, end: start + leading + content.length,
        label: labels.length === 1 ? labels[0][1] : undefined, fingerprint: hash(content), context: content.slice(0, 100), ordinal: nodes.length + 1 });
    }
    start += value.length + 1;
  }
  return nodes;
}
function anchorAt(text, offset, mode = 'line') {
  if (!Number.isInteger(offset) || offset < 0 || offset > text.length) throw new Error('Invalid Issue position.');
  if (!['line', 'paragraph'].includes(mode)) throw new Error('Choose a line or paragraph anchor.');
  if (mode === 'paragraph') {
    const node = scan(text).find(n => n.type === 'paragraph' && n.start <= offset && offset < n.end);
    if (node) return node;
  }
  const lineStart = offset === 0 ? 0 : text.lastIndexOf('\n', offset - 1) + 1;
  const lineEnd = text.indexOf('\n', offset);
  const node = lineNodes(text).find(n => n.start >= lineStart && n.end <= (lineEnd < 0 ? text.length : lineEnd));
  if (!node) throw new Error('Choose a nonempty source line for the Issue.');
  return node;
}
function minimizeIssues(issues, text, legacyParagraphs = false) {
  return issues.map(issue => {
    if (issue.type !== 'anchored' || issue.anchor?.type === 'line' || issue.anchor?.type === 'paragraph' && !legacyParagraphs) return issue;
    try { return { ...issue, originalAnchor: issue.originalAnchor || issue.anchor, anchor: anchorAt(text, issue.anchor.start) }; }
    catch { return { ...issue, type: 'general', originalAnchor: issue.anchor, anchor: undefined }; }
  });
}
function relocate(issues, before, after, mapRange) {
  const nodes = scan(after).filter(n => n.type === 'paragraph').concat(lineNodes(after));
  return minimizeIssues(issues, before).map(issue => {
    if (issue.type !== 'anchored') return issue;
    const old = issue.anchor;
    let candidates;
    const mapped = mapRange(old);
    // A deleted node must not jump to a duplicate elsewhere.
    if (!mapped) return { ...issue, type: 'general', originalAnchor: old, anchor: undefined };
    if (old.label) candidates = nodes.filter(n => n.type === old.type && n.label === old.label);
    else {
      candidates = nodes.filter(n => n.type === old.type && (old.type === 'line' ? n.start <= mapped.start && n.end >= mapped.end : n.start === mapped.start && n.end === mapped.end));
      if (candidates.length !== 1) candidates = nodes.filter(n => n.type === old.type && n.fingerprint === old.fingerprint);
    }
    if (candidates.length === 1) return { ...issue, anchor: candidates[0] };
    return { ...issue, type: 'general', originalAnchor: old, anchor: undefined };
  });
}
module.exports = { scan, anchorAt, relocate, visibleSource, lineNodes, minimizeIssues, structureAt, headings };
