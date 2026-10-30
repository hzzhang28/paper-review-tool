'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { randomUUID } = require('node:crypto');
const { ApiClient } = require('./apiClient');
const { checkPort, portError } = require('./servicePorts');

class ServiceManager {
  constructor(extensionPath, output, { WorkerClass = Worker, startupMs = 15000, shutdownMs = 5000 } = {}) {
    this.extensionPath = extensionPath; this.output = output;
    this.WorkerClass = WorkerClass; this.startupMs = startupMs; this.shutdownMs = shutdownMs;
  }
  get child() { return this.owned?.worker; } // Compatibility for project lifecycle checks.
  async ensure(root, file, options = {}) {
    if (this.stopping) await this.stopping;
    if (this.starting) {
      if (this.startingProject !== root + '\0' + file) throw Error('Another project is starting.');
      return this.starting;
    }
    this.startingProject = root + '\0' + file;
    this.starting = this.connectOrStart(root, file, options);
    try { return await this.starting; } finally { this.starting = undefined; }
  }
  serviceFile(name) {
    const packaged = path.join(this.extensionPath, 'runtime', 'server', 'src', name);
    return fs.existsSync(packaged) ? packaged : path.join(this.extensionPath, '..', 'server', 'src', name);
  }
  cleanupOwned(record) {
    // A Worker shares the host PID. Only this instance's UUID can prove ownership.
    const { safePath } = require(this.serviceFile('files.js'));
    for (const [relative, owns] of [
      ['.paper-manager/connection.json', value => value.serviceId === record.serviceId],
      ['.paper-manager/service.lock', value => value.token === record.serviceId]
    ]) {
      try {
        const target = safePath(record.root, relative);
        if (fs.existsSync(target) && owns(JSON.parse(fs.readFileSync(target, 'utf8')))) fs.unlinkSync(target);
      } catch (error) { this.output?.appendLine('Service cleanup: ' + error.message); }
    }
  }
  async connectOrStart(root, file, options) {
    const client = new ApiClient(root);
    let connected = false;
    try {
      const state = await client.request('GET', '/v1/state');
      if (state.masterFile !== file) throw Object.assign(Error('This directory already manages a different .tex file.'), { mismatch: true });
      connected = true;
    } catch (error) { if (error.mismatch) throw error; }
    if (connected) {
      await options.onPort?.((await client.connection()).port);
      return client;
    }
    if (this.owned && !this.owned.exited) throw Error('The managed service is starting or unavailable. Check Paper Review output.');
    await checkPort(options.port ?? 0);
    const serviceId = randomUUID();
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'NODE_OPTIONS'));
    const worker = new this.WorkerClass(this.serviceFile('hostWorker.js'), {
      workerData: { root, file, serviceId, port: options.port ?? 0, initialReview: options.initialReview, requireExisting: options.requireExisting },
      stdout: true, stderr: true, execArgv: [], env
    });
    const record = { worker, root, serviceId, exited: false };
    this.owned = record; this.client = client;
    record.exit = new Promise(resolve => worker.once('exit', code => {
      record.exited = true;
      try { this.cleanupOwned(record); } catch (error) { this.output?.appendLine('Service cleanup: ' + error.message); }
      if (this.owned === record) this.owned = undefined;
      if (code !== 0 && !record.expectedStop) this.output?.appendLine('Paper service Worker exited: ' + code);
      resolve(code);
    }));
    let diagnostics = '';
    for (const stream of [worker.stdout, worker.stderr].filter(Boolean)) stream.on('data', data => {
      const message = data.toString('utf8'); diagnostics = (diagnostics + message).slice(-4000); this.output?.append(message);
    });
    worker.on('error', error => this.output?.appendLine(error.message));
    try {
      const details = await new Promise((resolve, reject) => {
        const cleanup = () => { clearTimeout(timeout); worker.off('message', ready); worker.off('exit', exited); worker.off('error', failed); };
        const failed = error => { cleanup(); reject(Error('VS Code 后台服务启动失败：' + error.message)); };
        const exited = () => failed(Error('Worker exited during startup. ' + diagnostics));
        const ready = message => {
          if (message?.type === 'fatal') return failed(portError(Object.assign(Error(message.message), { code: message.code }), options.port));
          if (message?.type === 'ready' && message.serviceId === serviceId) {
            record.runtime = message.runtime;
            this.output?.appendLine('后台服务使用 VS Code Node ' + message.runtime.node + '，Worker ' + message.runtime.threadId + '。');
            cleanup(); resolve(message);
          }
        };
        const timeout = setTimeout(() => failed(Error('Service startup timed out. ' + diagnostics)), this.startupMs);
        worker.on('message', ready); worker.once('exit', exited); worker.once('error', failed);
      });
      await options.onPort?.(details.port);
      return client;
    } catch (error) {
      record.expectedStop = true;
      if (!record.exited) await worker.terminate();
      await record.exit;
      throw error;
    }
  }
  async stop() {
    if (this.stopping) return this.stopping;
    this.stopping = this.stopOwned();
    try { await this.stopping; } finally { this.stopping = undefined; }
  }
  async stopOwned() {
    if (this.starting) await this.starting.catch(() => {});
    const record = this.owned;
    if (!record || record.exited) return;
    record.expectedStop = true;
    // Shutdown goes only to our Worker, never to another window's HTTP service.
    try { record.worker.postMessage({ type: 'shutdown' }); } catch {}
    let timer;
    await Promise.race([record.exit, new Promise(resolve => { timer = setTimeout(resolve, this.shutdownMs); })]);
    clearTimeout(timer);
    if (!record.exited) await record.worker.terminate();
    await record.exit;
  }
}
module.exports = { ServiceManager };
