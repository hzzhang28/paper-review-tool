'use strict';
const { randomUUID } = require('node:crypto');

// js-debug's per-target CDP proxy is an internal integration point. Keep all
// dependency on it here; no page data, tokens or arbitrary scripts are exposed.
function proxyUrl(proxy) {
  const host = proxy?.host;
  const loopback = new Map([['127.0.0.1', '127.0.0.1'], ['localhost', '127.0.0.1'],
    ['::1', '[::1]'], ['::', '[::1]'], ['0.0.0.0', '127.0.0.1']]);
  if (!loopback.has(host) || !Number.isInteger(proxy.port) || proxy.port < 1 || proxy.port > 65535 ||
      typeof proxy.path !== 'string' || !/^\/[a-f0-9]{40}$/i.test(proxy.path)) {
    throw new Error('浏览器调试器未提供有效的本机连接。');
  }
  return 'ws://' + loopback.get(host) + ':' + proxy.port + proxy.path;
}

function bounded(promise, ms, message) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  })]).finally(() => clearTimeout(timer));
}

class CdpClient {
  constructor(url, Socket = globalThis.WebSocket, timeout = 5000) {
    if (!Socket) throw new Error('当前 VS Code 的 Node.js 不支持 WebSocket，请更新 VS Code。');
    this.timeout = timeout; this.pending = new Map(); this.serial = 0;
    this.socket = new Socket(url);
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', () => reject(new Error('无法连接本机浏览器调试器。')), { once: true });
      this.socket.addEventListener('close', () => reject(new Error('浏览器调试连接已关闭。')), { once: true });
    });
    // A caller may close before awaiting ready.
    this.ready.catch(() => {});
    this.socket.addEventListener('message', event => {
      let reply; try { reply = JSON.parse(event.data); } catch { return; }
      const pending = this.pending.get(reply.id);
      if (!pending) return;
      this.pending.delete(reply.id);
      if (reply.error) pending.reject(new Error('浏览器脚本命令执行失败。'));
      else pending.resolve(reply.result);
    });
    const fail = () => {
      for (const pending of this.pending.values()) pending.reject(new Error('浏览器调试连接中断。'));
      this.pending.clear();
    };
    this.socket.addEventListener('error', fail);
    this.socket.addEventListener('close', fail);
  }
  async request(method, params) {
    await bounded(this.ready, this.timeout, '等待浏览器调试连接超时。');
    const id = ++this.serial;
    const response = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    try {
      this.socket.send(JSON.stringify({ id, method, params }));
      return await bounded(response, this.timeout, '等待浏览器脚本响应超时。');
    } finally { this.pending.delete(id); }
  }
  close() { this.socket.close(); }
}

class ChatScriptBridge {
  constructor(vscode, source, options = {}) {
    this.vscode = vscode; this.source = source;
    this.connect = options.connect || (url => new CdpClient(url));
    this.attachTimeout = options.attachTimeout || 30000;
    this.probeTimeout = options.probeTimeout || 8000;
    this.records = new Map(); this.owners = new Map(); this.disposed = false;
    this.expression = '(() => { if (!["chatgpt.com","chat.openai.com"].includes(location.hostname)) return false;\n' +
      source + '\nreturn true; })()';
    const debug = vscode.debug;
    this.listeners = debug ? [
      debug.onDidStartDebugSession(session => {
        const record = [...this.owners.values()].find(item => this.owns(item, session));
        if (!record) return;
        if (record.cancelled || this.disposed) { void Promise.resolve(debug.stopDebugging(session)).catch(() => {}); return; }
        record.sessions.add(session);
      }),
      debug.onDidTerminateDebugSession(session => {
        for (const record of this.records.values()) {
          record.sessions.delete(session);
          if (record.target === session) { record.target = undefined; record.installed = false; }
        }
      })
    ] : [];
  }
  owns(record, session) {
    for (let current = session; current; current = current.parentSession) {
      if (current.configuration?.__paperChatScript === record.id) return true;
    }
    return false;
  }
  async apply(tab) {
    if (this.disposed) throw new Error('网页脚本连接已关闭。');
    const debug = this.vscode.debug;
    if (!debug?.startDebugging) throw new Error('当前 VS Code 没有浏览器调试接口。');
    let record = this.records.get(tab);
    if (!record) {
      record = { id: randomUUID(), sessions: new Set(), installed: false };
      this.records.set(tab, record); this.owners.set(record.id, record);
    }
    try {
      if (!record.sessions.size) {
        record.starting = true;
        const start = Promise.resolve().then(() => debug.startDebugging(undefined, {
          type: 'editor-browser', request: 'attach', name: 'Paper ChatGPT LaTeX source',
          urlFilter: 'https://chatgpt.com/*', internalConsoleOptions: 'neverOpen',
          sourceMaps: false, __paperChatScript: record.id
        }, { suppressSaveBeforeStart: true, suppressDebugToolbar: true,
          suppressDebugStatusbar: true, suppressDebugView: true }));
        start.finally(() => { record.starting = false;
          if (record.cancelled) this.owners.delete(record.id);
          this.disposeListenersIfDone();
        }).catch(() => {});
        const started = await bounded(start, this.attachTimeout,
          '等待浏览器连接超时；如出现目标选择，请选择 ChatGPT 页面。');
        if (!started) throw new Error('浏览器连接已取消，或当前 VS Code 不支持 editor-browser 调试。');
      }
      // js-debug can create a child page session after the root adapter starts.
      // Only probe sessions created by this bridge, never activeDebugSession.
      const deadline = Date.now() + this.probeTimeout;
      let proxy;
      while (!proxy && Date.now() < deadline) {
        const candidates = record.target ? [record.target] : [...record.sessions].reverse();
        for (const session of candidates) {
          try {
            proxy = await bounded(Promise.resolve(session.customRequest('requestCDPProxy')),
              1000, '浏览器脚本接口尚未就绪。');
            proxyUrl(proxy);
            if (record.target !== session) record.installed = false;
            record.target = session; break;
          } catch { proxy = undefined; }
        }
        if (!proxy) await new Promise(resolve => setTimeout(resolve, 100));
        if (record.cancelled || this.disposed) throw new Error('网页脚本连接已关闭。');
      }
      if (!proxy) throw new Error('当前 JavaScript 调试器未提供浏览器脚本接口。');
      const client = this.connect(proxyUrl(proxy));
      try {
        if (!record.installed) {
          await client.request('Page.addScriptToEvaluateOnNewDocument', { source: this.expression });
          record.installed = true;
        }
        const result = await client.request('Runtime.evaluate', {
          expression: this.expression, returnByValue: true, awaitPromise: false
        });
        if (result?.exceptionDetails) throw new Error('LaTeX 源码模式脚本执行失败。');
        if (result?.result?.value !== true) {
          throw new Error('当前页面尚未进入 ChatGPT；登录完成后脚本将自动启用，也可以再点一次按钮。');
        }
      } finally { client.close(); }
    } catch (error) {
      // Keep a successfully registered preload during login/navigation, but
      // release failed initial attachments so retry cannot use a stale adapter.
      if (!record.installed) this.release(tab);
      throw error;
    }
  }
  release(tab) {
    const record = this.records.get(tab);
    if (!record) return;
    record.cancelled = true;
    // Keep the record until pending startDebugging settles: a late start event
    // must be stopped too. A new click gets a fresh record after deletion below.
    for (const session of record.sessions) void Promise.resolve(this.vscode.debug.stopDebugging(session)).catch(() => {});
    this.records.delete(tab);
    if (!record.starting) this.owners.delete(record.id);
  }
  dispose() {
    this.disposed = true;
    for (const tab of [...this.records.keys()]) this.release(tab);
    this.disposeListenersIfDone();
  }
  disposeListenersIfDone() {
    if (this.disposed && ![...this.owners.values()].some(record => record.starting)) {
      for (const listener of this.listeners) listener.dispose();
    }
  }
}
module.exports = { ChatScriptBridge, CdpClient, proxyUrl };
