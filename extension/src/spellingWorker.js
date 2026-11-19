'use strict';
const { parentPort } = require('node:worker_threads');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const runtime = path.join(__dirname, '../runtime/node_modules');
const nspell = require(path.join(runtime, 'nspell'));
const { iterateWords } = require('./spellingWords');
let spell;
const ready = import(pathToFileURL(path.join(runtime, 'dictionary-en/index.js')).href).then(({ default: dictionary }) => { spell = nspell(dictionary); });
parentPort.on('message', async request => {
  try {
    await ready;
    if (request.type === 'suggest') {
      const result = request.word.length <= 40 ? spell.suggest(request.word).slice(0, 6) : [];
      parentPort.postMessage({ id: request.id, suggestions: result }); return;
    }
    const personal = new Set(request.personal.map(word => word.toLowerCase())), cache = new Map(), found = [];
    for (const item of iterateWords(request.text)) {
      if (personal.has(item.word.toLowerCase())) continue;
      if (!cache.has(item.word)) cache.set(item.word, spell.correct(item.word));
      if (!cache.get(item.word)) found.push(item);
      if (found.length >= 1000) break;
    }
    parentPort.postMessage({ id: request.id, found });
  } catch (error) { parentPort.postMessage({ id: request.id, error: error.message }); }
});
