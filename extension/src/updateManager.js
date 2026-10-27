'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { GitHubReleaseClient } = require('./githubRelease');
const { isNewerBuild, selectReleaseAsset, safeHttpsUrl } = require('./updateVersion');

const CACHE_KEY = 'paperReview.update.cache';
const SKIP_KEY = 'paperReview.update.skipped';
const PENDING_KEY = 'paperReview.update.pendingInstall';
const START_DELAY_MS = 20000;
const DEFAULT_REPO = 'hzzhang28/paper-review-tool';
const noopState = { get: () => undefined, update: async () => {} };

function repositoryOf(manifest) {
  const source = manifest?.repository?.url;
  const match = typeof source === 'string' ? /github\.com[/:]([^/]+)\/([^/#?]+?)(?:\.git)?(?:[#?].*)?$/i.exec(source) : undefined;
  return match ? match[1] + '/' + match[2] : DEFAULT_REPO;
}

function slimRelease(asset) {
  return {
    build: asset.build, name: asset.name, url: asset.url, size: asset.size, digest: asset.digest,
    pageUrl: asset.pageUrl, notes: asset.notes, publishedAt: asset.publishedAt, tag: asset.tag
  };
}

function formatBytes(value) {
  if (!Number.isFinite(value) || value <= 0) return '';
  return value >= 1048576 ? (value / 1048576).toFixed(1) + ' MiB' : (value / 1024).toFixed(0) + ' KiB';
}

class UpdateManager {
  constructor(vscode, context, options = {}) {
    this.vscode = vscode; this.context = context; this.options = options;
    this.output = options.output;
    this.manifest = options.manifest || require('../package.json');
    this.build = this.manifest.paperReviewBuild || this.manifest.version;
    this.repo = options.repo || repositoryOf(this.manifest);
    this.defaultFeed = `https://api.github.com/repos/${this.repo}/releases/latest`;
    this.now = options.now || Date.now;
    this.fetchImpl = options.fetch || globalThis.fetch;
    this.production = options.production ?? (typeof vscode.ExtensionMode?.Production === 'number' && context.extensionMode === vscode.ExtensionMode.Production);
    this.storageRoot = options.storageRoot || context.globalStorageUri?.fsPath || path.join(os.tmpdir(), 'paper-review-tool-updates');
    this.installGuard = options.installGuard;
    this.log = options.log || (message => this.output?.appendLine('更新：' + message));
    this.client = options.client || new GitHubReleaseClient({ fetch: this.fetchImpl, userAgent: 'paper-review-tool/' + this.build, allowLoopbackHttp: true, log: this.log });
    this.disposed = false; this.started = false; this.timer = undefined;
    this.checking = undefined; this.installing = undefined; this.controller = undefined;
  }

  config() { return this.vscode.workspace.getConfiguration('paperReview'); }
  state() { return this.context.globalState || noopState; }
  mode() { return this.config().get('update.mode') ?? 'auto'; }
  intervalHours() { const value = Number(this.config().get('update.intervalHours')); return Number.isFinite(value) && value >= 1 ? value : 24; }
  installable() { return this.production; }

  feed() {
    const value = this.config().get('update.feedUrl');
    if (!value || typeof value !== 'string' || !value.trim()) return this.defaultFeed;
    const safe = safeHttpsUrl(value.trim(), { allowLoopbackHttp: true });
    if (!safe) { this.log('自定义更新地址无效，已使用默认 GitHub API。'); return this.defaultFeed; }
    return safe;
  }

  start() {
    if (this.disposed || this.started) return;
    this.started = true;
    if (!this.production) return;
    const pending = this.state().get(PENDING_KEY);
    if (pending) void this.remindPending(pending).catch(error => this.log('检查待重载版本失败：' + error.message));
    if (this.mode() === 'off') return;
    const cache = this.state().get(CACHE_KEY);
    const checkedAt = Number(cache?.at);
    if (Number.isFinite(checkedAt) && this.now() - checkedAt < this.intervalHours() * 3600 * 1000) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.check({ manual: false }); }, this.options.startDelayMs ?? START_DELAY_MS);
    this.timer.unref?.();
  }

  dispose() {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    try { this.controller?.abort(); } catch {}
  }

  check({ manual = false } = {}) {
    if (this.checking) return this.checking;
    if (!manual && (this.disposed || this.mode() === 'off')) return Promise.resolve({ status: 'disabled' });
    this.checking = this.runCheck({ manual }).finally(() => { this.checking = undefined; });
    return this.checking;
  }

  async runCheck({ manual }) {
    const feed = this.feed();
    const cache = this.state().get(CACHE_KEY);
    const etag = !manual && cache?.feedUrl === feed ? cache.etag : undefined;
    let result;
    try {
      result = await this.client.latest({ url: feed, etag });
    } catch (error) {
      return this.failure(error, { manual, phase: 'check' });
    }
    const now = this.now();
    if (result.notModified) {
      if (cache) await this.state().update(CACHE_KEY, { ...cache, at: now });
      if (!cache?.release) return { status: 'current' };
      return this.offer(cache.release, { manual });
    }
    const asset = selectReleaseAsset(result.release);
    if (!asset) {
      this.log('Release 中没有可用的 paper-review-tool-*.vsix 资产。');
      if (manual) await this.vscode.window.showInformationMessage('最新 Release 没有可用的 VSIX 安装包。');
      return { status: 'unavailable' };
    }
    await this.state().update(CACHE_KEY, { at: now, etag: result.etag, feedUrl: feed, release: slimRelease(asset) });
    if (!asset.digest) this.log(`Release 资产 ${asset.name} 未提供 SHA-256 摘要，仅校验文件大小。`);
    return this.offer(asset, { manual });
  }

  async offer(asset, { manual }) {
    if (!isNewerBuild(asset.build, this.build)) {
      if (manual) await this.vscode.window.showInformationMessage(`Paper Review Tool 已是最新版本（${this.build}）。`);
      return { status: 'current' };
    }
    if (!manual && this.state().get(SKIP_KEY) === asset.build) return { status: 'skipped' };
    this.log(`发现新版本 ${asset.build}（当前 ${this.build}）。`);
    const auto = !manual && this.mode() === 'auto';
    if (auto && (!this.installGuard || this.installGuard())) return this.install(asset, { manual: false });
    if (auto) this.log('当前有操作进行中，改为提示安装。');
    return this.notify(asset);
  }

  async notify(asset) {
    const canInstall = this.installable();
    const actions = canInstall ? ['下载并安装', '发布说明', '跳过此版本'] : ['打开发布页', '跳过此版本'];
    const choice = await this.vscode.window.showInformationMessage(`发现新版本 ${asset.build}（当前 ${this.build}）。`, ...actions);
    if (choice === '下载并安装') return this.install(asset, { manual: true });
    if (choice === '打开发布页' || choice === '发布说明') {
      await this.openPage(asset.pageUrl);
      return { status: 'notified' };
    }
    if (choice === '跳过此版本') {
      await this.state().update(SKIP_KEY, asset.build);
      this.vscode.window.setStatusBarMessage(`已跳过 ${asset.build}；可运行“Paper: 检查更新”重新查看。`, 5000);
      return { status: 'skipped' };
    }
    return { status: 'notified' };
  }

  install(asset, { manual = false } = {}) {
    if (this.installing) return this.installing;
    if (!this.installable()) {
      this.log('开发模式不自动安装更新。');
      void this.vscode.window.showInformationMessage(`开发模式：发现新版本 ${asset.build}，请从发布页手动安装。`);
      return Promise.resolve({ status: 'development' });
    }
    if (this.installGuard && !this.installGuard()) {
      void this.vscode.window.showWarningMessage('当前有保存、Push 或编译操作进行中，请完成后再更新。');
      return Promise.resolve({ status: 'busy' });
    }
    this.installing = this.runInstall(asset, { manual }).finally(() => { this.installing = undefined; });
    return this.installing;
  }

  async runInstall(asset, { manual }) {
    const directory = path.join(this.storageRoot, 'updates', asset.build);
    const destination = path.join(directory, path.basename(asset.name));
    if (path.dirname(destination) !== path.resolve(directory) || path.basename(destination) !== asset.name) {
      return this.failure(new Error('更新文件名无效。'), { manual, phase: 'install' });
    }
    const progressOptions = {
      location: this.vscode.ProgressLocation?.Notification ?? 15,
      title: `正在更新 Paper Review Tool 至 ${asset.build}`,
      cancellable: true
    };
    const task = async (progress, token) => {
      const controller = new AbortController();
      this.controller = controller;
      const subscription = token?.onCancellationRequested?.(() => controller.abort());
      try {
        progress?.report({ message: `下载 ${asset.name}${formatBytes(asset.size) ? '（' + formatBytes(asset.size) + '）' : ''}` });
        const file = await this.client.download(asset, destination, {
          signal: controller.signal,
          onProgress: ({ received, total }) => {
            const percent = total ? Math.min(99, Math.floor(received / total * 100)) : undefined;
            progress?.report({ message: `下载 ${asset.name}${percent === undefined ? '' : ' ' + percent + '%'}` });
          }
        });
        progress?.report({ message: '安装扩展' });
        await this.installVsix(file.path);
        try { await this.state().update(PENDING_KEY, asset.build); }
        catch (error) { this.log('无法记录待重载版本：' + error.message); }
        await this.cleanupDownloads(path.dirname(directory), asset.build);
        this.log(`已安装 ${asset.build}：${file.path}`);
        return { status: 'installed', build: asset.build, path: file.path };
      } catch (error) {
        if (controller.signal.aborted) throw Object.assign(new Error('更新已取消。'), { code: 'cancelled' });
        throw error;
      } finally { subscription?.dispose?.(); this.controller = undefined; }
    };
    let result;
    try {
      result = await this.withProgress(progressOptions, task);
    } catch (error) {
      return this.failure(error, { manual, phase: 'install' });
    }
    const choice = await this.vscode.window.showInformationMessage(`新版本 ${asset.build} 已安装。重新加载窗口后生效。`, '重新加载窗口', '稍后');
    if (choice === '重新加载窗口') await this.vscode.commands.executeCommand('workbench.action.reloadWindow');
    return result;
  }

  withProgress(options, task) {
    if (typeof this.vscode.window.withProgress !== 'function') {
      return task({ report() {} }, { onCancellationRequested: () => ({ dispose() {} }) });
    }
    return this.vscode.window.withProgress(options, task);
  }

  async installVsix(vsixPath) {
    if (typeof this.options.installer === 'function') return this.options.installer(vsixPath);
    try {
      await this.vscode.commands.executeCommand('workbench.extensions.installExtension', this.vscode.Uri.file(vsixPath),
        { installGivenVersion: true, justForThisSession: false });
      return;
    } catch (error) { this.log('VS Code 安装命令失败：' + error.message); }
    if (await this.installViaCli(vsixPath)) return;
    throw new Error('无法通过 VS Code 安装更新，请手动安装已下载的 VSIX。');
  }

  async installViaCli(vsixPath) {
    const appRoot = this.vscode.env?.appRoot;
    if (!appRoot || !process.versions.electron) return false;
    const cli = path.join(appRoot, 'out', 'cli.js');
    if (!fs.existsSync(cli)) return false;
    const forwarded = [];
    for (let index = 0; index < process.argv.length; index++) {
      if (['--extensions-dir', '--user-data-dir'].includes(process.argv[index]) && process.argv[index + 1]) {
        forwarded.push(process.argv[index], process.argv[++index]);
      }
    }
    this.log('尝试通过 VS Code CLI 安装更新。');
    const result = await new Promise(resolve => {
      let output = '', settled = false, timer;
      const child = spawn(process.execPath, [cli, '--install-extension', vsixPath, '--force', ...forwarded], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', VSCODE_DEV: '' }, windowsHide: true
      });
      const finish = code => { if (settled) return; settled = true; clearTimeout(timer); resolve({ code, output }); };
      timer = setTimeout(() => { try { child.kill(); } catch {} finish(-1); }, 120000);
      timer.unref?.();
      child.stdout?.on('data', data => { output = (output + data.toString('utf8')).slice(-4000); });
      child.stderr?.on('data', data => { output = (output + data.toString('utf8')).slice(-4000); });
      child.on('error', error => { output += '\n' + error.message; finish(-1); });
      child.on('close', finish);
    });
    if (result.code !== 0) { this.log('VS Code CLI 安装失败：' + (result.output.trim() || 'exit ' + result.code)); return false; }
    return true;
  }

  async cleanupDownloads(root, keep) {
    let entries;
    try { entries = await fsp.readdir(root, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === keep) continue;
      await fsp.rm(path.join(root, entry.name), { recursive: true, force: true }).catch(() => {});
    }
  }

  async remindPending(pending) {
    if (typeof pending !== 'string' || !isNewerBuild(pending, this.build)) { await this.state().update(PENDING_KEY, undefined); return; }
    const choice = await this.vscode.window.showInformationMessage(`新版本 ${pending} 已安装。重新加载窗口后生效。`, '重新加载窗口', '稍后');
    if (choice === '重新加载窗口') await this.vscode.commands.executeCommand('workbench.action.reloadWindow');
  }

  async failure(error, { manual, phase }) {
    this.log(`${phase === 'check' ? '检查' : '安装'}失败：${error.message}`);
    if (error.code === 'cancelled') return { status: 'failed', error };
    if (!manual && error.code === 'rate-limit') return { status: 'failed', error };
    if (!manual && phase === 'check' && error.code !== 'download' && error.code !== 'digest') return { status: 'failed', error };
    const actions = error.code === 'cancelled' ? [] : ['打开发布页', '查看日志'];
    const choice = await this.vscode.window.showErrorMessage(`Paper 更新失败：${error.message}`, ...actions);
    if (choice === '打开发布页') await this.openPage('https://github.com/' + this.repo + '/releases/latest');
    if (choice === '查看日志') this.output?.show?.(true);
    return { status: 'failed', error };
  }

  async openPage(url) {
    const safe = safeHttpsUrl(url);
    if (!safe) return;
    try { await this.vscode.env.openExternal(this.vscode.Uri.parse(safe)); } catch (error) { this.log('无法打开浏览器：' + error.message); }
  }
}

module.exports = { UpdateManager, repositoryOf, CACHE_KEY, SKIP_KEY, PENDING_KEY };
