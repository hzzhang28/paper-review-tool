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
function currentReference(refs) {
  const isBranch = ref => typeof ref === 'string' && ref.startsWith('refs/heads/') && ref.length > 'refs/heads/'.length;
  const nonzero = refs.filter(ref => /^[a-f0-9]{40}$/.test(ref.oid) && ref.oid !== '0'.repeat(40));
  const head = nonzero.find(ref => ref.ref === 'HEAD');
  const branches = nonzero.filter(ref => isBranch(ref.ref));
  const symbolic = refs.find(ref => ref.ref === 'HEAD' && isBranch(ref.target))?.target;
  if (symbolic) return { fetchRef: head ? 'HEAD' : symbolic, remoteRef: symbolic, empty: !nonzero.length };
  if (branches.length === 1) return { fetchRef: branches[0].ref, remoteRef: branches[0].ref, empty: false };
  if (head) {
    const matching = branches.filter(ref => ref.oid === head.oid);
    if (matching.length === 1) return { fetchRef: 'HEAD', remoteRef: matching[0].ref, empty: false };
    // Upload and receive advertisements need not expose identical aliases.
    // Read HEAD, then ask the receive endpoint for its actual writable name.
    if (branches.length === 0) return { fetchRef: 'HEAD', headOnly: true, empty: false };
  }
  if (!nonzero.length && refs.every(ref => ref.oid === '0'.repeat(40))) {
    const declared = refs.filter(ref => isBranch(ref.ref));
    if (declared.length <= 1) return { remoteRef: declared[0]?.ref || 'refs/heads/master', empty: true };
  }
  throw Error('Overleaf 未提供唯一的当前引用，已停止推送；请查看日志中的远端引用信息。');
}
async function remoteReferences(git, transport, forPush = false) {
  const info = await git.getRemoteInfo2({ ...transport, protocolVersion: 1, forPush });
  if (info.protocolVersion !== 1) throw Error('Overleaf 未提供受支持的 Git 引用响应，已停止推送。');
  const refs = info.refs || [];
  // An unborn HEAD can be advertised as a capability without a ref entry.
  const target = typeof info.capabilities.symref === 'string' && /^HEAD:(refs\/heads\/.+)$/.exec(info.capabilities.symref)?.[1];
  if (target && !refs.some(ref => ref.ref === 'HEAD')) refs.push({ ref: 'HEAD', target, oid: '0'.repeat(40) });
  return refs;
}
async function pushFiles({ url, token, cache, files, stage = () => {}, git = loadGit(), http, log = () => {} }) {
  url = projectUrl(url);
  const options = { fs, gitdir: path.join(cache, 'git') };
  const localRef = 'refs/heads/paper-overleaf';
  await git.init({ ...options, bare: true, defaultBranch: 'paper-overleaf' });
  await git.addRemote({ ...options, remote: 'origin', url });
  const transport = { ...options, http: http || httpClient(url, fetch, 120000, log), url,
    onAuth: () => { log('收到 Git 认证请求，使用安全存储中的 Token。'); return { username: 'git', password: token }; },
    onAuthFailure: () => { log('Git 认证被拒绝。'); return { cancel: true }; } };
  stage('正在准备远端基准…');
  const refs = await remoteReferences(git, transport);
  log('远端引用：' + (refs.slice(0, 20).map(ref => ref.ref + (ref.target ? ' → ' + ref.target : '')).join(', ') || '(empty)'));
  const current = currentReference(refs);
  if (current.headOnly) {
    const writableRefs = await remoteReferences(git, transport, true);
    log('远端写入引用：' + (writableRefs.slice(0, 20).map(ref => ref.ref + (ref.target ? ' → ' + ref.target : '')).join(', ') || '(empty)'));
    const writable = currentReference(writableRefs);
    if (!writable.remoteRef || writable.empty) throw Error('Overleaf 未提供可写的当前引用，已停止推送；请查看远端写入引用日志。');
    current.remoteRef = writable.remoteRef;
  }
  log('自动采用当前引用：' + current.remoteRef + (current.empty ? '（首次推送）' : '；读取 ' + current.fetchRef));
  let head, previous;
  if (!current.empty) {
    const fetched = await git.fetch({ ...transport, ref: current.fetchRef, remoteRef: current.fetchRef, singleBranch: true, tags: false });
    if (!fetched.fetchHead) throw Error('无法读取 Overleaf 当前快照，请重试。');
    head = fetched.fetchHead; previous = (await git.readCommit({ ...options, oid: head })).commit;
  }
  stage('正在准备选定文件…');
  const tree = await overlayTree(git, options, previous?.tree, files);
  if (tree === previous?.tree) return { changed: false, count: files.length };
  const identity = { name: 'Paper Review Tool', email: 'paper-review@localhost', timestamp: Math.floor(Date.now() / 1000), timezoneOffset: 0 };
  const commit = await git.writeCommit({ ...options, commit: { tree, parent: head ? [head] : [], author: identity, committer: identity, message: 'Update selected files\n' } });
  await git.writeRef({ ...options, ref: localRef, value: commit });
  stage('正在推送到 Overleaf…');
  const result = await git.push({ ...transport, ref: localRef, remoteRef: current.remoteRef, force: false });
  if (!result.ok || Object.values(result.refs || {}).some(ref => !ref.ok)) throw Error('Overleaf 拒绝了本次推送。');
  return { changed: true, count: files.length };
}
module.exports = { projectUrl, loadGit, httpClient, overlayTree, currentReference, pushFiles };
