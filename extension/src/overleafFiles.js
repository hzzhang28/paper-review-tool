'use strict';
const fs = require('node:fs');
const path = require('node:path');

function remotePath(value, allowRoot = false) {
  if (typeof value !== 'string' || /[\\\x00-\x1f\x7f:]/.test(value) || value.startsWith('/')) throw Error('远端路径必须是项目内的相对路径。');
  const parts = value.split('/');
  if ((value === '' && allowRoot)) return '';
  if (parts.some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) throw Error('远端路径不能包含空目录、.. 或 .git。');
  return parts.join('/');
}
function projectPath(root, relative) {
  remotePath(relative, true);
  if (fs.lstatSync(root).isSymbolicLink()) throw Error('推送范围不能包含符号链接或目录联接。');
  if (relative === '') return fs.realpathSync(root);
  const target = path.resolve(root, ...relative.split('/'));
  const resolvedRoot = fs.realpathSync(root);
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) throw Error('推送范围不能包含符号链接或目录联接。');
  }
  const real = fs.realpathSync(target), rel = path.relative(resolvedRoot, real);
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw Error('文件必须位于当前项目内。');
  return target;
}
function excluded(relative) {
  // epstopdf's explicitly marked derivatives are build output, not source figures.
  if (/(?:^|[\/_.-])eps-converted-to\.pdf$/i.test(relative)) return true;
  const parts = relative.toLowerCase().split('/');
  if (parts.includes('.git')) return true;
  const at = parts.indexOf('.paper-manager');
  if (at < 0) return false;
  const tail = parts.slice(at + 1).join('/');
  return /^(?:connection\.json|service\.lock|state\.db-(?:wal|shm|journal))$/.test(tail) ||
    tail.startsWith('build/') || /(?:\.lock|\.tmp)$/.test(tail);
}
function listFiles(root, mappings) {
  if (!Array.isArray(mappings) || !mappings.length) throw Error('请先选择需要推送的文件或文件夹。');
  const files = new Map();
  const add = (source, target) => {
    if (excluded(source)) return;
    remotePath(target);
    const previous = files.get(target);
    if (previous && previous.source !== source) throw Error('多个本地文件映射到了同一个远端路径。');
    files.set(target, { source, target });
  };
  for (const rule of mappings) {
    if (!['file', 'folder'].includes(rule.kind)) throw Error('无效的推送规则。');
    const source = projectPath(root, rule.source), stat = fs.lstatSync(source);
    if (rule.kind === 'file') {
      if (!stat.isFile()) throw Error('所选文件已不存在或已改变类型，请修改推送规则。');
      add(rule.source, remotePath(rule.target));
    } else {
      if (!stat.isDirectory()) throw Error('所选文件夹已不存在或已改变类型，请修改推送规则。');
      const target = remotePath(rule.target, true);
      const walk = (directory, suffix) => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
          const next = suffix ? suffix + '/' + entry.name : entry.name;
          const relative = rule.source ? rule.source + '/' + next : next;
          if (excluded(relative)) continue;
          const absolute = projectPath(root, relative), item = fs.lstatSync(absolute);
          if (item.isDirectory()) walk(absolute, next);
          else if (item.isFile()) add(relative, target ? target + '/' + next : next);
          else throw Error('推送范围中存在不支持的文件类型。');
        }
      };
      walk(source, '');
    }
  }
  for (const target of files.keys()) {
    const parts = target.split('/');
    while (parts.length > 1) {
      parts.pop();
      if (files.has(parts.join('/'))) throw Error('远端文件路径与目录路径重叠，请修改推送规则。');
    }
  }
  return [...files.values()];
}
async function snapshotFiles(root, mappings, cache) {
  let listed = listFiles(root, mappings);
  const overrides = new Map();
  // Capture SQLite through its online backup API; raw WAL/connection files are never copied.
  if (listed.some(file => file.source.startsWith('.paper-manager/')) && fs.existsSync(path.join(root, '.paper-manager', 'state.db'))) {
    const { DatabaseSync, backup } = require('node:sqlite');
    const database = projectPath(root, '.paper-manager/state.db');
    const destination = path.join(cache, 'snapshot.db');
    let state;
    for (let attempt = 0; attempt < 5; attempt++) {
      const source = new DatabaseSync(database, { readOnly: true });
      try { await backup(source, destination); } finally { source.close(); }
      const copy = new DatabaseSync(destination, { readOnly: true });
      try {
        if (!copy.prepare('SELECT 1 FROM pending LIMIT 1').get()) state = JSON.parse(copy.prepare('SELECT json FROM state WHERE id = 1').get().json);
      } finally { copy.close(); }
      if (state) break;
      if (attempt < 4) await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!state) throw Error('项目正在写入或恢复，请稍后重试推送。');
    // A commit can add immutable blobs while the first enumeration is in progress.
    // Enumerate again after the database snapshot so all of its referenced blobs exist in the upload.
    listed = listFiles(root, mappings);
    const text = hash => {
      if (!/^[a-f0-9]{64}$/.test(hash)) throw Error('项目快照无效。');
      const bytes = fs.readFileSync(projectPath(root, '.paper-manager/recovery/blobs/' + hash + '.txt'));
      if (require('node:crypto').createHash('sha256').update(bytes).digest('hex') !== hash) throw Error('项目快照无效。');
      return bytes.toString('utf8');
    };
    overrides.set('.paper-manager/state.db', fs.readFileSync(destination));
    const selected = new Set(listed.map(file => file.source));
    if (selected.has(state.masterFile)) overrides.set(state.masterFile, Buffer.from(text(state.master.hash).replace(/\n/g, state.eol), 'utf8'));
    if (selected.has('.paper-manager/human/draft.tex')) overrides.set('.paper-manager/human/draft.tex', Buffer.from(text(state.human.draftHash), 'utf8'));
  }
  return listed.map(file => ({ target: file.target, data: overrides.get(file.source) ?? fs.readFileSync(projectPath(root, file.source)) }));
}
module.exports = { remotePath, projectPath, excluded, listFiles, snapshotFiles };
