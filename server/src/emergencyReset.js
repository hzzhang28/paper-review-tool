'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { hash, safePath, atomicWrite } = require('./files');
const JOURNAL = '.paper-reset.json';
const LOCK = '.paper-reset.lock';
function assertResetAllowed(root, token) {
  const file = safePath(path.resolve(root), LOCK);
  if (!fs.existsSync(file)) return;
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Number.isSafeInteger(record.pid) || record.pid <= 0 || typeof record.token !== 'string') throw Error('Invalid emergency reset lock.');
  if (record.token === token && record.pid === process.pid) return;
  try { process.kill(record.pid, 0); } catch (error) { if (error.code === 'ESRCH') { fs.unlinkSync(file); return; } throw error; }
  throw Error('该项目正在紧急重置，其他窗口不能同时启动服务。');
}
function claim(root, token) {
  assertResetAllowed(root, token);
  const file = safePath(root, LOCK);
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ pid: process.pid, token }), { flag: 'wx', mode: 0o600 });
}
function release(root, token) {
  const file = safePath(path.resolve(root), LOCK);
  if (fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8')).token === token) fs.unlinkSync(file);
}
function validate(root, file) {
  const resolved = path.resolve(root), real = fs.realpathSync(resolved);
  if ((process.platform === 'win32' ? real.toLowerCase() !== resolved.toLowerCase() : real !== resolved) || path.basename(file) !== file || !file.endsWith('.tex')) throw Error('Invalid reset project path.');
  safePath(resolved, file); safePath(resolved, '.paper-manager'); safePath(resolved, JOURNAL);
  return resolved;
}
function assertStopped(root) {
  const lock = safePath(path.resolve(root), '.paper-manager/service.lock');
  if (!fs.existsSync(lock)) return;
  let owner;
  try { owner = JSON.parse(fs.readFileSync(lock, 'utf8')); } catch { throw Error('无法确认服务锁归属，请关闭该项目所属的 VS Code 窗口后再重试。'); }
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw Error('Invalid service lock.');
  try { process.kill(owner.pid, 0); } catch (error) { if (error.code === 'ESRCH') return; throw error; }
  throw Error('该项目仍有其他窗口的服务在运行，拒绝重置。');
}
function stage(root, file, text) {
  root = validate(root, file); assertStopped(root);
  if (typeof text !== 'string' || !text.isWellFormed() || /\r(?!\n)/.test(text)) throw Error('Expected well-formed UTF-8 editor text.');
  const resetId = randomUUID(); claim(root, resetId);
  const record = { schema: 1, file, text, checksum: hash(text), initialReview: 'unreviewed' };
  // This is the new selected text, not a backup of the old database. Keeping
  // the small intent outside the reset directory permits interrupted recovery.
  try { assertStopped(root); atomicWrite(safePath(root, JOURNAL), Buffer.from(JSON.stringify(record), 'utf8')); }
  catch (error) { release(root, resetId); throw error; }
  return { bytes: Buffer.byteLength(text, 'utf8'), resetId };
}
function resume(root, file, resetId = randomUUID()) {
  assertResetAllowed(root, resetId);
  let journal = safePath(path.resolve(root), JOURNAL);
  if (!fs.existsSync(journal)) return false;
  root = validate(root, file); journal = safePath(root, JOURNAL);
  assertStopped(root);
  const record = JSON.parse(fs.readFileSync(journal, 'utf8'));
  if (record.schema !== 1 || record.file !== file || typeof record.text !== 'string' || !record.text.isWellFormed() || record.checksum !== hash(record.text)) throw Error('紧急重置记录损坏；未改写正文。');
  claim(root, resetId);
  try {
    const manager = safePath(root, '.paper-manager');
    function inspect(directory) {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const relative = path.relative(root, path.join(directory, entry.name));
        const target = safePath(root, relative);
        if (entry.isDirectory()) inspect(target);
      }
    }
    if (fs.existsSync(manager)) inspect(manager);
    // Finish all destructive work before starting a new service. No old pending
    // transaction or conflict is ever replayed over the selected editor text.
    if (fs.existsSync(manager)) fs.rmSync(manager, { recursive: true });
    atomicWrite(safePath(root, file), Buffer.from(record.text, 'utf8'));
    const { DocumentStore } = require('./documentStore');
    const store = new DocumentStore(root, file, { initialReview: 'unreviewed', serviceId: resetId });
    try { if (store.state.master.revision !== 1) throw Error('Reset did not produce an initial revision.'); }
    finally { store.close(); }
    fs.unlinkSync(journal);
    return true;
  } finally { release(root, resetId); }
}
module.exports = { validate, assertStopped, assertResetAllowed, release, stage, resume, JOURNAL, LOCK };
