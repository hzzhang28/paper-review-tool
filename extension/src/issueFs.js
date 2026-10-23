'use strict';
const vscode = require('vscode');

function serialize(issue) { return '# ' + issue.title + '\n\n' + issue.description; }
function sameContent(text, issue) {
  try { const value = parse(text); return value.title === issue.title && value.description === issue.description; } catch { return false; }
}
function parse(text) {
  const normalized = text.replace(/\r\n/g, '\n');
  const newline = normalized.indexOf('\n');
  const heading = newline < 0 ? normalized : normalized.slice(0, newline);
  if (!/^# \S/.test(heading) || !heading.slice(2).trim()) throw new Error('第一行请保留“# 标题”，后面可自由换行编辑描述。');
  return { title: heading.slice(2).trim(), description: newline < 0 ? '' : normalized.slice(newline + 1).replace(/^\n/, '') };
}
class IssueFs {
  constructor({ getClient, write, workspaceState, onSaved }) {
    Object.assign(this, { getClient, write, workspaceState, onSaved });
    this.versions = new Map(Object.entries(workspaceState.get('issueEditorVersions') || {}));
    this.emitter = new vscode.EventEmitter(); this.onDidChangeFile = this.emitter.event;
  }
  resource(paperUri, issue) {
    return vscode.Uri.from({ scheme: 'paper-issue', authority: paperUri.authority, path: '/' + issue.id + '.md', query: 'version=' + issue.version });
  }
  id(resource) {
    const match = /^\/([a-zA-Z0-9-]+)\.md$/.exec(resource.path);
    if (resource.scheme !== 'paper-issue' || !match) throw vscode.FileSystemError.FileNotFound(resource);
    return match[1];
  }
  expected(resource) {
    const key = resource.toString();
    if (this.versions.has(key)) return this.versions.get(key);
    const raw = new URLSearchParams(resource.query).get('version'), version = Number(raw);
    if (raw === null || !Number.isSafeInteger(version) || version < 0) throw vscode.FileSystemError.Unavailable('Issue editor version is missing. Reopen from Issues.');
    return version;
  }
  async issue(resource) {
    const id = this.id(resource), client = await this.getClient(resource);
    const issue = (await client.request('GET', '/v1/issues')).find(i => i.id === id);
    if (!issue) throw vscode.FileSystemError.FileNotFound('Issue 已删除；如有未保存内容，请另存副本。');
    return issue;
  }
  async accept(issue, authority) {
    for (const doc of vscode.workspace.textDocuments.filter(doc => !doc.isClosed && doc.uri.scheme === 'paper-issue' && doc.uri.authority === authority && !doc.isDirty)) {
      if (this.id(doc.uri) === issue.id && issue.version >= this.expected(doc.uri) && sameContent(doc.getText(), issue)) this.versions.set(doc.uri.toString(), issue.version);
    }
    await this.workspaceState.update('issueEditorVersions', Object.fromEntries(this.versions));
  }
  async stat(resource) {
    if (resource.path === '/') return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
    const issue = await this.issue(resource);
    return { type: vscode.FileType.File, ctime: issue.createdAt || 0, mtime: issue.version, size: Buffer.byteLength(serialize(issue), 'utf8') };
  }
  async readFile(resource) { this.expected(resource); return Buffer.from(serialize(await this.issue(resource)), 'utf8'); }
  async writeFile(resource, bytes) {
    const body = parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), id = this.id(resource), expectedVersion = this.expected(resource);
    const result = await this.write(resource, async client => {
      const issue = (await client.request('GET', '/v1/issues')).find(i => i.id === id);
      if (!issue) throw vscode.FileSystemError.FileNotFound('Issue 已删除，编辑内容没有提交。请另存副本。');
      const state = await client.request('GET', '/v1/state');
      return client.request('POST', '/v1/issues', { ...issue, ...body, expectedVersion, expectedDraftVersion: state.draftVersion });
    });
    this.versions.set(resource.toString(), result.issue.version);
    await this.workspaceState.update('issueEditorVersions', Object.fromEntries(this.versions));
    await this.onSaved?.();
  }
  async readDirectory(resource) {
    const client = await this.getClient(resource);
    if (resource.path !== '/') throw vscode.FileSystemError.FileNotFound(resource);
    return (await client.request('GET', '/v1/issues')).map(i => [i.id + '.md', vscode.FileType.File]);
  }
  watch() { return new vscode.Disposable(() => {}); }
  createDirectory() { throw vscode.FileSystemError.NoPermissions('Use Create Issue.'); }
  rename() { throw vscode.FileSystemError.NoPermissions('Edit the title on the first line.'); }
  delete() { throw vscode.FileSystemError.NoPermissions('Use Delete Issue.'); }
  dispose() { this.emitter.dispose(); }
}
module.exports = { IssueFs, serialize, parse };
