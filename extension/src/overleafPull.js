'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { remotePath } = require('./overleafFiles');

function protectedPath(relative) {
  const parts = relative.toLowerCase().split('/');
  return parts.includes('.git') || parts.includes('.paper-manager') || parts.some(part => /^\.paper-reset\.(?:json|lock)$/.test(part));
}
function destination(root, relative) {
  remotePath(relative);
  let at = path.resolve(root);
  if (!fs.lstatSync(at).isDirectory() || fs.lstatSync(at).isSymbolicLink() || fs.realpathSync(at).toLowerCase() !== at.toLowerCase()) throw Error('下载目录不能经过符号链接或目录联接。');
  for (const part of relative.split('/')) {
    if (process.platform === 'win32' && (/[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) || /[<>"|?*]/.test(part))) throw Error('远端路径不能用作本地文件名。');
    at = path.join(at, part);
    try { if (fs.lstatSync(at).isSymbolicLink()) throw Error('下载目标不能经过符号链接或目录联接。'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return at;
}
function pullTargets(source, mappings, scope) {
  remotePath(source);
  if (scope === 'all') return [source];
  if (scope !== 'mapped' || !Array.isArray(mappings) || !mappings.length) throw Error('请先设置需要拉取的文件或文件夹映射。');
  const targets = [];
  for (const rule of mappings) {
    if (!['file', 'folder'].includes(rule.kind)) throw Error('无效的文件映射规则。');
    remotePath(rule.source, rule.kind === 'folder'); remotePath(rule.target, rule.kind === 'folder');
    if (rule.kind === 'file' && rule.target === source) targets.push(rule.source);
    else if (rule.kind === 'folder' && (!rule.target || source.startsWith(rule.target + '/'))) {
      const suffix = rule.target ? source.slice(rule.target.length + 1) : source;
      targets.push(rule.source ? rule.source + '/' + suffix : suffix);
    }
  }
  return [...new Set(targets)];
}
function planPull(root, files, mappings, scope) {
  const targets = new Map(); let skipped = 0;
  for (const file of files) for (const target of pullTargets(file.source, mappings, scope)) {
    if (protectedPath(target)) { skipped++; continue; }
    const absolute = destination(root, target), key = process.platform === 'win32' ? absolute.toLowerCase() : absolute;
    const previous = targets.get(key);
    if (previous && previous.source !== file.source) throw Error('多个远端文件映射到了同一个本地文件。');
    if (fs.existsSync(absolute) && !fs.lstatSync(absolute).isFile()) throw Error('下载文件与本地目录冲突。');
    targets.set(key, { ...file, target, absolute });
  }
  for (const key of targets.keys()) {
    let parent = path.dirname(key);
    while (parent !== path.dirname(parent)) { if (targets.has(parent)) throw Error('下载文件与目录路径重叠。'); parent = path.dirname(parent); }
  }
  return { files: [...targets.values()], skipped };
}
async function applyPull(root, plan, masterFile, importMaster, stage = () => {}) {
  const master = masterFile ? destination(root, masterFile) : undefined;
  const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  const manuscript = plan.files.find(file => master && same(file.absolute, master));
  if (manuscript && !importMaster) throw Error('论文服务未连接，无法交接远端正文。');
  // Validate every destination before writing. Existing regular files are
  // overwritten unconditionally; content hashes/mtime are never compared.
  for (const file of plan.files) destination(root, file.target);
  let written = 0;
  for (const file of plan.files) {
    if (file === manuscript) continue;
    const absolute = destination(root, file.target);
    await fs.promises.mkdir(path.dirname(absolute), { recursive: true });
    destination(root, file.target);
    await fs.promises.copyFile(file.staged, absolute); written++;
    if (written % 50 === 0) stage('已写入 ' + written + ' 个本地文件…');
  }
  const submission = manuscript ? await importMaster(manuscript.staged) : undefined;
  return { count: plan.files.length, written, skipped: plan.skipped, submission };
}
module.exports = { protectedPath, destination, pullTargets, planPull, applyPull };
