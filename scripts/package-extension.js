'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const target = path.join(root, 'extension', 'runtime');
function copy(source, destination) {
  const item = fs.lstatSync(source);
  if (item.isSymbolicLink()) throw new Error('Do not package symlinks.');
  if (item.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true });
    for (const name of fs.readdirSync(source)) copy(path.join(source, name), path.join(destination, name));
  } else { fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.copyFileSync(source, destination); }
}
copy(path.join(root, 'server', 'src'), path.join(target, 'server', 'src'));
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
for (const [relative, item] of Object.entries(lock.packages)) {
  if (!relative || item.dev || !relative.startsWith('node_modules/')) continue;
  copy(path.join(root, relative), path.join(target, relative));
}
console.log('Extension runtime prepared: service and production dependencies. No document compilation performed.');
