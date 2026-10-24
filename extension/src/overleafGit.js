'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { remotePath } = require('./overleafFiles');

function projectUrl(value) {
  let url;
  try { url = new URL(value.trim()); } catch { throw Error('请输入 Overleaf 项目链接或 Git 地址。'); }
  if (url.protocol !== 'https:' || url.port || url.password || url.search || url.hash || (url.username && url.username !== 'git')) throw Error('请使用不含凭据的 Overleaf HTTPS 地址。');
  let id;
  if (url.hostname === 'git.overleaf.com') id = /^\/([A-Za-z0-9_-]+)\/?$/.exec(url.pathname)?.[1];
  else if (['overleaf.com', 'www.overleaf.com'].includes(url.hostname) && !url.username) id = /^\/project\/([A-Za-z0-9_-]+)\/?$/.exec(url.pathname)?.[1];
  if (!id) throw Error('请输入 Overleaf 项目链接或 git.overleaf.com 项目地址。');
  return 'https://git.overleaf.com/' + id;
}
function loadGit() {
  const packaged = path.join(__dirname, '..', 'runtime', 'node_modules', 'isomorphic-git');
  return require(fs.existsSync(packaged) ? packaged : 'isomorphic-git');
}
function httpClient(url, fetcher = fetch, timeout = 120000, log = () => {}) {
  const base = new URL(url);
  return { async request(request) {
    const target = new URL(request.url);
    if (target.origin !== base.origin || ![base.pathname + '/info/refs', base.pathname + '/git-upload-pack', base.pathname + '/git-receive-pack'].includes(target.pathname) || target.username || target.password) throw Error('Unexpected Git endpoint.');
    const signal = request.signal ? AbortSignal.any([request.signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
    const method = request.method || 'GET', endpoint = target.pathname.slice(base.pathname.length);
    const started = Date.now();
    log('HTTP ' + method + ' git.overleaf.com/[project]' + endpoint);
    const response = await fetcher(target.href, {
      method: request.method || 'GET', headers: request.headers, redirect: 'error', signal,
      ...(request.body ? { body: Readable.from(request.body), duplex: 'half' } : {})
    });
    log('HTTP ' + response.status + ' ' + method + ' ' + endpoint + ' (' + (Date.now() - started) + ' ms)' +
      (response.headers.get('content-type') ? ' | ' + response.headers.get('content-type') : ''));
    return { url: target.href, method: request.method || 'GET', headers: Object.fromEntries(response.headers), statusCode: response.status, statusMessage: response.statusText, body: response.body || undefined };
  } };
}
async function overlayTree(git, options, original, files) {
  const changes = new Map();
  for (const file of files) {
    const target = remotePath(file.target), parts = target.split('/');
    let map = changes;
    for (const part of parts.slice(0, -1)) {
      if (map.has(part) && !(map.get(part) instanceof Map)) throw Error('文件与目录映射重叠。');
      if (!map.has(part)) map.set(part, new Map());
      map = map.get(part);
    }
    const name = parts.at(-1);
    if (map.has(name)) throw Error('文件与目录映射重叠。');
    map.set(name, file.data);
  }
  const write = async (oid, changes) => {
    const entries = new Map((oid ? (await git.readTree({ ...options, oid })).tree : []).map(entry => [entry.path, entry]));
    for (const [name, value] of changes) {
      const previous = entries.get(name);
      if (value instanceof Map) {
        if (previous && previous.type !== 'tree') throw Error('目标目录在 Overleaf 中是文件，请修改映射。');
        entries.set(name, { path: name, type: 'tree', mode: '040000', oid: await write(previous?.oid, value) });
      } else {
        if (previous && (previous.type !== 'blob' || previous.mode === '120000')) throw Error('目标文件与 Overleaf 中已有目录或链接冲突，请修改映射。');
        entries.set(name, { path: name, type: 'blob', mode: previous?.mode || '100644', oid: await git.writeBlob({ ...options, blob: value }) });
      }
    }
    return git.writeTree({ ...options, tree: [...entries.values()] });
  };
  return write(original, changes);
}
async function pushFiles({ url, token, cache, files, stage = () => {}, git = loadGit(), http, log = () => {} }) {
  url = projectUrl(url);
  const options = { fs, gitdir: path.join(cache, 'git') };
  await git.init({ ...options, bare: true, defaultBranch: 'master' });
  await git.addRemote({ ...options, remote: 'origin', url });
  const transport = { ...options, http: http || httpClient(url, fetch, 120000, log), url,
    onAuth: () => { log('收到 Git 认证请求，使用安全存储中的 Token。'); return { username: 'git', password: token }; },
    onAuthFailure: () => { log('Git 认证被拒绝。'); return { cancel: true }; } };
  stage('正在准备远端基准…');
  const fetched = await git.fetch({ ...transport, ref: 'master', singleBranch: true, tags: false });
  if (!fetched.fetchHead) throw Error('无法读取 Overleaf 主线。');
  const head = fetched.fetchHead, previous = (await git.readCommit({ ...options, oid: head })).commit;
  stage('正在准备选定文件…');
  const tree = await overlayTree(git, options, previous.tree, files);
  if (tree === previous.tree) return { changed: false, count: files.length };
  const identity = { name: 'Paper Review Tool', email: 'paper-review@localhost', timestamp: Math.floor(Date.now() / 1000), timezoneOffset: 0 };
  const commit = await git.writeCommit({ ...options, commit: { tree, parent: [head], author: identity, committer: identity, message: 'Update selected files\n' } });
  await git.writeRef({ ...options, ref: 'refs/heads/master', value: commit });
  stage('正在推送到 Overleaf…');
  const result = await git.push({ ...transport, ref: 'master', remoteRef: 'master', force: false });
  if (!result.ok || Object.values(result.refs || {}).some(ref => !ref.ok)) throw Error('Overleaf 拒绝了本次推送。');
  return { changed: true, count: files.length };
}
module.exports = { projectUrl, loadGit, httpClient, overlayTree, pushFiles };
