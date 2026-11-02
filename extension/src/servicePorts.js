'use strict';
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { createHash, randomUUID } = require('node:crypto');
const same = (a, b) => {
  const normalize = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(a) === normalize(b);
};
const fixedPort = value => Number.isInteger(value) && value > 10000 && value < 49152;
const modeOf = value => value === 'project' || value === 'manual' ? 'project' : 'random';

function projectPortOptions(vscode, root) {
  const config = vscode.workspace.getConfiguration('paperReview', vscode.Uri.file(root));
  // Use VS Code's effective value, including the User settings opened by our UI.
  return { portPolicy: { mode: modeOf(config.get('service.portMode')), port: config.get('service.port') ?? 0 } };
}
function portError(error, port) {
  if (error.code === 'EADDRINUSE') return Error(`项目服务端口 ${port} 已被占用，请重新打开项目。`);
  if (error.code === 'EACCES') return Error(`项目服务端口 ${port} 不可用（无监听权限）。`);
  return error;
}
async function available(port) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', error => error.code === 'EADDRINUSE' ? resolve(false) : reject(portError(error, port)));
    probe.listen({ port, host: '127.0.0.1', exclusive: true }, () => probe.close(error => error ? reject(error) : resolve(true)));
  });
}
async function checkPort(port) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error('无效的项目服务端口。');
  if (port && !await available(port)) throw portError({ code: 'EADDRINUSE' }, port);
}
async function readRecords(file) {
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await fs.promises.readFile(file)));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('顶层必须是 JSON 对象。');
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw Error('无法读取项目端口记录：' + error.message);
  }
}
async function writeRecords(file, value) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    await fs.promises.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await fs.promises.rename(temporary, file);
  } finally { await fs.promises.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
class ServicePorts {
  constructor(directory, { output, notify = () => {}, read = readRecords, write = writeRecords, probe = available } = {}) {
    Object.assign(this, { file: path.join(directory, 'project-ports.json'), output, notify, read, write, probe });
  }
  match(records, root) {
    const folder = path.basename(root);
    const fold = value => process.platform === 'win32' ? value.toLowerCase() : value;
    const keys = Object.keys(records).filter(key => fold(key) === fold(folder));
    if (keys.length > 1) throw Error('端口记录含有重复的项目文件夹名，请手工修正。');
    const key = keys[0] ?? folder, entry = Object.hasOwn(records, key) ? records[key] : undefined;
    if (entry && typeof entry.root === 'string' && path.isAbsolute(entry.root) && !same(entry.root, root)) {
      throw Error(`存在同名但根路径不同的项目“${folder}”，请重命名项目文件夹或手工修正端口记录。`);
    }
    return { key, entry: entry && typeof entry.root === 'string' && path.isAbsolute(entry.root) && same(entry.root, root) ? entry : undefined };
  }
  async save(records) {
    try { await this.write(this.file, records); }
    catch (error) { this.output?.appendLine('端口记录写入失败，服务照常启动：' + error.message); }
  }
  async prepare(root, policy = { mode: 'random', port: 0 }) {
    // One read and one project match for each actual startup; no registry cache.
    const records = await this.read(this.file), { key, entry } = this.match(records, root);
    this.output?.appendLine('项目端口记录：' + this.file);
    const mode = entry?.mode === 'project' ? 'project' : modeOf(policy.mode);
    if (mode === 'random') return { port: 0 };
    const remembered = entry?.port;
    const preferred = fixedPort(remembered) ? remembered : fixedPort(policy.port) ? policy.port : undefined;
    const reserved = new Set(Object.entries(records).filter(([name, value]) => name !== key && value?.mode === 'project' && typeof value.root === 'string' && path.isAbsolute(value.root) && fixedPort(value.port)).map(([, value]) => value.port));
    const checked = new Set();
    const usable = async port => {
      if (reserved.has(port) || checked.has(port)) return false;
      checked.add(port); return this.probe(port);
    };
    let port = preferred && await usable(preferred) ? preferred : 0;
    const offset = createHash('sha256').update(key).digest().readUInt32BE(0) % 10000;
    if (!port) {
      search: for (const start of [20000, 30000]) for (let step = 0; step < 10000; step++) {
        const candidate = start + (offset + step) % 10000;
        if (await usable(candidate)) { port = candidate; break search; }
      }
    }
    const changed = preferred !== undefined && port !== preferred || remembered !== undefined && remembered !== 0 && !fixedPort(remembered);
    const commit = async actual => {
      Object.defineProperty(records, key, { value: { root: path.resolve(root), mode: 'project', port: actual }, enumerable: true, configurable: true, writable: true });
      await this.save(records);
    };
    // Persist a selected fixed port before launch; OS fallback is known at ready.
    if (port) await commit(port);
    return { port, ready: async actual => {
      if (!port) await commit(actual);
      if (!port) this.notify(`项目端口段已用尽，配置已变更：本次由系统分配端口 ${actual}。`);
      else if (changed) this.notify(`项目端口配置已变更：原端口不可用或记录无效，现使用 ${actual}。请更新已复制的 Agent 地址。`);
    } };
  }
  async configure(root, policy, { portChanged = false, modeChanged = true } = {}) {
    const records = await this.read(this.file), { key, entry } = this.match(records, root);
    const mode = modeChanged ? modeOf(policy.mode) : entry?.mode === 'project' ? 'project' : modeOf(policy.mode);
    if (mode === 'random') {
      if (Object.hasOwn(records, key)) { delete records[key]; await this.save(records); }
      return;
    }
    const port = portChanged || !entry ? (fixedPort(policy.port) ? policy.port : 0) : entry.port;
    Object.defineProperty(records, key, { value: { root: path.resolve(root), mode: 'project', port }, enumerable: true, configurable: true, writable: true });
    await this.save(records);
  }
}
module.exports = { ServicePorts, projectPortOptions, checkPort, portError };
