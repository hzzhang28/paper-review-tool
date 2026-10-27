'use strict';
const fs = require('node:fs');
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

// Opening a folder restarts the window, so the project is resumed from a pending record
// instead of being connected in the window that requested the switch.
function projectWorkspaceAction(vscode, root, { mode = 'newWindow' } = {}) {
  const folders = workspaceFolders(vscode);
  if (folders.length === 1 && samePath(folders[0]?.uri?.fsPath, root)) return { action: 'current', openFolder: false };
  const selected = OPEN_MODES.has(mode) ? mode : 'newWindow';
  if (selected === 'never') return { action: 'current', openFolder: false };
  if (selected === 'newWindow' && folders.length > 0) return { action: 'openFolder', newWindow: true };
  return { action: 'openFolder', newWindow: false };
}

function buildPendingOpen(project, { now = Date.now(), nonce = randomUUID() } = {}) {
  return {
    version: 1, root: project.root, file: project.file,
    initialReview: project.initialReview, createdAt: now, nonce
  };
}

async function delegateProjectWorkspace(vscode, root, pending, { globalState, newWindow = false, onLog } = {}) {
  if (!globalState) return false;
  try { await globalState.update(PENDING_OPEN_KEY, pending); }
  catch (error) { onLog?.('无法记录待打开项目：' + error.message); return false; }
  try {
    const options = newWindow ? { forceNewWindow: true, forceReuseWindow: false } : { forceNewWindow: false, forceReuseWindow: true };
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(root), options);
    return true;
  } catch (error) {
    onLog?.('无法用 VS Code 打开论文文件夹：' + error.message);
    try { await globalState.update(PENDING_OPEN_KEY, undefined); } catch {}
    return false;
  }
}

// Reads but does not consume: the caller clears the record only after the project was opened.
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

// Existing data only: a folder that already manages a manuscript reopens without a prompt.
function managedProjectInFolders(folders, { readFile = fs.readFileSync, exists = fs.existsSync } = {}) {
  if (!Array.isArray(folders) || folders.length !== 1) return undefined;
  const root = folders[0]?.uri?.fsPath;
  if (typeof root !== 'string' || !root) return undefined;
  const descriptorPath = path.join(root, '.paper-manager', 'project.json');
  let descriptor;
  try {
    if (!exists(descriptorPath)) return undefined;
    descriptor = JSON.parse(readFile(descriptorPath, 'utf8'));
  } catch { return undefined; }
  if (!descriptor || typeof descriptor.masterFile !== 'string' || !descriptor.masterFile.endsWith('.tex')) return undefined;
  if (path.basename(descriptor.masterFile) !== descriptor.masterFile) return undefined;
  if (!exists(path.join(root, descriptor.masterFile))) return undefined;
  return { root, file: descriptor.masterFile };
}

module.exports = {
  PENDING_OPEN_KEY, PENDING_OPEN_TTL_MS, OPEN_MODES,
  samePath, workspaceMatches, projectWorkspaceAction,
  buildPendingOpen, delegateProjectWorkspace, pendingOpenForWindow, clearPendingOpen, managedProjectInFolders
};
