'use strict';
function runtimeCapabilities() {
  let db;
  try {
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE probe (value TEXT); BEGIN IMMEDIATE;');
    db.prepare('INSERT INTO probe VALUES (?)').run('ok');
    db.exec('COMMIT');
    if (db.prepare('SELECT value FROM probe').get().value !== 'ok') throw Error('SQLite query failed.');
    return { mode: 'vscode-worker', node: process.versions.node, electron: process.versions.electron || null,
      sqlite: 'available' };
  } catch (error) {
    throw new Error('当前 VS Code 运行时不支持所需 SQLite，请更新桌面 VS Code。Node ' +
      process.versions.node + '：' + error.message);
  } finally { db?.close(); }
}
module.exports = { runtimeCapabilities };
