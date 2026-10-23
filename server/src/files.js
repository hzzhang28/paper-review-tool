'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const normalize = text => text.replace(/\r\n/g, '\n');
function decode(bytes) {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}
function safePath(root, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) ||
      relative.split(/[\\/]/).some(part => !part || part === '.' || part === '..' || /[:\x00]/.test(part))) {
    throw new Error('Invalid project-relative path.');
  }
  let target = root;
  for (const part of relative.split(/[\\/]/)) {
    target = path.join(target, part);
    try { if (fs.lstatSync(target).isSymbolicLink()) throw new Error('Symlink/junction traversal rejected.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return target;
}
function atomicWrite(target, bytes) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = target + '.' + crypto.randomUUID() + '.tmp';
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(temporary, target);
    // Directory fsync is supported on POSIX; Windows rejects directory handles.
    if (process.platform !== 'win32') {
      const directory = fs.openSync(path.dirname(target), 'r');
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
module.exports = { hash, normalize, decode, safePath, atomicWrite };
