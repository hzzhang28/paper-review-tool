'use strict';
// Syntax inspection only. Does not load source modules, run tests or start services.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
let failed = false, count = 0;
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('Symlinks are not allowed in source inspection.');
    if (['node_modules', '.git', '.npm-cache', '.work', '.paper-manager', '.vscode-test', 'dist'].includes(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(target);
    else if (/\.m?js$/.test(entry.name)) {
      const result = spawnSync('node', ['--check', path.relative(root, target)], { cwd: root, encoding: 'utf8', windowsHide: true });
      if (result.status !== 0) { console.error(result.stderr || result.error); failed = true; }
      count++;
    } else if (entry.name.endsWith('.json')) JSON.parse(fs.readFileSync(target, 'utf8'));
  }
}
walk(root);
console.log(`Syntax inspected: ${count} JavaScript files. No tests or application code executed.`);
if (failed) process.exitCode = 1;
