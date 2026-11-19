'use strict';
// Bounded, non-executing TeX scanning. Only printed prose is selected; source
// UTF-16 offsets are preserved. Unknown command arguments are conservatively hidden.
const signatures = new Map();
function signature(names, args = '', visibleOptions = false) {
  for (const name of names.split(' ')) signatures.set(name, { args: [...args], visibleOptions });
}
signature('title author date thanks address affiliation institute dedicatory keywords emph text textbf textit textsl textsc textrm textsf texttt textmd textup textnormal textsuperscript textsubscript underline uline uwave sout mbox fbox footnote footnotetext marginpar todo note IEEEauthorblockN IEEEauthorblockA', 'v');
signature('IEEEPARstart', 'vv');
signature('part chapter section subsection subsubsection paragraph subparagraph caption subcaption subfloat', 'v', true);
signature('captionof textcolor colorbox hyperlink hypertarget foreignlanguage glsdisp scalebox rotatebox raisebox parbox textforeignlanguage', 'hv');
signature('fcolorbox multicolumn multirow resizebox', 'hhv');
signature('makebox framebox makecell thead subcaptionbox hyperref', 'v');
signature('texorpdfstring', 'vh');
signature('bibitem', 'h', true);
signature('bibinfo bibfield', 'hv');
signature('item', '', true);
signature('newtheorem', 'hv');
signatures.get('newtheorem').trailingOptions = true;
signature('label ref pageref eqref autoref nameref vref Vref cref Cref crefrange Crefrange cpageref zref gls Gls glspl Glspl ac Ac acp acrshort acrlong acrfull labelcref', 'h');
signature('crefrange Crefrange', 'hh');
signature('nocite citestyle bibliographystyle IEEEauthorrefmark', 'h');
signature('citefield', 'hh');
signature('citetext', 'v');
signature('ifthenelse', 'hhh');
signature('url nolinkurl path', 'r');
signature('href', 'rv');
signature('input include includegraphics includepdf bibliography bibliographystyle documentclass usepackage RequirePackage hypersetup geometry lstset tikzset pgfkeys sisetup captionsetup graphicspath includeonly externaldocument index makeindex printindex newcounter newlength newsavebox pagestyle thispagestyle fontfamily fontseries fontshape fontencoding selectlanguage color pagecolor hspace vspace addvspace enlargethispage ensuremath num unit si', 'h');
signature('PassOptionsToPackage PassOptionsToClass setlength addtolength settowidth settoheight settodepth setcounter addtocounter fontsize colorlet setkeys SI qty numrange rule DeclareMathOperator newglossaryentry', 'hh');
signature('SIrange qtyrange definecolor providecolor newacronym', 'hhh');
signature('bf it sl sc rm sf tt bfseries mdseries itshape slshape scshape upshape rmfamily sffamily ttfamily normalfont selectfont normalcolor tiny scriptsize footnotesize small normalsize large Large LARGE huge Huge centering raggedright raggedleft noindent indent par newline linebreak pagebreak newpage clearpage cleardoublepage hfill vfill protect relax ignorespaces unskip maketitle tableofcontents listoffigures listoftables appendix today TeX LaTeX BibTeX dots ldots copyright textcopyright textemdash textendash textbackslash textasciitilde textasciicircum thepage');
const mathEnvironments = new Set('math displaymath equation equation* align align* alignat alignat* flalign flalign* eqnarray eqnarray* gather gather* multline multline* split aligned alignedat gathered array matrix pmatrix bmatrix Bmatrix vmatrix Vmatrix smallmatrix cases dcases rcases subarray subequations IEEEeqnarray IEEEeqnarray* IEEEeqnarraybox IEEEeqnarraybox*'.split(' '));
const opaqueEnvironments = new Set('verbatim verbatim* Verbatim BVerbatim LVerbatim lstlisting minted comment filecontents filecontents* tikzpicture pgfpicture pspicture asy luacode luacode* algorithmic algorithmic*'.split(' '));
const rawEnvironments = new Set('verbatim verbatim* Verbatim BVerbatim LVerbatim lstlisting minted comment filecontents filecontents* luacode luacode*'.split(' '));
const proseEnvironments = new Set('document abstract figure figure* table table* center flushleft flushright quote quotation verse itemize enumerate description algorithm algorithm* keywords IEEEkeywords'.split(' '));
const theoremEnvironments = new Set('theorem lemma proposition assumption definition remark proof corollary example claim observation problem thm lem prop ass defn rem'.split(' '));
const environmentArgs = new Map(Object.entries({ tabular: 'h', 'tabular*': 'hh', tabularx: 'hh', tabulary: 'hh', longtable: 'h', minipage: 'h', subfigure: 'h', subtable: 'h', thebibliography: 'h', list: 'vh', IEEEbiography: 'v', IEEEbiographynophoto: 'v' }));
const dimensionCommands = new Set('hskip vskip kern mkern parindent parskip textwidth textheight linewidth columnwidth baselineskip oddsidemargin evensidemargin tabcolsep arraycolsep'.split(' '));
const accents = new Set(["'", '`', '^', '"', '~', '=', '.', 'u', 'v', 'H', 'c', 'd', 'b', 'r', 'k', 't']);
const primitiveConditionals = new Set('if ifcat ifnum ifdim ifodd ifvmode ifhmode ifmmode ifinner ifvoid ifhbox ifvbox ifx ifeof iftrue iffalse ifcase ifdefined ifcsname iffontchar ifincsname ifpdf ifluatex ifxetex'.split(' '));

function* iterateWords(text) {
  const mask = new Uint8Array(text.length), macros = new Map(), customEnvironments = new Map(), cache = new Map(), inferring = new Set(), conditionals = new Set(primitiveConditionals);
  const isConditional = name => conditionals.has(name) || /^if[A-Z@]/.test(name);
  let steps = 0, documentStart, documentEnd = text.length;
  const budget = text.length * 20 + 4096;
  function control(at, end) {
    let stop = at + 1;
    while (stop < end && /[A-Za-z@:_]/.test(text[stop])) stop++;
    if (stop === at + 1) return { name: text[stop] || '', end: Math.min(end, stop + 1), symbol: true };
    const name = text.slice(at + 1, stop); return { name, end: stop + Number(text[stop] === '*') };
  }
  function comment(at, end) { const line = text.indexOf('\n', at); return line < 0 || line > end ? end : line + 1; }
  function spaces(at, end) { while (at < end) { if (/\s/.test(text[at])) at++; else if (text[at] === '%') at = comment(at, end); else break; } return at; }
  function group(at, end, raw = false, parentheses = false) {
    const close = text[at] === '{' ? '}' : text[at] === '[' ? ']' : parentheses && text[at] === '(' ? ')' : undefined; if (!close) return;
    const start = at + 1, stack = [close]; at++;
    while (at < end && stack.length && ++steps < budget) {
      const c = text[at];
      if (c === '\\') {
        const cmd = control(at, end); at = cmd.end;
        if (cmd.name === 'verb' && at < end && !/\s/.test(text[at])) { const stop = text.indexOf(text[at], at + 1), line = text.indexOf('\n', at); at = stop >= 0 && (line < 0 || stop < line) ? stop + 1 : line < 0 ? end : line; }
      } else if (c === '%' && !raw) at = comment(at, end);
      else if (c === '{') { stack.push('}'); at++; }
      else if (c === '[' && stack.at(-1) === ']') { stack.push(']'); at++; }
      else if (c === '(' && stack.at(-1) === ')') { stack.push(')'); at++; }
      else if (c === stack.at(-1)) { stack.pop(); at++; }
      else at++;
    }
    return { start, end: stack.length ? at : at - 1, next: at };
  }
  function argument(at, end, raw = false) {
    at = spaces(at, end); if (at >= end) return;
    return group(at, end, raw) || { start: at, end: text[at] === '\\' ? control(at, end).end : at + 1, next: text[at] === '\\' ? control(at, end).end : at + 1 };
  }
  function emit(start, end, mode) {
    if (mode.parameters) { for (let i = start; i + 1 < end; i++) if (text[i] === '#' && text[i - 1] !== '#' && text[i - 1] !== '\\' && /[1-9]/.test(text[i + 1])) mode.parameters.add(Number(text[i + 1])); }
    else mask.fill(mode.explicit ? 2 : 1, start, end);
  }
  function options(at, end, mode, visible = false, depth = 0) {
    while (at < end && ++steps < budget) {
      const begin = spaces(at, end); if (text[begin] !== '[') return at;
      const g = group(begin, end); if (visible) walk(g.start, g.end, { ...mode, explicit: true }, depth + 1); at = g.next;
    }
    return at;
  }
  function args(at, end, spec, mode, depth) {
    for (let i = 0; i < spec.args.length; i++) {
      const type = spec.args[i]; if (type === 's') continue;
      if (type === 'o' || type === 'O') {
        const begin = spaces(at, end); if (text[begin] !== '[') continue;
        const g = group(begin, end); if (spec.visible?.has(i + 1)) walk(g.start, g.end, { ...mode, explicit: true }, depth + 1); at = g.next; continue;
      }
      at = options(at, end, mode, i === 0 && spec.visibleOptions, depth);
      const g = argument(at, end, type === 'r'); if (!g) return end;
      if (type === 'v' || spec.visible?.has(i + 1)) walk(g.start, g.end, { ...mode, explicit: true }, depth + 1);
      at = g.next;
    }
    return !spec.args.length || spec.trailingOptions ? options(at, end, mode, !spec.args.length && spec.visibleOptions, depth) : at;
  }
  function unknown(at, end) { while (at < end && ++steps < budget) { const begin = spaces(at, end), g = group(begin, end); if (!g) return at; at = g.next; } return at; }
  function delimiter(at, end, close) {
    while (at < end && ++steps < budget) {
      if (text[at] === '%') { at = comment(at, end); continue; }
      if (text.startsWith(close, at) && !(/[A-Za-z]$/.test(close) && /[A-Za-z@:_]/.test(text[at + close.length] || ''))) return at + close.length;
      if (text[at] === '\\') { const cmd = control(at, end); if (macros.get(cmd.name)?.closeDelimiter === close) return cmd.end; }
      at = text[at] === '\\' ? control(at, end).end : at + 1;
    }
    return end;
  }
  function skipEnvironment(at, end, name, opaque = false) {
    let nesting = 1;
    while (at < end && ++steps < budget) {
      if (!opaque && text[at] === '%') { at = comment(at, end); continue; }
      if (text[at] !== '\\') { at++; continue; }
      const start = at, cmd = control(at, end); at = cmd.end; const macro = macros.get(cmd.name);
      if (macro?.closeBlock === name && --nesting === 0) return at;
      if (macro?.openBlock === name) nesting++;
      if (cmd.name !== 'begin' && cmd.name !== 'end') continue;
      const g = group(spaces(at, end), end); if (!g) continue;
      if (opaque && rawEnvironments.has(name) && cmd.name === 'end') {
        const lineStart = text.lastIndexOf('\n', start - 1) + 1, stop = text.indexOf('\n', g.next), lineEnd = stop < 0 ? end : Math.min(end, stop);
        if (text.slice(lineStart, start).trim() || text.slice(g.next, lineEnd).trim()) { at = g.next; continue; }
      }
      if (text.slice(g.start, g.end).trim() === name) { if (cmd.name === 'begin' && !opaque) nesting++; if (cmd.name === 'end' && --nesting === 0) return g.next; }
      at = g.next;
    }
    return end;
  }
  function definition(at, end, name, mode) {
    const target = argument(at, end); if (!target) return end;
    const id = text.slice(target.start, target.end).trim().replace(/^\\/, ''), env = /[Ee]nvironment$/.test(name); at = target.next;
    let spec = [];
    if (name.endsWith('DocumentCommand') || name.endsWith('DocumentEnvironment')) {
      const g = argument(at, end); if (!g) return end; at = g.next;
      const source = text.slice(g.start, g.end); let valid = true;
      for (let i = 0; i < source.length; i++) {
        const c = source[i]; if (/[\s+!]/.test(c)) continue;
        if ('mos'.includes(c)) spec.push(c);
        else if (c === 'O') { spec.push(c); const d = group(spaces(g.start + i + 1, g.end), g.end); if (!d) { valid = false; break; } i = d.next - g.start - 1; }
        else { valid = false; break; }
      }
      if (!valid) spec = null;
    } else if (/^(?:gdef|edef|xdef|def)$/.test(name)) {
      const start = at; while (at < end && text[at] !== '{' && ++steps < budget) at = text[at] === '%' ? comment(at, end) : at + 1;
      const parameters = text.slice(start, at).replace(/\s/g, ''); spec = /^(?:#[1-9])*$/.test(parameters) ? [...parameters.matchAll(/#([1-9])/g)].map(() => 'm') : null;
    } else {
      let begin = spaces(at, end);
      if (text[begin] === '[') { const g = group(begin, end), n = Number(text.slice(g.start, g.end)); spec = Number.isInteger(n) && n >= 0 && n <= 9 ? Array(n).fill('m') : null; at = g.next; }
      begin = spaces(at, end); if (text[begin] === '[') { const g = group(begin, end); if (spec?.length) spec[0] = 'O'; at = g.next; }
    }
    const body = group(spaces(at, end), end); if (!body) return at; at = body.next;
    let endBody;
    if (env) { endBody = group(spaces(at, end), end); if (endBody) at = endBody.next; }
    const provided = name === 'providecommand' || name.startsWith('ProvideDocument');
    if (!mode.parameters && !(provided && (macros.has(id) || signatures.has(id) || customEnvironments.has(id))) && (macros.size + customEnvironments.size < 512 || macros.has(id) || customEnvironments.has(id))) {
      const raw = text.slice(body.start, body.end).trim(), open = /\\begin\s*\{([^{}]+)\}/.exec(raw), close = /^\\end\s*\{([^{}]+)\}$/.exec(raw);
      const block = value => value && (mathEnvironments.has(value) || opaqueEnvironments.has(value)) ? value : undefined;
      const entry = { args: spec, body, endBody, openBlock: open && !raw.includes('\\end{' + open[1] + '}') ? block(open[1]) : undefined, closeBlock: close ? block(close[1]) : undefined };
      if (raw === '\\(' || raw === '\\[' || raw === '$' || raw === '$$') entry.openDelimiter = raw === '\\(' ? '\\)' : raw === '\\[' ? '\\]' : raw;
      if (raw === '\\)' || raw === '\\]' || raw === '$' || raw === '$$') entry.closeDelimiter = raw;
      (env ? customEnvironments : macros).set(id, entry); cache.clear();
    }
    return at;
  }
  function inferred(entry, depth) {
    if (!entry.body) return entry;
    if (!entry.args || depth > 24 || inferring.has(entry)) return { args: entry.args || [] };
    if (cache.has(entry)) return cache.get(entry);
    inferring.add(entry); const visible = new Set(); walk(entry.body.start, entry.body.end, { parameters: visible }, depth + 1);
    if (entry.endBody) walk(entry.endBody.start, entry.endBody.end, { parameters: visible }, depth + 1);
    inferring.delete(entry);
    const spec = { args: entry.args, visible }; cache.set(entry, spec); return spec;
  }
  function conditional(at, end, choice, mode, depth) {
    const start = at; let alternate, alternateEnd, nesting = 1;
    while (at < end && ++steps < budget) {
      if (text[at] === '%') { at = comment(at, end); continue; }
      if (text[at] !== '\\') { at++; continue; }
      const before = at, cmd = control(at, end); at = cmd.end;
      if (isConditional(cmd.name)) nesting++;
      else if (cmd.name === 'fi' && --nesting === 0) { if (choice === true) walk(start, alternate ?? before, mode, depth + 1); if (choice === false && alternateEnd !== undefined) walk(alternateEnd, before, mode, depth + 1); return at; }
      else if (cmd.name === 'else' && nesting === 1) { alternate = before; alternateEnd = at; }
    }
    return end;
  }
  function walk(at, end, mode = {}, depth = 0) {
    if (depth > 40) return;
    while (at < end && ++steps < budget) {
      const c = text[at];
      if (c === '%') { at = comment(at, end); continue; }
      if (c === '$') { const tag = text[at + 1] === '$' ? '$$' : '$'; at = delimiter(at + tag.length, end, tag); continue; }
      if (c === '{') { const g = group(at, end); walk(g.start, g.end, mode, depth + 1); at = g.next; continue; }
      if (c !== '\\') { const start = at++; while (at < end && !'\\%${}'.includes(text[at])) at++; emit(start, at, mode); continue; }
      const cmd = control(at, end), name = cmd.name, start = at; at = cmd.end;
      if (name === '(' || name === '[') { at = delimiter(at, end, name === '(' ? '\\)' : '\\]'); continue; }
      if (name === 'verb' || name === 'lstinline' || name === 'mintinline') {
        at = options(at, end, mode); if (name === 'mintinline') at = argument(at, end)?.next ?? end;
        if (text[at] === '{' && name !== 'verb') at = group(at, end).next;
        else { const line = text.indexOf('\n', at), close = text.indexOf(text[at], at + 1); at = close >= 0 && (line < 0 || close < line) ? close + 1 : line < 0 ? end : line; } continue;
      }
      if (name === 'begin' || name === 'end') {
        const g = group(spaces(at, end), end); if (!g) continue;
        const env = text.slice(g.start, g.end).trim(); at = g.next;
        if (name === 'end') { if (env === 'document') { if (!mode.parameters) documentEnd = start; return; } continue; }
        if (env === 'document' && !mode.parameters) documentStart ??= at;
        if (mathEnvironments.has(env) || opaqueEnvironments.has(env)) { at = skipEnvironment(at, end, env, opaqueEnvironments.has(env)); continue; }
        const custom = customEnvironments.get(env);
        if (custom?.openBlock || custom?.openDelimiter) at = skipEnvironment(at, end, env, opaqueEnvironments.has(custom.openBlock));
        else if (custom) at = custom.args ? args(at, end, inferred(custom, depth), mode, depth) : unknown(at, end);
        else if (environmentArgs.has(env)) at = args(at, end, { args: [...environmentArgs.get(env)] }, mode, depth);
        else if (theoremEnvironments.has(env)) at = options(at, end, mode, true, depth);
        else if (proseEnvironments.has(env)) at = options(at, end, mode);
        else at = unknown(at, end);
        continue;
      }
      if (/^(?:newcommand|renewcommand|providecommand|DeclareRobustCommand|def|gdef|edef|xdef|newenvironment|renewenvironment|(?:New|Renew|Provide|Declare)Document(?:Command|Environment))$/.test(name)) { at = definition(at, end, name, mode); continue; }
      if (name === 'newtheorem' && !mode.parameters) { const g = argument(at, end); if (g) customEnvironments.set(text.slice(g.start, g.end), { args: [], visibleOptions: true }); }
      if (name === 'let') { const left = argument(at, end); at = spaces(left?.next ?? end, end); if (text[at] === '=') at = spaces(at + 1, end); const right = argument(at, end); at = right?.next ?? end; if (!mode.parameters && left && right) { const a = text.slice(left.start, left.end).replace(/^\\/, ''), b = text.slice(right.start, right.end).replace(/^\\/, ''); if (signatures.has(b)) macros.set(a, { ...signatures.get(b) }); else if (macros.has(b)) macros.set(a, macros.get(b)); } continue; }
      if (name === 'newif') { const g = argument(at, end); if (g && !mode.parameters) conditionals.add(text.slice(g.start, g.end).replace(/^\\/, '')); at = g?.next ?? end; continue; }
      if (isConditional(name)) { at = conditional(at, end, name === 'iftrue' ? true : name === 'iffalse' ? false : undefined, mode, depth); continue; }
      if (name === 'ExplSyntaxOn' || name === 'makeatletter' || name === 'csname') { at = delimiter(at, end, '\\' + (name === 'ExplSyntaxOn' ? 'ExplSyntaxOff' : name === 'makeatletter' ? 'makeatother' : 'endcsname')); continue; }
      if (accents.has(name)) { if (!mode.parameters) { let left = start; while (left > 0 && /[\p{L}\p{M}]/u.test(text[left - 1])) mask[--left] = 0; } at = argument(at, end)?.next ?? end; while (at < end && /[\p{L}\p{M}]/u.test(text[at])) at++; continue; }
      const macro = macros.get(name);
      if (macro?.openBlock) { at = skipEnvironment(at, end, macro.openBlock, opaqueEnvironments.has(macro.openBlock)); continue; }
      if (macro?.openDelimiter) { at = delimiter(at, end, macro.openDelimiter); continue; }
      if (macro) { at = macro.body ? macro.args ? args(at, end, inferred(macro, depth), mode, depth) : unknown(at, end) : args(at, end, macro, mode, depth); continue; }
      const spec = signatures.get(name); if (spec) { at = args(at, end, spec, mode, depth); continue; }
      if (/^(?:[Cc]ites|textcites|parencites|autocites|footcites|smartcites|supercites)$/.test(name)) {
        while (text[spaces(at, end)] === '(' && ++steps < budget) { const g = group(spaces(at, end), end, false, true); walk(g.start, g.end, { ...mode, explicit: true }, depth + 1); at = g.next; }
        while (at < end && ++steps < budget) { at = options(at, end, mode, true, depth); const g = group(spaces(at, end), end); if (!g) break; at = g.next; }
        continue;
      }
      if (/^(?:[Cc]ite[A-Za-z]*|textcite|parencite|autocite|footcite|fullcite|footfullcite|smartcite|supercite)$/.test(name)) { at = args(at, end, { args: ['h'], visibleOptions: true }, mode, depth); continue; }
      if (dimensionCommands.has(name)) { const found = /^\s*=?\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)\s*(?:true\s*)?(?:pt|pc|in|bp|cm|mm|dd|cc|sp|em|ex|mu)(?:\s+(?:plus|minus)\s+[+-]?(?:\d+(?:\.\d*)?|\.\d+)\s*(?:pt|pc|in|bp|cm|mm|dd|cc|sp|em|ex|mu))*/.exec(text.slice(at, end)); if (found) at += found[0].length; continue; }
      if (!cmd.symbol) at = unknown(at, end);
      else if (name === '\\') at = options(at, end, mode);
    }
  }
  walk(0, text.length);
  if (documentStart !== undefined) for (let i = 0; i < documentStart; i++) if (mask[i] !== 2) mask[i] = 0;
  for (const match of text.slice(0, documentEnd).matchAll(/[\p{L}\p{M}\p{N}_]+(?:['’][\p{L}\p{M}]+)*/gu)) {
    const word = match[0], start = match.index, end = start + word.length;
    if (word.length < 3 || word.length > 40 || !/^[A-Za-z]+(?:['’][A-Za-z]+)*$/.test(word) || /^[A-Z]+$/.test(word) || /[a-z][A-Z]/.test(word)) continue;
    let visible = true; for (let i = start; i < end; i++) if (!mask[i]) { visible = false; break; }
    if (visible) yield { word, start, end };
  }
}
function words(text) { return Array.from(iterateWords(text)); }
module.exports = { words, iterateWords };
