'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

function projectId(root, file) {
  const identity = path.resolve(root) + '\0' + file;
  return createHash('sha256').update(process.platform === 'win32' ? identity.toLowerCase() : identity).digest('hex').slice(0, 24);
}

// Inspect paths and project metadata only; the service alone reads the manuscript.
function describeProject(filePath) {
  const selected = path.resolve(filePath), root = path.dirname(selected), file = path.basename(selected);
  if (!file.endsWith('.tex')) throw new Error('Select one .tex file.');
  const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  if (!same(fs.realpathSync(root), root) || fs.lstatSync(selected).isSymbolicLink() || !fs.statSync(selected).isFile()) {
    throw new Error('Select a regular .tex file in a directory without symbolic links.');
  }
  const data = path.join(root, '.paper-manager');
  if (fs.existsSync(data) && (fs.lstatSync(data).isSymbolicLink() || !fs.statSync(data).isDirectory())) throw new Error('Invalid .paper-manager directory.');
  function exists(relative) {
    const target = path.join(data, relative);
    if (!fs.existsSync(target)) return false;
    if (fs.lstatSync(target).isSymbolicLink() || !same(fs.realpathSync(target), target)) throw new Error('Project metadata must not traverse symbolic links.');
    return fs.statSync(target).isFile();
  }
  let initialized = false;
  if (exists('project.json')) {
    const descriptor = JSON.parse(fs.readFileSync(path.join(data, 'project.json'), 'utf8'));
    if (descriptor.masterFile !== file) throw new Error(`This directory already manages ${descriptor.masterFile}. Open that file instead.`);
    initialized = true;
  } else initialized = exists('state.db') && exists('human/draft.tex'); // Upgrade a 0.2.0 project without resetting it.
  return { root, file, id: projectId(root, file), initialized };
}
module.exports = { describeProject, projectId };
