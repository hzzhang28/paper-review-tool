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
copy(path.join(root, 'node_modules', 'diff'), path.join(target, 'node_modules', 'diff'));
console.log('Extension runtime prepared: service and jsdiff. No document compilation performed.');
