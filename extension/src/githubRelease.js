'use strict';
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { Readable } = require('node:stream');
const { safeHttpsUrl } = require('./updateVersion');

class ReleaseError extends Error {
  constructor(message, { code = 'release', status, retryAt } = {}) {
    super(message);
    this.name = 'ReleaseError';
    this.code = code;
    this.status = status;
    this.retryAt = retryAt;
  }
}

function rateLimitMessage(response) {
  const reset = Number(response.headers.get('x-ratelimit-reset'));
  const retryAt = Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000) : undefined;
  const when = retryAt ? `，可在 ${retryAt.toLocaleString()} 后重试` : '';
  return { message: 'GitHub API 请求次数受限' + when + '。', retryAt };
}

function linkAbort(controller, signal) {
  if (!signal) return () => {};
  const abort = () => controller.abort();
  if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  return () => signal.removeEventListener('abort', abort);
}

class GitHubReleaseClient {
  constructor({ fetch: fetchImpl = globalThis.fetch, userAgent = 'paper-review-tool', timeoutMs = 15000,
    downloadTimeoutMs = 300000, maxBytes = 100 * 1024 * 1024, allowLoopbackHttp = false, log } = {}) {
    this.fetch = fetchImpl;
    this.userAgent = userAgent;
    this.timeoutMs = timeoutMs;
    this.downloadTimeoutMs = downloadTimeoutMs;
    this.maxBytes = maxBytes;
    this.allowLoopbackHttp = allowLoopbackHttp;
    this.log = log || (() => {});
  }

  async latest({ url, etag, signal } = {}) {
    const target = safeHttpsUrl(url, { allowLoopbackHttp: this.allowLoopbackHttp });
    if (!target) throw new ReleaseError('更新地址必须是不含凭据的 HTTPS 地址。', { code: 'url' });
    if (typeof this.fetch !== 'function') throw new ReleaseError('当前运行环境不支持 HTTPS 请求。', { code: 'offline' });
    const controller = new AbortController();
    const unlink = linkAbort(controller, signal);
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    const headers = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': this.userAgent
    };
    if (etag) headers['If-None-Match'] = etag;
    let response;
    try {
      response = await this.fetch(target, { headers, redirect: 'follow', signal: controller.signal, cache: 'no-store' });
    } catch (error) {
      if (controller.signal.aborted) throw new ReleaseError('检查更新超时或已取消。', { code: 'timeout' });
      throw new ReleaseError('无法连接更新服务器：' + error.message, { code: 'network' });
    } finally {
      clearTimeout(timer); unlink();
    }
    if (response.status === 304) return { notModified: true, etag };
    if (response.status === 403 || response.status === 429) {
      const detail = rateLimitMessage(response);
      throw new ReleaseError(detail.message, { code: 'rate-limit', status: response.status, retryAt: detail.retryAt });
    }
    if (response.status === 404) throw new ReleaseError('没有找到可用的 Release。', { code: 'not-found', status: 404 });
    if (!response.ok) throw new ReleaseError(`更新服务器返回 HTTP ${response.status}。`, { code: 'http', status: response.status });
    let release;
    try { release = await response.json(); } catch { throw new ReleaseError('更新信息不是有效的 JSON。', { code: 'json' }); }
    if (Array.isArray(release)) release = release.find(item => item && !item.draft && !item.prerelease) || release[0];
    if (!release || typeof release !== 'object') throw new ReleaseError('更新信息为空。', { code: 'json' });
    return { notModified: false, release, etag: response.headers.get('etag') || undefined };
  }

  async download(asset, destination, { signal, onProgress } = {}) {
    const target = safeHttpsUrl(asset?.url, { allowLoopbackHttp: this.allowLoopbackHttp });
    if (!target) throw new ReleaseError('更新下载地址必须是不含凭据的 HTTPS 地址。', { code: 'url' });
    if (typeof this.fetch !== 'function') throw new ReleaseError('当前运行环境不支持 HTTPS 请求。', { code: 'offline' });
    if (!destination || typeof destination !== 'string') throw new ReleaseError('更新下载路径无效。', { code: 'path' });
    const controller = new AbortController();
    const unlink = linkAbort(controller, signal);
    const timer = setTimeout(() => controller.abort(), this.downloadTimeoutMs);
    timer.unref?.();
    const temporary = destination + '.' + randomUUID() + '.part';
    let handle;
    try {
      const response = await this.fetch(target, {
        headers: { Accept: 'application/octet-stream', 'Accept-Encoding': 'identity', 'User-Agent': this.userAgent },
        redirect: 'follow', signal: controller.signal, cache: 'no-store'
      });
      if (!response.ok) throw new ReleaseError(`下载更新失败：HTTP ${response.status}。`, { code: 'http', status: response.status });
      if (!response.body) throw new ReleaseError('下载更新失败：响应为空。', { code: 'download' });
      const expected = Number(asset.size);
      const length = Number(response.headers.get('content-length'));
      if (expected > this.maxBytes) throw new ReleaseError('更新文件超出允许的大小。', { code: 'size' });
      if (Number.isFinite(length) && length > this.maxBytes) throw new ReleaseError('更新文件超出允许的大小。', { code: 'size' });
      await fsp.mkdir(path.dirname(destination), { recursive: true });
      handle = await fsp.open(temporary, 'w');
      const hash = createHash('sha256');
      let received = 0;
      for await (const chunk of Readable.fromWeb(response.body)) {
        received += chunk.length;
        if (received > this.maxBytes) throw new ReleaseError('更新文件超出允许的大小。', { code: 'size' });
        hash.update(chunk);
        await handle.write(chunk);
        onProgress?.({ received, total: Number.isFinite(expected) && expected > 0 ? expected : undefined });
      }
      await handle.close();
      handle = undefined;
      if (Number.isFinite(length) && length >= 0 && received !== length) throw new ReleaseError('更新文件大小与响应不一致。', { code: 'size' });
      if (Number.isFinite(expected) && expected > 0 && received !== expected) throw new ReleaseError('更新文件大小与 Release 记录不一致。', { code: 'size' });
      const digest = hash.digest('hex');
      if (asset.digest && digest !== asset.digest) throw new ReleaseError('更新文件校验失败（SHA-256 不一致）。', { code: 'digest' });
      await fsp.rm(destination, { force: true });
      await fsp.rename(temporary, destination);
      return { path: destination, bytes: received, sha256: digest };
    } catch (error) {
      try { await handle?.close(); } catch {}
      await fsp.rm(temporary, { force: true }).catch(() => {});
      if (error instanceof ReleaseError) throw error;
      if (controller.signal.aborted) throw new ReleaseError('下载更新超时或已取消。', { code: 'timeout' });
      throw new ReleaseError('下载更新失败：' + error.message, { code: 'download' });
    } finally {
      clearTimeout(timer); unlink();
    }
  }
}

module.exports = { GitHubReleaseClient, ReleaseError };
