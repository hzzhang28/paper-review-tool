'use strict';
const vscode = require('vscode');

class VirtualFs {
  constructor() {
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeFile = this.emitter.event;
  }
  connect(client, uri) { this.client = client; this.uri = uri; this.version = undefined; this.blocked = false; }
  disconnect() { this.client = undefined; this.uri = undefined; this.version = undefined; this.blocked = false; this.pendingPull = undefined; }
  async ready(uri) {
    if (!this.client && this.resolve) {
      this.resolving ||= Promise.resolve().then(() => this.resolve(uri)).finally(() => { this.resolving = undefined; });
      await this.resolving;
    }
    if (uri.path === '/' && this.client && uri.authority === this.uri?.authority) return;
    this.validate(uri);
  }
  validate(uri) {
    if (!this.client || uri.toString() !== this.uri.toString()) throw vscode.FileSystemError.FileNotFound(uri);
  }
  async stat(uri) {
    await this.ready(uri);
    if (uri.path === '/' && uri.authority === this.uri?.authority) return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
    this.validate(uri);
    const file = await this.client.request('GET', '/v1/human/file');
    return { type: vscode.FileType.File, ctime: 0, mtime: file.mtime, size: Buffer.byteLength(file.text, 'utf8') };
  }
  async readFile(uri) {
    await this.ready(uri); this.validate(uri);
    if (this.blocked) throw vscode.FileSystemError.Unavailable('为保留编辑器修改，已暂停 Human Draft 同步。请另存后重新打开。');
    const file = await this.client.request('GET', '/v1/human/file');
    this.version = file.version;
    return Buffer.from(file.text, 'utf8');
  }
  async writeFile(uri, content) {
    await this.ready(uri); this.validate(uri);
    if (this.blocked) throw vscode.FileSystemError.Unavailable('请先另存 Human Draft，再关闭并重新打开。');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(content).replace(/\r\n/g, '\n');
    if (this.pendingPull) {
      if (text !== this.pendingPull.text) throw vscode.FileSystemError.Unavailable('同步时 Human Draft 已变化，已保留编辑器内容。');
      this.version = this.pendingPull.draftVersion;
      this.pendingPull = undefined;
      return; // Pull already persisted precisely this snapshot.
    }
    if (this.busy || this.version === undefined) throw vscode.FileSystemError.Unavailable('正在处理项目操作，请稍后重试。');
    const saved = await this.client.request('PUT', '/v1/human/file', { text, expectedDraftVersion: this.version });
    this.version = saved.draftVersion;
    this.onSaved?.();
  }
  async readDirectory(uri) {
    await this.ready(uri);
    if (uri.path !== '/' || uri.authority !== this.uri?.authority) throw vscode.FileSystemError.FileNotFound(uri);
    return [[this.uri.path.slice(1), vscode.FileType.File]];
  }
  watch() { return new vscode.Disposable(() => {}); }
  refresh() { this.emitter.fire([{ type: vscode.FileChangeType.Changed, uri: this.uri }]); }
  createDirectory() { throw vscode.FileSystemError.NoPermissions('仅支持受管理的单个文件。'); }
  delete() { throw vscode.FileSystemError.NoPermissions('仅支持受管理的单个文件。'); }
  rename() { throw vscode.FileSystemError.NoPermissions('仅支持受管理的单个文件。'); }
  dispose() { this.emitter.dispose(); }
}
module.exports = { VirtualFs };
