'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { hash, safePath, decode } = require('./files');

const defaults = Object.freeze({ aiSessions: 3, revisions: 0, recovery: 3 });
function policy(value = {}) {
  const result = { ...defaults, ...value };
  if (Object.keys(result).some(key => !Object.hasOwn(defaults, key))) throw Error('Unknown storage setting.');
  for (const [key, count] of Object.entries(result)) {
    if (!Number.isSafeInteger(count) || count < (key === 'recovery' ? 1 : 0) || count > (key === 'recovery' ? 100 : 1000000)) throw Error('Invalid storage retention count.');
  }
  return result;
}
function references(value, hashes = new Set(), events = new Set()) {
  if (typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)) hashes.add(value);
  else if (Array.isArray(value)) for (const item of value) references(item, hashes, events);
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
    if (key === 'eventId' && typeof item === 'string') events.add(item);
    if (key === 'eventIds' && Array.isArray(item)) for (const id of item) events.add(id);
    references(item, hashes, events);
  }
  return { hashes, events };
}
function prune(state, { beforeRevision, aiSessions } = {}) {
  state.retention ||= { policy: { ...defaults }, floor: 1 };
  const limits = policy(state.retention.policy), removed = { revisions: [], sessions: [], events: 0, conflicts: [] };
  let floor = Math.max(state.retention.floor || 1, beforeRevision || 1);
  if (limits.revisions && state.revisions.length > limits.revisions) floor = Math.max(floor, state.revisions.at(-limits.revisions).revision);
  state.retention.floor = floor;
  state.revisions = state.revisions.filter(r => {
    const keep = r.revision >= floor || r.revision === state.master.revision;
    if (!keep) removed.revisions.push(r.revision);
    return keep;
  });
  state.conflicts = state.conflicts.filter(conflict => {
    const keep = conflict.status === 'open' || !conflict.resolvedRevision || conflict.resolvedRevision >= floor;
    if (!keep) removed.conflicts.push(conflict.id);
    return keep;
  });
  const pinned = new Set(state.pendingSubmissions.map(p => p.sessionId).filter(Boolean));
  for (const conflict of state.conflicts) if (conflict.status === 'open' && conflict.sessionId) pinned.add(conflict.sessionId);
  const completed = Object.values(state.sessions).filter(s => s.closed && !pinned.has(s.id))
    .sort((a, b) => (b.pushedRevision || 0) - (a.pushedRevision || 0) || b.createdAt - a.createdAt || b.id.localeCompare(a.id));
  for (const session of completed.slice(aiSessions ?? limits.aiSessions)) { delete state.sessions[session.id]; removed.sessions.push(session.id); }
  if (floor > 1) {
    const { events } = references({ reviews: state.reviews, human: state.human, pending: state.pendingSubmissions, conflict: state.activeConflict, conflicts: state.conflicts });
    state.changeEvents = state.changeEvents.filter(event => {
      const keep = event.revision >= floor || events.has(event.id);
      if (!keep) removed.events++;
      return keep;
    });
    const firstSequence = state.revisions[0]?.sequence;
    state.auditHistory = state.auditHistory.filter(entry => entry.revision !== undefined ? entry.revision >= floor :
      !Number.isSafeInteger(firstSequence) || entry.sequence >= firstSequence);
  }
  return removed;
}
function files(root, relative) {
  const directory = safePath(root, relative);
  if (!fs.existsSync(directory)) return [];
  if (!fs.statSync(directory).isDirectory()) throw Error('Expected a manager storage directory.');
  return fs.readdirSync(directory, { withFileTypes: true }).map(entry => {
    const name = relative + '/' + entry.name, target = safePath(root, name);
    return { name, base: entry.name, directory: entry.isDirectory(), size: entry.isFile() ? fs.statSync(target).size : 0 };
  });
}
function inventory(root) {
  const blobs = files(root, '.paper-manager/recovery/blobs').filter(f => !f.directory && /^[a-f0-9]{64}\.txt$/.test(f.base));
  const checkpoints = files(root, '.paper-manager/recovery/checkpoints').filter(f => !f.directory && /^(0|[1-9]\d*)\.json$/.test(f.base));
  const sessions = [], conflicts = [];
  function snapshots(relative, output, attempts = false, ai = false) {
    for (const file of files(root, relative)) {
      const owned = ai ? /^(base|main)\.tex$/.test(file.base) : /^(base|current|incoming|result)\.tex$|^metadata\.json$/.test(file.base);
      if (!file.directory && owned) output.push(file);
      else if (file.directory && file.base === 'attempts' && attempts) {
        for (const attempt of files(root, file.name)) if (attempt.directory && /^[a-f0-9-]{36}$/.test(attempt.base)) snapshots(attempt.name, output);
      }
    }
  }
  for (const item of files(root, '.paper-manager/ai-sessions')) if (item.directory && /^[a-f0-9-]{36}$/.test(item.base)) {
    const entries = []; snapshots(item.name, entries, false, true); sessions.push({ id: item.base, name: item.name, files: entries });
  }
  for (const item of files(root, '.paper-manager/conflicts')) if (item.directory && /^[a-f0-9-]{36}$/.test(item.base)) {
    const entries = []; snapshots(item.name, entries, true); conflicts.push({ id: item.base, name: item.name, files: entries });
  }
  return { blobs, checkpoints, sessions, conflicts };
}
function treeBytes(root, relative) {
  return files(root, relative).reduce((sum, file) => sum + (file.directory ? treeBytes(root, file.name) : file.size), 0);
}
function filePlan(root, state, { fresh = false, extraStates = [] } = {}) {
  const found = inventory(root), limits = policy(state.retention?.policy), floor = state.retention?.resetAt || 0;
  const keep = found.checkpoints.filter(f => Number(f.base.slice(0, -5)) >= floor).sort((a, b) => Number(b.base.slice(0, -5)) - Number(a.base.slice(0, -5)))
    .slice(0, fresh ? 0 : limits.recovery);
  const hashes = references(state).hashes, conflictIds = new Set(state.conflicts.map(c => c.id));
  for (const saved of extraStates) {
    references(saved, hashes);
    for (const conflict of saved.conflicts || []) conflictIds.add(conflict.id);
  }
  for (const checkpoint of keep) {
    const saved = JSON.parse(decode(fs.readFileSync(safePath(root, checkpoint.name))));
    references(saved.state, hashes);
    for (const conflict of saved.state.conflicts || []) conflictIds.add(conflict.id);
  }
  const remove = found.blobs.filter(f => !hashes.has(f.base.slice(0, -4)))
    .concat(found.checkpoints.filter(f => !keep.includes(f)))
    .concat(found.sessions.filter(s => !Object.hasOwn(state.sessions, s.id)).flatMap(s => s.files))
    .concat(found.conflicts.filter(c => !conflictIds.has(c.id)).flatMap(c => c.files));
  return { found, remove, protectedBlobs: found.blobs.length - remove.filter(f => found.blobs.includes(f)).length,
    fileBytes: remove.reduce((sum, file) => sum + file.size, 0) };
}
function removeFiles(root, plan) {
  // Delete regular, enumerated manager files only. Never recursively remove a
  // directory, follow links or touch an unknown file left by another tool.
  for (const file of plan.remove) {
    const target = safePath(root, file.name);
    if (!fs.lstatSync(target).isFile()) throw Error('Storage entry changed during cleanup.');
    fs.unlinkSync(target);
  }
  const directories = new Set(plan.remove.flatMap(file => {
    const result = []; let directory = path.posix.dirname(file.name);
    while (/^\.paper-manager\/(ai-sessions|conflicts)\//.test(directory)) { result.push(directory); directory = path.posix.dirname(directory); }
    return result;
  }));
  for (const relative of [...directories].sort((a, b) => b.length - a.length)) {
    try { fs.rmdirSync(safePath(root, relative)); } catch (error) { if (!['ENOTEMPTY', 'ENOENT'].includes(error.code)) throw error; }
  }
}
function cleanupRequest(body, revision) {
  if (!['compact', 'sessions', 'history'].includes(body.mode)) throw Error('Choose a storage cleanup action.');
  if (body.mode === 'history' && (!Number.isSafeInteger(body.beforeRevision) || body.beforeRevision < 1 || body.beforeRevision > revision)) throw Error('Choose a Revision from r1 through the current Master.');
  return { mode: body.mode, ...(body.mode === 'history' ? { beforeRevision: body.beforeRevision } : {}) };
}
function token(sequence, request) { return hash(JSON.stringify({ sequence, request })); }
module.exports = { defaults, policy, references, prune, files, inventory, treeBytes, filePlan, removeFiles, cleanupRequest, token };
