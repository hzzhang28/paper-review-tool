'use strict';
const { parentPort, workerData, isMainThread } = require('node:worker_threads');
if (isMainThread || !parentPort) throw Error('Emergency reset must run as a managed Worker.');
try {
  const { resume } = require('./emergencyReset');
  parentPort.postMessage({ ok: resume(workerData.root, workerData.file, workerData.resetId) });
} catch (error) { parentPort.postMessage({ error: error.message }); }
