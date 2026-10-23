#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { safePath, decode } = require('./files');

async function main() {
  const args = process.argv.slice(2);
  const transactionFlag = args.indexOf('--transaction');
  let transactionId = randomUUID();
  if (transactionFlag >= 0) {
    transactionId = args[transactionFlag + 1];
    args.splice(transactionFlag, 2);
  }
  const [command, id] = args;
  const routes = { clone: ['POST', '/v1/ai/clone'], push: ['POST', `/v1/ai/${id}/push`],
    state: ['GET', '/v1/state'], revisions: ['GET', '/v1/revisions'], conflicts: ['GET', '/v1/conflicts'],
    reviews: ['GET', '/v1/reviews?scope=master'], issues: ['GET', '/v1/issues?scope=master'], events: ['GET', '/v1/events'] };
  if (!routes[command] || args.length !== (command === 'push' ? 2 : 1) || command === 'push' && !/^[a-f0-9-]{36}$/.test(id)) {
    throw new Error('Usage: paperctl clone | push <session-id> | state | revisions | conflicts | reviews | issues | events [--transaction <id>]');
  }
  const connection = JSON.parse(decode(fs.readFileSync(safePath(process.cwd(), '.paper-manager/connection.json'))));
  if (!Number.isInteger(connection.port) || connection.port < 1 || connection.port > 65535 || !/^[a-f0-9]{64}$/.test(connection.token)) throw new Error('Invalid service connection file.');
  const [method, route] = routes[command];
  if (method !== 'GET') console.error(`Transaction: ${transactionId} (reuse with --transaction after an uncertain network failure)`);
  const response = await fetch(`http://127.0.0.1:${connection.port}${route}`, {
    method, headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json', 'X-Transaction-Id': transactionId },
    body: method === 'GET' ? undefined : '{}', signal: AbortSignal.timeout(20000), redirect: 'error'
  });
  const result = await response.json();
  console.log(JSON.stringify(result, null, 2));
  if (!response.ok) process.exitCode = result.conflictId ? 2 : 1;
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
