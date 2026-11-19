'use strict';
const path = require('node:path');
const { Worker } = require('node:worker_threads');

class Spelling {
  constructor(vscode, output, WorkerClass = Worker) {
    this.vscode = vscode; this.output = output; this.WorkerClass = WorkerClass; this.requests = new Map(); this.serial = 0;
    this.diagnostics = vscode.languages.createDiagnosticCollection('Paper Spelling');
    this.actions = vscode.languages.registerCodeActionsProvider({ scheme: 'paper' }, { provideCodeActions: (document, range, context, token) => this.provideActions(document, context, token) }, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] });
  }
  enabled() { return this.vscode.workspace.getConfiguration('paperReview').get('spelling.enabled') ?? true; }
  personal() { const words = this.vscode.workspace.getConfiguration('paperReview').get('spelling.userWords'); return Array.isArray(words) ? words.filter(word => typeof word === 'string' && word.length <= 80).slice(0, 20000) : []; }
  ensureWorker() {
    if (this.worker) return;
    const worker = this.worker = new this.WorkerClass(path.join(__dirname, 'spellingWorker.js'), { execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 128 } });
    worker.on('message', message => { const pending = this.requests.get(message.id); if (pending) { this.requests.delete(message.id); message.error ? pending.reject(Error(message.error)) : pending.resolve(message); } });
    const failed = error => {
      if (this.worker === worker) this.worker = undefined;
      for (const [id, request] of this.requests) if (request.worker === worker) { request.reject(error); this.requests.delete(id); }
      if (!this.disposed) this.output?.appendLine('Spelling: ' + error.message);
    };
    worker.on('error', failed); worker.on('exit', () => failed(Error('拼写检查进程已停止。')));
  }
  request(body) {
    this.ensureWorker(); const id = ++this.serial;
    return new Promise((resolve, reject) => {
      const worker = this.worker; this.requests.set(id, { resolve, reject, worker });
      try { worker.postMessage({ ...body, id }); } catch (error) { this.requests.delete(id); reject(error); }
    });
  }
  changed(document) {
    if (document.uri.scheme !== 'paper' || document.isClosed) return;
    clearTimeout(this.timer); this.latest = document;
    this.timer = setTimeout(() => this.checkLatest(), 600);
  }
  async checkLatest() {
    if (this.disposed || this.busy || !this.latest) return;
    const document = this.latest; this.latest = undefined;
    if (!this.enabled()) { this.diagnostics.clear(); return; }
    const text = document.getText(), version = document.version;
    if (Buffer.byteLength(text, 'utf8') > 2 * 1024 * 1024) { this.diagnostics.delete(document.uri); this.output?.appendLine('Spelling: 正文超过 2 MiB，跳过自动检查。'); return; }
    this.busy = true;
    try {
      const result = await this.request({ type: 'check', text, personal: this.personal() });
      if (!this.disposed && !document.isClosed && document.version === version && this.enabled()) {
        this.diagnostics.set(document.uri, result.found.map(item => {
          const diagnostic = new this.vscode.Diagnostic(new this.vscode.Range(document.positionAt(item.start), document.positionAt(item.end)), '可能的拼写错误：' + item.word, this.vscode.DiagnosticSeverity.Information);
          diagnostic.source = 'Paper Spelling'; diagnostic.code = item.word; return diagnostic;
        }));
      }
    } catch (error) { if (!this.disposed) this.output?.appendLine('Spelling: ' + error.message); }
    finally { this.busy = false; if (this.latest) void this.checkLatest(); }
  }
  async provideActions(document, context, token) {
    const actions = [];
    for (const diagnostic of context.diagnostics.filter(d => d.source === 'Paper Spelling').slice(0, 1)) {
      const word = document.getText(diagnostic.range), version = document.version;
      if (word !== diagnostic.code || token.isCancellationRequested) continue;
      let suggestions = [];
      try { suggestions = (await this.request({ type: 'suggest', word })).suggestions; } catch { /* Personal dictionary remains available. */ }
      if (token.isCancellationRequested || document.version !== version) return [];
      for (const replacement of suggestions) {
        const action = new this.vscode.CodeAction('替换为 ' + replacement, this.vscode.CodeActionKind.QuickFix);
        action.edit = new this.vscode.WorkspaceEdit(); action.edit.replace(document.uri, diagnostic.range, replacement); action.diagnostics = [diagnostic]; actions.push(action);
      }
      const add = new this.vscode.CodeAction('加入个人字库：' + word, this.vscode.CodeActionKind.QuickFix);
      add.command = { command: 'paperReview.addSpellingWord', title: add.title, arguments: [word] }; add.diagnostics = [diagnostic]; actions.push(add);
    }
    return actions;
  }
  async add(word) {
    if (!word) {
      const editor = this.vscode.window.activeTextEditor, range = editor?.document.getWordRangeAtPosition(editor.selection.active);
      word = range && editor.document.getText(range);
    }
    if (!/^[A-Za-z]+(?:['’][A-Za-z]+)*$/.test(word || '') || word.length > 80) throw Error('请选择一个英文单词。');
    await this.vscode.workspace.getConfiguration('paperReview').update('spelling.userWords', [...new Set([...this.personal(), word])].sort(), this.vscode.ConfigurationTarget.Global);
    this.reset();
  }
  reset() {
    this.diagnostics.clear();
    for (const editor of this.vscode.window.visibleTextEditors) this.changed(editor.document);
    if (!this.enabled()) { void this.worker?.terminate(); this.worker = undefined; }
  }
  closed(document) {
    this.diagnostics.delete(document.uri); if (this.latest === document) this.latest = undefined;
    if (document.uri.scheme === 'paper' && !this.vscode.workspace.textDocuments.some(doc => doc.uri.scheme === 'paper' && !doc.isClosed)) {
      clearTimeout(this.timer); void this.worker?.terminate(); this.worker = undefined;
    }
  }
  dispose() { this.disposed = true; clearTimeout(this.timer); this.diagnostics.dispose(); this.actions.dispose(); void this.worker?.terminate(); this.worker = undefined; }
}
module.exports = { Spelling };
