'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Worker } = require('node:worker_threads');
const { projectUrl } = require('./overleafGit');
const { projectPath, remotePath } = require('./overleafFiles');
const TOKEN_KEY = 'paperReview.overleaf.token';

class OverleafUi {
  constructor(vscode, context, getProject, { WorkerClass = Worker } = {}) {
    this.vscode = vscode; this.context = context; this.getProject = getProject; this.WorkerClass = WorkerClass;
  }
  enabled() { return this.vscode.workspace.getConfiguration('paperReview').get('overleaf.enabled') === true; }
  refresh() { return this.vscode.commands.executeCommand('setContext', 'paperReview.overleafEnabled', this.enabled()); }
  project() {
    const project = this.getProject();
    if (!project) throw Error('请先打开论文项目。');
    return { ...project, key: 'overleaf.' + createHash('sha256').update(path.resolve(project.root)).digest('hex') };
  }
  async credentials() {
    const token = await this.vscode.window.showInputBox({ title: 'Overleaf Git Token', prompt: '输入 Overleaf 账户中生成的 Git Token，保存到 VS Code 安全存储。', password: true, ignoreFocusOut: true });
    if (token === undefined) return false;
    if (!token.trim() || /[\r\n\x00]/.test(token)) throw Error('Token 不能为空或包含换行。');
    await this.context.secrets.store(TOKEN_KEY, token.trim());
    return true;
  }
  async forgetCredentials() {
    await this.context.secrets.delete(TOKEN_KEY);
    void this.vscode.window.showInformationMessage('已删除 Overleaf Git Token。');
  }
  async configure() {
    if (this.running || this.configuring) throw Error('正在处理 Overleaf 操作，请完成后再修改配置。');
    this.configuring = true;
    let action;
    try { action = await this.configureProject(); } finally { this.configuring = false; }
    if (action === 'push') return this.push();
  }
  async configureProject() {
    const project = this.project();
    const config = structuredClone(this.context.workspaceState.get(project.key) || { url: '', mappings: [] });
    const save = () => this.context.workspaceState.update(project.key, config);
    while (true) {
      const enabled = this.enabled();
      const choice = await this.vscode.window.showQuickPick([
        ...(config.url && config.mappings.length ? [{ label: '$(cloud-upload) 推送到 Overleaf', description: '上传已保存的选定文件', action: 'push' }] : []),
        { label: enabled ? '保存并关闭' : '完成配置并启用', action: 'done' },
        { label: '项目地址', description: config.url || '尚未设置', action: 'url' },
        { label: '添加文件', detail: '选择本地文件，指定远端完整文件路径。', action: 'file' },
        { label: '添加文件夹', detail: '选择本地文件夹，指定远端目录；每次推送重新扫描。', action: 'folder' },
        { label: '保存 / 更换 Git Token', action: 'token' },
        { label: '删除 Git Token', action: 'forget' },
        ...(enabled ? [{ label: '关闭 Overleaf 推送', description: '保留项目地址和映射规则', action: 'disable' }] : []),
        ...config.mappings.map((rule, index) => ({ label: (rule.kind === 'folder' ? '文件夹：' : '文件：') + (rule.source || './'), description: '→ ' + (rule.target || '/'), action: 'rule', index }))
      ], { title: 'Overleaf', placeHolder: '项目地址、文件 / 文件夹映射与推送；点击已有规则修改或删除', ignoreFocusOut: true });
      if (!choice) return;
      if (choice.action === 'done' || choice.action === 'push') {
        if (!config.url || !config.mappings.length) { void this.vscode.window.showInformationMessage('请先设置项目地址并添加推送范围。'); continue; }
        config.url = projectUrl(config.url);
        await save();
        await this.vscode.workspace.getConfiguration('paperReview').update('overleaf.enabled', true, this.vscode.ConfigurationTarget.Workspace);
        await this.refresh();
        return choice.action === 'push' ? 'push' : undefined;
      }
      if (choice.action === 'disable') {
        await this.vscode.workspace.getConfiguration('paperReview').update('overleaf.enabled', false, this.vscode.ConfigurationTarget.Workspace);
        await this.refresh();
        return;
      }
      if (choice.action === 'url') {
        const value = await this.vscode.window.showInputBox({ title: 'Overleaf 项目地址', value: config.url, prompt: '项目网页链接或 HTTPS Git 地址（不含 Token）', validateInput: value => { try { projectUrl(value); } catch (error) { return error.message; } } });
        if (value !== undefined) { config.url = projectUrl(value); await save(); }
      } else if (choice.action === 'token') await this.credentials();
      else if (choice.action === 'forget') await this.forgetCredentials();
      else if (choice.action === 'rule') {
        const rule = config.mappings[choice.index];
        const edit = await this.vscode.window.showQuickPick([{ label: '修改远端路径', action: 'edit' }, { label: '删除规则', action: 'delete' }], { title: rule.source || './' });
        if (edit?.action === 'delete') config.mappings.splice(choice.index, 1);
        else if (edit?.action === 'edit') {
          const target = await this.target(rule.target, rule.kind);
          if (target !== undefined) rule.target = target;
        }
        await save();
      } else {
        const kind = choice.action;
        const selected = await this.vscode.window.showOpenDialog({ title: kind === 'folder' ? '选择推送文件夹' : '选择推送文件', defaultUri: this.vscode.Uri.file(project.root), canSelectFiles: kind === 'file', canSelectFolders: kind === 'folder', canSelectMany: kind === 'file', openLabel: '选择' });
        for (const resource of selected || []) {
          if (resource.scheme !== 'file') throw Error('请选择本地项目内的文件。');
          const relative = path.relative(project.root, resource.fsPath).split(path.sep).join('/');
          projectPath(project.root, relative);
          const target = await this.target(relative, kind);
          if (target === undefined) break;
          config.mappings.push({ kind, source: relative, target }); await save();
        }
      }
    }
  }
  target(value, kind) {
    return this.vscode.window.showInputBox({ title: kind === 'folder' ? '远端文件夹路径' : '远端文件路径', value,
      prompt: kind === 'folder' ? '相对于 Overleaf 项目根目录；留空表示根目录' : '相对于 Overleaf 项目根目录，包含文件名',
      validateInput: value => { try { remotePath(value, kind === 'folder'); } catch (error) { return error.message; } } });
  }
  async push() {
    if (this.disposed) throw Error('扩展正在关闭，请重新打开后重试。');
    if (!this.enabled()) throw Error('请先启用并配置 Overleaf 推送。');
    if (this.running) throw Error('正在推送，请等待完成。');
    if (this.configuring) throw Error('请先完成 Overleaf 配置。');
    const project = this.project(), config = this.context.workspaceState.get(project.key);
    if (!config?.mappings?.length) throw Error('请先运行“Paper: Overleaf 配置”。');
    const url = projectUrl(config.url);
    this.running = true;
    let cache, token;
    try {
      token = await this.context.secrets.get(TOKEN_KEY);
      if (!token) { if (!await this.credentials()) return; token = await this.context.secrets.get(TOKEN_KEY); }
      if (this.disposed) return;
      const storage = path.join(this.context.globalStorageUri.fsPath, 'overleaf');
      fs.mkdirSync(storage, { recursive: true });
      cache = fs.mkdtempSync(path.join(storage, 'push-'));
      const result = await this.vscode.window.withProgress({ location: this.vscode.ProgressLocation.Window, title: 'Overleaf 推送', cancellable: false }, progress => new Promise((resolve, reject) => {
        const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'NODE_OPTIONS'));
        const worker = new this.WorkerClass(path.join(__dirname, 'overleafWorker.js'), {
          workerData: { root: project.root, url, mappings: config.mappings, token, cache }, execArgv: [], env, stdout: true, stderr: true
        });
        this.worker = worker;
        // Never forward raw dependency diagnostics, which might contain HTTP request data.
        worker.stdout?.resume(); worker.stderr?.resume();
        let result, failure;
        worker.on('message', message => {
          if (message.stage) progress.report({ message: message.stage });
          if (message.result) result = message.result;
          if (message.error) failure = message.error;
        });
        worker.on('error', () => { failure = 'Overleaf 后台任务启动失败。'; });
        worker.once('exit', code => {
          this.worker = undefined;
          if (failure || code !== 0 || !result) reject(Error(failure || 'Overleaf 推送中断，请重试。'));
          else resolve(result);
        });
      }));
      void this.vscode.window.showInformationMessage(result.changed ? 'Overleaf 推送完成。' : '所选文件与 Overleaf 一致，无需推送。');
      return result;
    } finally {
      token = undefined; this.running = false;
      if (cache) {
        const storage = path.resolve(this.context.globalStorageUri.fsPath, 'overleaf');
        if (path.dirname(path.resolve(cache)) === storage && path.basename(cache).startsWith('push-')) fs.rmSync(cache, { recursive: true, force: true });
      }
    }
  }
  dispose() { this.disposed = true; if (this.worker) void this.worker.terminate(); }
}
module.exports = { OverleafUi, TOKEN_KEY };
