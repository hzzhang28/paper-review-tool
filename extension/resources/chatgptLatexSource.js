// Built-in adaptation of the user-provided LaTeX source-mode script.
// Registered and executed by the ChatGPT button; manual DevTools copy is a fallback.
(function latexSourceOnly() {
  'use strict';
  // Adapted from the user's ChatGPT LaTeX Source Only 2.3.0 userscript.
  if (!['chatgpt.com', 'chat.openai.com'].includes(location.hostname)) {
    throw new Error('此脚本只用于 ChatGPT 网页，请打开该网页自身的 DevTools。');
  }
  const installed = Symbol.for('paper-review.chatgpt-latex-source-only');
  if (window[installed]) return;
  window[installed] = true;

  const BLOCK = '[data-code-block="true"]';
  const SOURCE = '[data-code-block-source="true"]';
  const PREVIEW = '[data-code-block-preview="true"]';
  const CONTROLS = '[data-code-block-controls="true"]';
  const HEADER = '[data-markdown-copy="exclude"]';
  const MARKER = 'data-tm-latex-source-only';
  const TOGGLE_MARKER = 'data-tm-latex-preview-toggle';
  const STYLE_ID = 'tm-latex-source-only-style';
  const RELEVANT = [SOURCE, PREVIEW, CONTROLS, HEADER].join(',');
  const pending = new Set();
  const wrapAttempts = new WeakMap();
  let scheduled = false;
  const css = `
    ${BLOCK}[${MARKER}] ${PREVIEW} { display: none !important; visibility: hidden !important; }
    ${BLOCK}[${MARKER}] ${SOURCE} { display: block !important; visibility: visible !important; }
    ${BLOCK}[${MARKER}] [${TOGGLE_MARKER}] { display: none !important; }
  `;
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID; style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  }
  function isLatexBlock(block) {
    const header = block.querySelector(`:scope > ${HEADER} > div:first-child`);
    return header?.textContent?.trim().toLowerCase() === 'latex';
  }
  function syncWrapping(block, controls) {
    const wrapButton = Array.from(controls.querySelectorAll('button[aria-pressed][aria-label]')).find(button =>
      /自动换行|(?:word|line)\s*wrap|wrapping/i.test(button.getAttribute('aria-label') || ''));
    if (!wrapButton) return;
    const pressed = wrapButton.getAttribute('aria-pressed');
    if (pressed === 'true') { wrapAttempts.delete(wrapButton); return; }
    if (pressed !== 'false') return;
    const now = performance.now(), previous = wrapAttempts.get(wrapButton);
    if (previous && now - previous.time < 500) return;
    const attempts = previous ? previous.count : 0;
    if (attempts >= 3) return;
    wrapAttempts.set(wrapButton, { time: now, count: attempts + 1 });
    wrapButton.click();
    if (attempts < 2) setTimeout(() => {
      if (block.isConnected && wrapButton.isConnected && wrapButton.getAttribute('aria-pressed') === 'false') queue(block);
    }, 600);
  }
  function syncPreviewToggle(controls) {
    for (const button of controls.querySelectorAll('button')) {
      if (/源代码|预览|source|preview/i.test(button.textContent?.trim() || '') && !button.hasAttribute(TOGGLE_MARKER)) {
        button.setAttribute(TOGGLE_MARKER, 'true');
      }
    }
  }
  function updateBlock(block) {
    if (!block.isConnected || !block.matches(BLOCK)) return;
    if (!block.hasAttribute(MARKER)) {
      if (!isLatexBlock(block)) return;
      block.setAttribute(MARKER, '');
    }
    for (const source of block.querySelectorAll(SOURCE)) {
      if (source.hasAttribute('hidden')) source.removeAttribute('hidden');
      if (source.hasAttribute('inert')) source.removeAttribute('inert');
    }
    const controls = block.querySelector(CONTROLS);
    if (controls) { syncWrapping(block, controls); syncPreviewToggle(controls); }
  }
  function queue(block) {
    if (!block || !block.isConnected) return;
    pending.add(block);
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      const batch = Array.from(pending); pending.clear();
      for (const block of batch) updateBlock(block);
    });
  }
  function containsRelevantElement(node) {
    return node.nodeType === Node.ELEMENT_NODE && (node.matches(RELEVANT) || node.querySelector(RELEVANT) !== null);
  }
  function scanAddedNode(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    if (node.matches(BLOCK)) queue(node);
    node.querySelectorAll(BLOCK).forEach(queue);
  }
  function handleChildList(record) {
    const target = record.target, element = target.nodeType === Node.ELEMENT_NODE ? target : target.parentElement;
    const block = element?.closest(BLOCK);
    if (!block) { for (const node of record.addedNodes) scanAddedNode(node); return; }
    if (element === block || element.closest(`${HEADER},${CONTROLS}`)) { queue(block); return; }
    if (element.closest(`${SOURCE},${PREVIEW}`)) return;
    for (const node of [...record.addedNodes, ...record.removedNodes]) {
      if (containsRelevantElement(node)) { queue(block); return; }
    }
  }
  function handleAttribute(record) {
    const element = record.target;
    if (element.nodeType !== Node.ELEMENT_NODE) return;
    const block = element.closest(BLOCK);
    if (!block) return;
    if (record.attributeName === 'aria-pressed') {
      if (element.getAttribute('aria-pressed') === 'true') wrapAttempts.delete(element);
      if (element.closest(CONTROLS)) queue(block);
      return;
    }
    if (element === block || element.matches(RELEVANT) || element.closest(`${HEADER},${CONTROLS}`)) queue(block);
  }
  function handleCharacterData(record) {
    const parent = record.target.parentElement;
    if (!parent || !parent.closest(HEADER)) return;
    const block = parent.closest(BLOCK);
    if (block) queue(block);
  }
  function init() {
    injectStyle();
    document.querySelectorAll(BLOCK).forEach(queue);
    const observer = new MutationObserver(records => {
      for (const record of records) {
        if (record.type === 'childList') handleChildList(record);
        else if (record.type === 'attributes') handleAttribute(record);
        else if (record.type === 'characterData') handleCharacterData(record);
      }
    });
    observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: ['hidden', 'inert', 'aria-pressed', 'class', 'style', 'data-code-block', 'data-code-block-source', 'data-code-block-preview', MARKER] });
    window.addEventListener('pageshow', event => {
      if (event.persisted) { injectStyle(); document.querySelectorAll(BLOCK).forEach(queue); }
    });
  }
  if (document.documentElement) init();
  else document.addEventListener('DOMContentLoaded', init, { once: true });
})();
