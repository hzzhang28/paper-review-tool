'use strict';
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const PENDING_OPEN_KEY = 'paperReview.pendingOpen';
const PENDING_OPEN_TTL_MS = 15 * 60 * 1000;
const OPEN_MODES = new Set(['newWindow', 'reuseWindow', 'never']);

function samePath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || !left || !right) return false;
  const a = path.resolve(left), b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function workspaceFolders(vscode) { return vscode.workspace.workspaceFolders || []; }

function workspaceMatches(vscode, root) {
  const folders = workspaceFolders(vscode);
  return folders.length === 1 && samePath(folders[0]?.uri?.fsPath, root);
}

function projectWorkspaceAction(vscode, root, { mode = 'newWindow' } = {}) {
  const folders = workspaceFolders(vscode);
  if (folders.length === 1 && samePath(folders[0]?.uri?.fsPath, root)) return { action: 'current', switch: false };
  const selected = OPEN_MODES.has(mode) ? mode : 'newWindow';
  if (selected === 'never') return { action: 'current', switch: false };
  if (selected === 'newWindow' && folders.length > 0) return { action: 'delegate', switch: false };
  return { action: 'current', switch: true };
}

async function switchProjectWorkspace(vscode, root) {
  const folders = workspaceFolders(vscode);
  const updated = await vscode.workspace.updateWorkspaceFolders(0, folders.length, {
    uri: vscode.Uri.file(root), name: path.basename(root)
  });
  if (updated === false) throw new Error('无法将 VS Code 工作区切换为论文目录。');
  return true;
}

function buildPendingOpen(project, { now = Date.now(), nonce = randomUUID() } = {}) {
  return {
    version: 1, root: project.root, file: project.file,
    initialReview: project.initialReview, createdAt: now, nonce
  };
}

async function delegateProjectWorkspace(vscode, root, pending, { globalState, onLog } = {}) {
  if (!globalState) return false;
  try { await globalState.update(PENDING_OPEN_KEY, pending); }
  catch (error) { onLog?.('无法记录待打开项目：' + error.message); return false; }
  try {
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(root), { forceNewWindow: true, forceReuseWindow: false });
    return true;
  } catch (error) {
    onLog?.('无法在新窗口打开论文目录：' + error.message);
    try { await globalState.update(PENDING_OPEN_KEY, undefined); } catch {}
    return false;
  }
}

// Reads but does not consume: the caller clears the record only after trust and project checks.
function pendingOpenForWindow(state, folders, { now = Date.now(), ttl = PENDING_OPEN_TTL_MS } = {}) {
  const pending = state?.get(PENDING_OPEN_KEY);
  if (!pending || typeof pending !== 'object') return undefined;
  if (typeof pending.root !== 'string' || typeof pending.file !== 'string' || !pending.file.endsWith('.tex')) return undefined;
  if (!Number.isFinite(pending.createdAt) || now - pending.createdAt > ttl) return { expired: true };
  if (!Array.isArray(folders) || folders.length !== 1) return undefined;
  if (!samePath(folders[0]?.uri?.fsPath, pending.root)) return undefined;
  return pending;
}

async function clearPendingOpen(state) {
  if (!state) return;
  await state.update(PENDING_OPEN_KEY, undefined);
}

module.exports = {
  PENDING_OPEN_KEY, PENDING_OPEN_TTL_MS, OPEN_MODES,
  samePath, workspaceMatches, projectWorkspaceAction, switchProjectWorkspace,
  buildPendingOpen, delegateProjectWorkspace, pendingOpenForWindow, clearPendingOpen
};
