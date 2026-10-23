'use strict';
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { safePath, atomicWrite } = require('./files');

function snapshot(root, selected, message, transactionId) {
  if (!Array.isArray(selected) || !selected.length || selected.some(file => typeof file !== 'string')) throw new Error('Select explicit project files.');
  for (const file of selected) {
    safePath(root, file);
    if (file.split(/[\\/]/).some(part => part === '.paper-manager' || part === '.git')) throw new Error('Private state cannot be committed.');
    if (!fs.statSync(safePath(root, file)).isFile()) throw new Error('Select individual files, not directories.');
  }
  const run = (args, optional = false) => {
    const result = spawnSync('git', ['-c', 'core.hooksPath=.paper-manager/no-hooks', '-c', 'commit.gpgsign=false', '--literal-pathspecs', ...args],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 20000,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
    if (result.status !== 0 && !optional) throw new Error(result.stderr?.trim() || result.error?.message || 'Git command failed.');
    return result;
  };
  if (run(['rev-parse', '--show-prefix']).stdout.trim()) throw new Error('The paper directory must be the Git repository root.');
  const marker = `Paper-Transaction: ${transactionId}`;
  const last = run(['log', '-1', '--format=%B'], true);
  if (last.status === 0 && last.stdout.split(/\r?\n/).includes(marker)) return { commit: run(['rev-parse', 'HEAD']).stdout.trim(), replayed: true };
  // Native --only preserves other paths' staging. Refuse selected staged paths
  // rather than consume a user's separately staged version of the same file.
  const staged = run(['diff', '--cached', '--name-only', '-z', '--', ...selected]);
  if (staged.stdout) throw new Error('A selected file already has staged changes. Preserve or commit that staging before Save Version.');
  const untracked = selected.filter(file => run(['ls-files', '--error-unmatch', '--', file], true).status !== 0);
  const temporary = `.paper-manager/recovery/git-message-${randomUUID()}.txt`;
  atomicWrite(safePath(root, temporary), Buffer.from(`${message.trim()}\n\n${marker}\n`, 'utf8'));
  try {
    if (untracked.length) run(['add', '--intent-to-add', '--', ...untracked]);
    run(['commit', '--only', '--allow-empty', '--file', temporary, '--', ...selected]);
  } catch (error) {
    if (untracked.length) run(['update-index', '--force-remove', '--', ...untracked]);
    throw error;
  }
  finally { fs.unlinkSync(safePath(root, temporary)); }
  return { commit: run(['rev-parse', 'HEAD']).stdout.trim() };
}
module.exports = { snapshot };
