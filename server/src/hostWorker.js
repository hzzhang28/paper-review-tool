'use strict';
const { parentPort, workerData, isMainThread, threadId } = require('node:worker_threads');
if (isMainThread || !parentPort) throw Error('The service must be launched as a managed Worker.');
let app, stopping;
async function stop() {
  if (stopping) return stopping;
  stopping = (async () => {
    if (app) await app.close();
    parentPort.close();
  })();
  return stopping;
}
parentPort.on('message', message => {
  if (message?.type === 'shutdown') void stop().catch(fail);
});
parentPort.once('close', () => { void stop().catch(fail); });
function fail(error) {
  parentPort.postMessage({ type: 'fatal', message: error.message, code: error.code });
  void stop().finally(() => process.exit(1));
}
try {
  const { runtimeCapabilities } = require('./runtimeCapabilities');
  const runtime = { ...runtimeCapabilities(), threadId };
  const { startServer } = require('./server');
  app = startServer({ ...workerData, runtime, onShutdown: () => { void stop().catch(fail); },
    onReady: details => parentPort.postMessage({ type: 'ready', ...details, runtime }) });
  app.server.once('error', fail);
} catch (error) { fail(error); }
