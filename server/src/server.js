#!/usr/bin/env node
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const { randomBytes, randomUUID, timingSafeEqual } = require('node:crypto');
const { DocumentStore, StoreError } = require('./documentStore');
const { hash, safePath, atomicWrite } = require('./files');
const gitAdapter = require('./gitAdapter');

function startServer({ root, file, port = 0, onShutdown, initialReview, requireExisting, serviceId = randomUUID(), runtime, onReady }) {
  const store = new DocumentStore(root, file, { initialReview, requireExisting, serviceId });
  const token = randomBytes(32).toString('hex');
  const discovery = safePath(store.root, '.paper-manager/connection.json');
  let queue = Promise.resolve(), processingPending = false, stopping = false;
  function schedulePending() {
    if (processingPending || stopping || store.state.activeConflict || store.state.conflicts.some(c => c.status === 'open') || !store.state.pendingSubmissions.length) return;
    processingPending = true;
    setImmediate(() => {
      if (stopping) { processingPending = false; return; }
      const process = async () => {
        let more = false;
        try {
          const result = store.transaction(randomUUID(), hash('process-pending'), (next, files) => store.processNextSubmission(next, files));
          more = result.processed && result.ok !== false;
        } catch (error) { console.error('Pending submission retained:', error); }
        finally { processingPending = false; }
        if (more) schedulePending();
      };
      queue = queue.then(process, process);
    });
  }
  const server = http.createServer((request, response) => {
    const run = async () => {
      let aiPush = false;
      try {
        const url = new URL(request.url, 'http://127.0.0.1');
        const route = request.method + ' ' + url.pathname;
        const aiPull = route === 'POST /v1/ai/pull', publicPush = route === 'POST /v1/ai/push';
        // Only the two path-based AI endpoints are tokenless. No browser Origin or CORS.
        if (request.headers.origin) throw new StoreError('Browser requests are not allowed.', 403);
        if (!aiPull && !publicPush) {
          const actual = Buffer.from(request.headers.authorization || '');
          const expected = Buffer.from('Bearer ' + token);
          if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new StoreError('Unauthorized.', 401);
        }
        aiPush = publicPush;
        let result;
        if (route === 'GET /v1/state') result = { ...store.stateView(), runtime };
        else if (route === 'GET /v1/human/view') result = { ...store.humanFile(), reviews: store.state.human.reviews, issues: store.state.human.issues };
        else if (route === 'GET /v1/human/file') result = store.humanFile();
        else if (route === 'GET /v1/revisions') result = store.state.revisions;
        else if (route === 'GET /v1/conflicts') result = store.state.conflicts;
        else if (route === 'GET /v1/reviews') result = url.searchParams.get('scope') === 'master' ? store.state.reviews : store.state.human.reviews;
        else if (route === 'GET /v1/issues') result = url.searchParams.get('scope') === 'master' ? store.state.issues : store.state.human.issues;
        else if (route === 'GET /v1/events') result = store.state.changeEvents;
        else if (/^GET \/v1\/revisions\/\d+$/.test(route)) {
          const revision = Number(url.pathname.split('/').at(-1));
          const selected = store.state.revisions.find(r => r.revision === revision);
          if (!selected) throw new StoreError('Unknown Revision.', 404);
          result = { revision, text: store.text(selected.hash) };
        }
        else {
          const actions = {
            'PUT /v1/human/file': (next, files, body) => store.saveDraft(next, files, body),
            'POST /v1/human/push': (next, files, body) => store.humanPush(next, files, body),
            'POST /v1/human/pull': (next, files, body) => store.humanPull(next, files, body),
            'POST /v1/human/update': (next, files, body) => store.humanUpdate(next, files, body),
            'POST /v1/human/merge-update': (next, files, body) => store.humanMergeUpdate(next, files, body),
            'POST /v1/ai/clone': (next, files) => store.cloneAI(next, files),
            'POST /v1/ai/pull': (next, files) => store.cloneAI(next, files),
            'POST /v1/ai/push': (next, files, body) => store.pushAIFile(next, files, body),
            'POST /v1/reviews': (next, files, body) => store.reviewAction(next, files, body),
            'POST /v1/issues': (next, files, body) => store.editIssue(next, files, body),
            'POST /v1/snapshot': (next, files, body) => {
              if (body.expectedMasterRevision !== next.master.revision) throw new StoreError('Master Revision changed.');
              if (typeof body.message !== 'string' || !body.message.trim()) throw new StoreError('A version message is required.', 400);
              const saved = gitAdapter.snapshot(store.root, body.files || [next.masterFile], body.message, request.headers['x-transaction-id']);
              return { ok: true, ...saved, masterRevision: next.master.revision };
            }
          };
          const sessionMatch = /^POST \/v1\/ai\/([a-f0-9-]{36})\/push$/.exec(route);
          const conflictMatch = /^POST \/v1\/conflicts\/([a-f0-9-]{36})\/(prepare|resolve)$/.exec(route);
          const restoreMatch = /^POST \/v1\/revisions\/(\d+)\/restore$/.exec(route);
          const action = actions[route] || (sessionMatch && ((next, files) => store.pushAI(next, files, sessionMatch[1]))) ||
            (conflictMatch && ((next, files, body) => conflictMatch[2] === 'prepare' ? store.prepareConflict(next, files, conflictMatch[1]) : store.resolveConflict(next, files, conflictMatch[1], body))) ||
            (restoreMatch && ((next, files, body) => store.restoreRevision(next, files, Number(restoreMatch[1]), body)));
          if (route === 'POST /v1/service/shutdown' && onShutdown) {
            await readBody(request);
            send(response, 200, { ok: true });
            setImmediate(onShutdown); return;
          }
          if (!action) throw new StoreError('Unknown endpoint.', 404);
          const body = await readBody(request);
          const fingerprint = hash(JSON.stringify({ route, body }));
          const transactionId = request.headers['x-transaction-id'] || ((aiPull || aiPush) ? randomUUID() : undefined);
          result = store.transaction(transactionId, fingerprint,
            (next, files) => action(next, files, body));
        }
        // The agent only receives an edit path or a simple successful handoff.
        // A merge conflict is already persisted as a human Issue by the store.
        if (aiPull) {
          response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
          response.end(result.file);
        } else if (aiPush) {
          response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); response.end('success');
        } else send(response, result.ok === false ? 409 : 200, result);
        if (aiPush || url.pathname.endsWith('/resolve')) schedulePending();
      } catch (error) {
        if (aiPush) {
          if (error.code === 'INVALID_AI_PATH') {
            response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
            response.end('[Invalid path]');
          } else {
            // Other failures stay in the human-facing service output. No agent
            // notifications, recovery instructions or additional exit classes.
            console.error(error);
            response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); response.end('success');
          }
        } else {
          if (!(error instanceof StoreError)) console.error(error);
          send(response, error.status || 500, { error: error.message });
        }
      }
    };
    // Reads and writes share one queue, so nobody sees an in-flight journal.
    queue = queue.then(run, run);
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.on('error', () => store.close());
  server.listen(port, '127.0.0.1', () => {
    atomicWrite(discovery, Buffer.from(JSON.stringify({ port: server.address().port, token, pid: process.pid, file, serviceId, runtime }, null, 2), 'utf8'));
    console.log(`Paper manager: http://127.0.0.1:${server.address().port}`);
    console.log(`Managing ${file}; Review, Issues and explicit Push/Pull enabled.`);
    process.send?.({ type: 'ready' });
    onReady?.({ port: server.address().port, pid: process.pid, serviceId });
    schedulePending();
  });
  let closing;
  const close = () => { stopping = true; return closing ||= new Promise((resolve, reject) => server.close(async () => {
    await queue;
    try {
      if (fs.existsSync(discovery) && JSON.parse(fs.readFileSync(discovery, 'utf8')).serviceId === serviceId) fs.unlinkSync(discovery);
    } catch (error) { console.error('Discovery cleanup skipped: ' + error.message); }
    try { store.close(); resolve(); } catch (error) { reject(error); }
  })); };
  return { server, store, close };
}
async function readBody(request) {
  const chunks = []; let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 16 * 1024 * 1024) throw new StoreError('Request body exceeds 16 MiB.', 413);
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)) || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new StoreError('Expected a UTF-8 JSON object.', 400); }
}
function send(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(value));
}
if (require.main === module) {
  const args = process.argv.slice(2);
  const options = {};
  let valid = args[0] === '--file' && !!args[1];
  for (let index = 2; index < args.length; index++) {
    if (args[index] === '--initial-review' && ['approved', 'unreviewed'].includes(args[index + 1])) options.initialReview = args[++index];
    else if (args[index] === '--existing') options.requireExisting = true;
    else valid = false;
  }
  if (!valid) {
    console.error('Usage: node server.js --file main.tex [--initial-review approved|unreviewed] [--existing] (run from paper project root)'); process.exitCode = 1;
  } else {
    try {
      let app;
      app = startServer({ root: process.cwd(), file: args[1], ...options, onShutdown: () => app.close().then(() => process.exit(0)) });
      for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { app.close().then(() => process.exit(0)); });
      // Extension-owned subprocesses stop when their IPC parent disappears.
      if (process.send) process.once('disconnect', () => app.close().then(() => process.exit(0)));
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
module.exports = { startServer };
