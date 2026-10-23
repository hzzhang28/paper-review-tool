'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

class ApiClient {
  constructor(root) { this.root = root; }
  async connection() {
    // Re-read after restarts so ephemeral port and token need no manual update.
    const connection = JSON.parse(await fs.readFile(path.join(this.root, '.paper-manager', 'connection.json'), 'utf8'));
    if (!Number.isInteger(connection.port) || connection.port < 1 || connection.port > 65535 || !/^[a-f0-9]{64}$/.test(connection.token)) throw new Error('Invalid local service connection.');
    return connection;
  }
  async request(method, route, body, transactionId = randomUUID()) {
    const connection = await this.connection();
    let response;
    const options = { method, headers: { Authorization: `Bearer ${connection.token}`,
      'Content-Type': 'application/json', 'X-Transaction-Id': transactionId },
      body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error' };
    // Retry transport failures with exactly the same transaction ID and body.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        response = await fetch(`http://127.0.0.1:${connection.port}${route}`, { ...options, signal: AbortSignal.timeout(20000) });
        const result = await response.json();
        if (!response.ok) {
          const error = new Error(result.error || `Merge conflict ${result.conflictId}. Snapshots are preserved in .paper-manager/conflicts.`);
          error.apiError = true; error.result = result; throw error;
        }
        return result;
      } catch (error) {
        if (error.apiError) throw error;
        if (attempt === 1) throw new Error(`${error.message}. Transaction ${transactionId}; reconnect before further changes.`);
      }
    }
  }
}
module.exports = { ApiClient };
