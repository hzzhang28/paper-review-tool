'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const { snapshotFiles } = require('./overleafFiles');
const { pushFiles } = require('./overleafGit');

(async () => {
  const { root, mappings, cache, url, token } = workerData;
  try {
    const files = await snapshotFiles(root, mappings, cache);
    if (!files.length) throw Error('所选范围中没有可推送的文件。');
    const result = await pushFiles({ url, token, cache, files, stage: message => parentPort.postMessage({ stage: message }) });
    parentPort.postMessage({ result });
  } catch (error) {
    // Git/HTTP errors can contain request details. Only fixed, non-sensitive messages cross this boundary.
    const code = error.code || error.name;
    const message = ['UserCanceledError', 'HttpError'].includes(code) ? 'Overleaf 认证或访问失败，请检查 Token 和项目 Git 权限。' :
      ['PushRejectedError', 'GitPushError'].includes(code) ? 'Overleaf 未接受推送，远端可能已有更新，请重试。' :
      /^(?:所选|请先选择|推送范围|文件必须|多个本地|远端文件路径|目标目录|目标文件|项目正在|项目快照|文件与目录|无效的推送规则)/.test(error.message) ? error.message :
      'Overleaf 推送失败，请检查网络、Token、项目 Git 权限和推送规则后重试。';
    parentPort.postMessage({ error: message });
  } finally {
    workerData.token = undefined;
    // The parent owns this temporary directory and removes it after Worker exit.
    parentPort.close();
  }
})().catch(() => { parentPort.postMessage({ error: 'Overleaf 推送失败。' }); parentPort.close(); });
