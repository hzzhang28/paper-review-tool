'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { describeProject, projectId } = require('./projects');
const same = (a, b) => process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
const key = root => 'paperReview.openProject.' + projectId(root, '');
class ProjectWorkspace {
  constructor(vscode, state) { this.vscode = vscode; this.state = state; }
  folders() { return this.vscode.workspace.workspaceFolders || []; }
  matches(root) { return this.folders().some(folder => folder.uri.scheme === 'file' && same(folder.uri.fsPath, root)); }
  async open(project) {
    const record = { file: project.file, initialReview: project.initialReview, at: Date.now(), nonce: randomUUID() };
    const pendingKey = key(project.root);
    await this.state.update(pendingKey, record);
    const newWindow = this.folders().length > 0 && this.vscode.workspace.getConfiguration('paperReview').get('workspace.openMode') !== 'reuseWindow';
    try {
      await this.vscode.commands.executeCommand('vscode.openFolder', this.vscode.Uri.file(project.root), { forceNewWindow: newWindow, forceReuseWindow: !newWindow });
    } catch (error) {
      if (this.state.get(pendingKey)?.nonce === record.nonce) await this.state.update(pendingKey, undefined);
      throw error;
    }
  }
  pending() {
    for (const folder of this.folders()) {
      if (folder.uri.scheme !== 'file') continue;
      const root = folder.uri.fsPath, record = this.state.get(key(root));
      if (record && Date.now() - record.at >= 0 && Date.now() - record.at < 15 * 60000 &&
        typeof record.file === 'string' && path.basename(record.file) === record.file &&
        ['approved', 'unreviewed', undefined].includes(record.initialReview)) {
        return { project: { ...describeProject(path.join(root, record.file)), initialReview: record.initialReview }, key: key(root), nonce: record.nonce };
      }
    }
    if (this.folders().length !== 1 || this.vscode.workspace.getConfiguration('paperReview').get('workspace.autoOpenProject') === false) return;
    const folder = this.folders()[0]; if (folder.uri.scheme !== 'file') return;
    const root = folder.uri.fsPath, descriptor = path.join(root, '.paper-manager/project.json');
    if (!fs.existsSync(descriptor)) return;
    for (const target of [root, path.join(root, '.paper-manager'), descriptor]) {
      if (fs.lstatSync(target).isSymbolicLink() || !same(fs.realpathSync(target), target)) throw Error('项目路径不能经过符号链接。');
    }
    const file = JSON.parse(fs.readFileSync(descriptor, 'utf8')).masterFile;
    if (typeof file !== 'string' || path.basename(file) !== file) throw Error('项目描述文件无效。');
    return { project: describeProject(path.join(root, file)) };
  }
  async complete(pending) {
    if (pending.key && this.state.get(pending.key)?.nonce === pending.nonce) await this.state.update(pending.key, undefined);
  }
}
module.exports = { ProjectWorkspace, same, key };
