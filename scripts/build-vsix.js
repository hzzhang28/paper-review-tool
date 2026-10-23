'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createVSIX } = require('@vscode/vsce');
const root = path.resolve(__dirname, '..');
const extensionRoot = path.join(root, 'extension');
const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'package.json'), 'utf8'));
const output = path.join(root, 'dist', `paper-review-tool-${manifest.paperReviewBuild || manifest.version}.vsix`);
require('./package-extension');
async function main() {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  await createVSIX({ cwd: extensionRoot, packagePath: output, dependencies: false,
    allowMissingRepository: true });
  const sha256 = createHash('sha256').update(fs.readFileSync(output)).digest('hex');
  fs.writeFileSync(output + '.sha256', `${sha256}  ${path.basename(output)}\n`, 'utf8');
  console.log(`VSIX ready: ${path.relative(root, output)}\nSHA-256: ${sha256}`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
