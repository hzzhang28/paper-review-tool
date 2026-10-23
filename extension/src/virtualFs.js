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
    if (this.blocked) throw vscode.FileSystemError.Unavailable('Draft refresh paused to protect editor changes. Save a separate copy, close the draft and reopen it.');
    const file = await this.client.request('GET', '/v1/human/file');
    this.version = file.version;
    return Buffer.from(file.text, 'utf8');
  }
  async writeFile(uri, content) {
    await this.ready(uri); this.validate(uri);
    if (this.blocked) throw vscode.FileSystemError.Unavailable('Save a separate copy, close the draft and reopen it before reconciling changes.');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(content).replace(/\r\n/g, '\n');
    if (this.pendingPull) {
      if (text !== this.pendingPull.text) throw vscode.FileSystemError.Unavailable('Text changed during Pull. Your editor buffer is preserved.');
      this.version = this.pendingPull.draftVersion;
      this.pendingPull = undefined;
      return; // Pull already persisted precisely this snapshot.
    }
    if (this.busy || this.version === undefined) throw vscode.FileSystemError.Unavailable('A paper operation is in progress.');
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
  createDirectory() { throw vscode.FileSystemError.NoPermissions('Single-file provider.'); }
  delete() { throw vscode.FileSystemError.NoPermissions('Single-file provider.'); }
  rename() { throw vscode.FileSystemError.NoPermissions('Single-file provider.'); }
  dispose() { this.emitter.dispose(); }
}
module.exports = { VirtualFs };
