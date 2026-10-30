'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const FEED = 'https://api.github.com/repos/hzzhang28/paper-review-tool/releases/latest';
const PAGE = 'https://github.com/hzzhang28/paper-review-tool/releases/latest';
const PENDING = 'paperReview.update.pendingInstall', SKIP = 'paperReview.update.skipped', CHECKED = 'paperReview.update.checkedAt';
function build(value) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:([rt])(\d+))?$/.exec(value || '');
  if (!m) throw Error('无效构建号。');
  const parts = [+m[1], +m[2], +m[3], m[4] === 'r' ? 2 : m[4] === 't' ? 0 : 1, +(m[5] || 0)];
  if (!parts.every(Number.isSafeInteger)) throw Error('无效构建号。');
  return parts;
}
function compare(a, b) {
  const left = build(a), right = build(b);
  for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return left[i] - right[i];
  return 0;
}
function https(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) throw Error('更新地址必须使用不含凭据的 HTTPS。');
  return url.href;
}
function releaseAsset(release) {
  if (!release || release.draft || release.prerelease || !Array.isArray(release.assets)) return;
  return release.assets.flatMap(asset => {
    const match = /^paper-review-tool-(\d+\.\d+\.\d+(?:r\d+)?)\.vsix$/.exec(asset.name || '');
    if (!match || asset.state !== 'uploaded' || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 100 * 1024 * 1024) return [];
    try {
      build(match[1]);
      if (release.tag_name !== 'v' + match[1].replace(/r\d+$/, '')) return [];
      return [{ build: match[1], name: asset.name, url: https(asset.browser_download_url), size: asset.size,
        digest: /^sha256:([a-f0-9]{64})$/i.exec(asset.digest || '')?.[1].toLowerCase() }];
    } catch { return []; }
  }).sort((a, b) => compare(b.build, a.build))[0];
}
class UpdateManager {
  constructor(vscode, context, { output, idle = () => true, fetch: request = globalThis.fetch, manifest = require('../package.json'), now = Date.now } = {}) {
    Object.assign(this, { vscode, context, output, idle, fetch: request, now });
    this.build = manifest.paperReviewBuild; this.disposed = false;
  }
  config() { return this.vscode.workspace.getConfiguration('paperReview'); }
  mode() { return this.config().get('update.mode') ?? 'auto'; }
  production() { return this.context.extensionMode === this.vscode.ExtensionMode?.Production; }
  interval() { return Math.max(1, Math.min(168, Number(this.config().get('update.intervalHours')) || 24)) * 3600000; }
  log(message) { this.output?.appendLine('更新：' + message); }
  start() {
    clearTimeout(this.timer);
    if (!this.production() || this.disposed || this.mode() === 'off') return;
    const checked = this.context.globalState.get(CHECKED);
    const feed = FEED;
    const remaining = checked?.feed === feed ? checked.at + this.interval() - this.now() : 0;
    this.schedule(Math.max(20000, remaining));
  }
  schedule(delay) {
    clearTimeout(this.timer);
    if (this.disposed || this.mode() === 'off') return;
    this.timer = setTimeout(async () => {
      const result = await this.check();
      if (!this.disposed && this.mode() !== 'off') this.schedule(result === 'busy' ? 60000 : this.interval());
    }, delay);
    this.timer.unref?.();
  }
  dispose() { this.disposed = true; clearTimeout(this.timer); this.controller?.abort(); }
  check({ manual = false } = {}) {
    if (this.running) return this.running;
    if (this.disposed || !manual && this.mode() === 'off') return Promise.resolve('disabled');
    this.controller = new AbortController();
    this.running = this.run(manual).catch(async error => {
      this.log(error.message);
      if (!this.disposed && manual) await this.vscode.window.showErrorMessage('Paper 更新失败：' + error.message + ' 请查看 Paper Review 输出或从发布页手动安装。');
      return 'failed';
    }).finally(() => { this.running = undefined; this.controller = undefined; if (manual) this.start(); });
    return this.running;
  }
  async request(url, signal) {
    for (let redirects = 0; redirects < 6; redirects++) {
      const response = await this.fetch(https(url), { signal, redirect: 'manual', cache: 'no-store',
        headers: { 'User-Agent': 'paper-review-tool/' + this.build, Accept: 'application/vnd.github+json' } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get('location'); if (!location) throw Error('更新重定向缺少目标地址。');
        url = new URL(location, url).href; continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw Error(`更新服务器返回 HTTP ${response.status}。`); }
      return response;
    }
    throw Error('更新下载重定向过多。');
  }
  async run(manual) {
    if (manual && !this.idle()) { await this.vscode.window.showWarningMessage('请等待当前保存、Push 或编译完成后再检查更新。'); return 'busy'; }
    const feed = FEED;
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(15000)]);
    const response = await this.request(feed, signal), chunks = []; let size = 0;
    for await (const chunk of response.body) { size += chunk.length; if (size > 2 * 1024 * 1024) throw Error('更新信息过大。'); chunks.push(chunk); }
    const asset = releaseAsset(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    if (this.disposed || !manual && this.mode() === 'off') return 'disabled';
    if (!asset) throw Error('Release 中没有有效的安装包。');
    await this.context.globalState.update(CHECKED, { at: this.now(), feed });
    const pending = this.context.globalState.get(PENDING);
    if (pending && compare(pending, this.build) > 0 && compare(asset.build, pending) <= 0) { await this.reloadPrompt(pending); return 'pending'; }
    if (compare(asset.build, this.build) <= 0) {
      if (pending && compare(pending, this.build) <= 0) await this.context.globalState.update(PENDING, undefined);
      if (manual) await this.vscode.window.showInformationMessage('Paper Review Tool 已是最新构建（' + this.build + '）。');
      return 'current';
    }
    if (!manual && this.context.globalState.get(SKIP) === asset.build) return 'skipped';
    if (!this.production()) { if (manual) await this.vscode.window.showInformationMessage('开发模式不安装更新；可从发布页获取 ' + asset.build + '。'); return 'development'; }
    let install = !manual && this.mode() === 'auto';
    if (!install) {
      const choice = await this.vscode.window.showInformationMessage('发现 Paper Review Tool ' + asset.build + '。', '下载并安装', '发布说明', '跳过此版本');
      if (choice === '跳过此版本') { await this.context.globalState.update(SKIP, asset.build); return 'skipped'; }
      if (choice === '发布说明') await this.vscode.env.openExternal(this.vscode.Uri.parse(PAGE));
      install = choice === '下载并安装';
    }
    if (!install || this.disposed) return 'notified';
    if (!this.idle()) return 'busy';
    const installed = await this.install(asset, manual);
    return installed ? 'installed' : this.disposed || !manual && this.mode() === 'off' ? 'disabled' : 'busy';
  }
  async install(asset, manual) {
    if (!asset.digest) throw Error('Release 未提供 SHA-256，不能自动安装。');
    const directory = path.join(this.context.globalStorageUri.fsPath, 'updates');
    await fs.mkdir(directory, { recursive: true });
    const file = path.join(directory, randomUUID() + '-' + asset.name);
    let handle;
    try {
      const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(180000)]);
      const response = await this.request(asset.url, signal);
      handle = await fs.open(file, 'wx', 0o600);
      const digest = createHash('sha256'); let received = 0;
      for await (const chunk of response.body) {
        received += chunk.length;
        if (received > asset.size) throw Error('下载大小与 Release 不符。');
        digest.update(chunk); await handle.writeFile(chunk);
      }
      await handle.close(); handle = undefined;
      if (received !== asset.size || digest.digest('hex') !== asset.digest) throw Error('下载校验失败，未安装更新。');
      if (signal.aborted || this.disposed || !manual && this.mode() === 'off') return false;
      if (!this.idle()) { this.log('当前有操作正在进行，稍后再更新。'); return false; }
      await this.vscode.commands.executeCommand('workbench.extensions.installExtension', this.vscode.Uri.file(file));
      await this.context.globalState.update(PENDING, asset.build);
      this.log('已安装 ' + asset.build + '，等待重新加载窗口。');
      if (!this.disposed) await this.reloadPrompt(asset.build);
      return true;
    } finally { await handle?.close(); await fs.unlink(file).catch(error => { if (error.code !== 'ENOENT') this.log('临时安装包清理失败：' + error.message); }); }
  }
  async reloadPrompt(version) {
    const choice = await this.vscode.window.showInformationMessage('Paper Review Tool ' + version + ' 已安装，重新加载窗口后生效。', '重新加载窗口', '稍后');
    if (choice === '重新加载窗口' && !this.disposed) await this.vscode.commands.executeCommand('workbench.action.reloadWindow');
  }
}
module.exports = { UpdateManager, build, compare, releaseAsset, https, FEED, PENDING, SKIP, CHECKED };
