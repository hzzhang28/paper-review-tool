'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const { snapshotFiles } = require('./overleafFiles');
const { pushFiles } = require('./overleafGit');
const { redact, errorDetails, publicMessage } = require('./overleafDiagnostics');

(async () => {
  const { root, mappings, cache, url, token } = workerData;
  const context = { root, cache, url, token, extensionPath: workerData.extensionPath };
  const log = message => parentPort.postMessage({ diagnostic: redact(message, context) });
  const stage = message => parentPort.postMessage({ stage: message });
  try {
    log('Runtime: Node ' + process.versions.node + ' | ' + process.platform + ' ' + process.arch);
    stage('正在读取所选文件…');
    const files = await snapshotFiles(root, mappings, cache);
    if (!files.length) throw Error('所选范围中没有可推送的文件。');
    log('选定文件：' + files.length + '；合计 ' + files.reduce((sum, file) => sum + file.data.byteLength, 0) + ' bytes。');
    stage('正在初始化 Git…');
    const result = await pushFiles({ url, token, cache, files, stage, log });
    parentPort.postMessage({ result });
  } catch (error) {
    log(errorDetails(error, context));
    parentPort.postMessage({ error: redact(publicMessage(error), context) });
  } finally {
    workerData.token = undefined;
    // The parent owns this temporary directory and removes it after Worker exit.
    parentPort.close();
  }
})().catch(() => { parentPort.postMessage({ error: 'Overleaf 推送失败。' }); parentPort.close(); });
