'use strict';
const { DatabaseSync } = require('node:sqlite');
const { diffArrays } = require('diff');
const fs = require('node:fs');
const path = require('node:path');
if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node 24+ required.');
const db = new DatabaseSync(':memory:');
if (db.prepare('SELECT 1 AS ok').get().ok !== 1) throw new Error('SQLite unavailable.');
db.close();
if (!diffArrays(['base'], ['incoming'])) throw new Error('jsdiff unavailable.');
const extension = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'extension', 'package.json'), 'utf8'));
for (const target of [extension.main, 'runtime/server/src/server.js', 'runtime/server/src/hostWorker.js', 'runtime/server/src/runtimeCapabilities.js', 'runtime/node_modules/diff/package.json', 'resources/paper.svg',
  'src/codexPanel.js', 'src/targetMenus.js', 'src/configurationUi.js', 'src/compileProfiles.js', 'src/agentInstruction.js', 'src/editorGroups.js', 'src/chatWeb.js', 'src/chatScriptBridge.js', 'resources/chatgptLatexSource.js', 'src/compileManager.js', 'src/issueFs.js', 'src/reviewUi.js',
  'src/overleafUi.js', 'src/overleafWorker.js', 'src/overleafFiles.js', 'src/overleafGit.js', 'src/overleafDiagnostics.js', 'runtime/node_modules/isomorphic-git/package.json']) {
  if (!fs.statSync(path.join(__dirname, '..', 'extension', target)).isFile()) throw new Error(`Missing extension asset: ${target}`);
}
require('../extension/runtime/node_modules/isomorphic-git');
console.log(JSON.stringify({ node: process.versions.node, sqlite: 'in-memory query passed', jsdiff: 'loaded', extensionAssets: 'complete', commands: extension.contributes.commands.length }, null, 2));
