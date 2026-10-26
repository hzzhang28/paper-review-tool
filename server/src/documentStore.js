'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { hash, normalize, decode, safePath, atomicWrite } = require('./files');
const { merge } = require('./mergeEngine');
const reviewManager = require('./reviewManager');
const { anchorAt, relocate, minimizeIssues } = require('./structures');
const { applyReviewOperations, applyRejections } = require('./metadata');
const storage = require('./storageMaintenance');

class StoreError extends Error {
  constructor(message, status = 409) { super(message); this.status = status; }
}

class DocumentStore {
  constructor(projectRoot, masterFile, { initialReview = 'approved', requireExisting = false, serviceId } = {}) {
    if (!['approved', 'unreviewed'].includes(initialReview)) throw new Error('Choose approved or unreviewed initial review status.');
    this.initialReview = initialReview;
    this.serviceId = serviceId;
    this.root = path.resolve(projectRoot);
    if (fs.realpathSync(this.root).toLowerCase() !== this.root.toLowerCase()) throw new Error('Project root must not traverse links.');
    if (!masterFile.endsWith('.tex') || masterFile.split(/[\\/]/)[0] === '.paper-manager') throw new Error('Select one project-relative .tex file.');
    this.masterFile = masterFile;
    this.masterPath = safePath(this.root, masterFile);
    this.privatePath = safePath(this.root, '.paper-manager');
    fs.mkdirSync(this.privatePath, { recursive: true, mode: 0o700 });
    this.lockPath = safePath(this.root, '.paper-manager/service.lock');
    this.acquireLock();
    try {
      safePath(this.root, '.paper-manager/state.db-wal');
      safePath(this.root, '.paper-manager/state.db-shm');
      this.db = new DatabaseSync(safePath(this.root, '.paper-manager/state.db'));
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS pending (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS transactions (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, response TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS history (sequence INTEGER PRIMARY KEY, json TEXT NOT NULL);`);
      this.prepareStorageSchema();
      this.recover();
      const row = this.db.prepare('SELECT json FROM state WHERE id=1').get();
      if (row) this.state = JSON.parse(row.json);
      else {
        if (requireExisting) throw new Error('Project is not initialized. Use Initialize / Open Project and choose its initial review status.');
        this.initialize();
      }
      this.ensureMetadata(this.state);
      if (this.state.masterFile !== masterFile) throw new Error('This project already manages a different file.');
      this.assertManagedFiles();
    } catch (error) { this.close(); throw error; }
  }

  acquireLock() {
    if (fs.existsSync(this.lockPath)) {
      let owner;
      try { owner = JSON.parse(decode(fs.readFileSync(this.lockPath))); }
      catch { throw new Error('Unrecognized service lock; inspect it before manual removal.'); }
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error('Invalid service lock.');
      try { process.kill(owner.pid, 0); throw new Error('A service already owns this project.'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
      fs.unlinkSync(this.lockPath);
    }
    this.lockToken = this.serviceId || randomUUID();
    fs.writeFileSync(this.lockPath, JSON.stringify({ pid: process.pid, token: this.lockToken }), { flag: 'wx', mode: 0o600 });
  }

  close() {
    this.db?.close(); this.db = undefined;
    if (this.lockToken && fs.existsSync(this.lockPath)) {
      const owner = JSON.parse(decode(fs.readFileSync(this.lockPath)));
      if (owner.token === this.lockToken) fs.unlinkSync(this.lockPath);
    }
    this.lockToken = undefined;
  }

  ensureMetadata(state) {
    const legacyAnchors = state.schema < 3;
    state.schema = 3;
    state.issueTombstones ||= [];
    state.pendingSubmissions ||= [];
    state.reviews ||= []; state.changeEvents ||= []; state.auditHistory ||= []; state.issues ||= [];
    state.human.reviews ||= []; state.human.reviewOps ||= []; state.human.issues ||= []; state.human.issueOps ||= [];
    state.human.rejections ||= [];
    state.retention ||= { policy: { ...storage.defaults }, floor: 1 };
    state.retention.policy = storage.policy(state.retention.policy);
    state.issues = minimizeIssues(state.issues, this.text(state.master.hash), legacyAnchors);
    state.human.issues = minimizeIssues(state.human.issues, this.text(state.human.draftHash), legacyAnchors);
    state.human.issueOps = state.human.issueOps.map(op => ({ ...op,
      issue: state.human.issues.find(i => i.id === op.issue.id) || op.issue }));
    state.human.metadataBaseHash ??= this.metadataHash(state.reviews, state.issues);
    for (const conflict of state.conflicts.filter(c => c.status === 'open')) {
      if (!state.issues.some(issue => issue.conflictId === conflict.id) && !state.issueTombstones.some(issue => issue.conflictId === conflict.id)) state.issues.push({
        id: hash(`conflict-issue:${conflict.id}`), type: 'general', conflictId: conflict.id,
        title: `Merge conflict: ${conflict.kind}`, description: `Conflict ${conflict.id}; snapshots: ${conflict.directory}`,
        status: 'open', createdAt: conflict.createdAt, version: state.sequence, revision: conflict.revision
      });
    }
  }

  metadataHash(reviews, issues) {
    return hash(JSON.stringify({ reviews: reviews.map(r => [r.id, r.version, r.status, r.contentHash]).sort((a, b) => a[0].localeCompare(b[0])),
      issues: issues.map(i => [i.id, i.version, i.status, i.type, i.title, i.description]).sort((a, b) => a[0].localeCompare(b[0])) }));
  }

  relocateIssues(issues, before, after) {
    if (before === after) return structuredClone(issues);
    const hunks = reviewManager.changes(before, after);
    return relocate(issues, before, after, range => {
      if (!reviewManager.wholeRange(range, hunks)) return null;
      return { start: reviewManager.position(range.start, hunks, true), end: reviewManager.position(range.end, hunks, false) };
    });
  }

  blob(text) {
    const id = hash(text);
    const target = safePath(this.root, `.paper-manager/recovery/blobs/${id}.txt`);
    if (!fs.existsSync(target)) atomicWrite(target, Buffer.from(text, 'utf8'));
    else if (hash(fs.readFileSync(target)) !== id) throw new Error('Recovery blob corruption.');
    return id;
  }
  text(id) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid snapshot identifier.');
    const bytes = fs.readFileSync(safePath(this.root, `.paper-manager/recovery/blobs/${id}.txt`));
    if (hash(bytes) !== id) throw new Error('Snapshot checksum mismatch.');
    return decode(bytes);
  }
  diskHash(relative) {
    const target = safePath(this.root, relative);
    return fs.existsSync(target) ? hash(fs.readFileSync(target)) : null;
  }
  fileOperation(relative, text) {
    safePath(this.root, relative);
    return { relative, before: this.diskHash(relative), after: this.blob(text) };
  }

  initialize() {
    const bytes = fs.readFileSync(this.masterPath);
    const source = decode(bytes);
    if (source.includes('\r') && /\r(?!\n)/.test(source)) throw new Error('Lone CR line endings are unsupported.');
    const text = normalize(source);
    const snapshot = this.blob(text);
    const time = Date.now();
    const state = { schema: 1, sequence: 0, masterFile: this.masterFile,
      eol: source.includes('\r\n') ? '\r\n' : '\n',
      master: { revision: 1, hash: snapshot, diskHash: hash(bytes) },
      human: { baseHash: snapshot, draftHash: snapshot, baseRevision: 1, pulledRevision: 1, version: 1, mtime: time },
      sessions: {}, conflicts: [], revisions: [{ revision: 1, hash: snapshot, actor: 'initial', time, sequence: 0 }] };
    this.ensureMetadata(state);
    state.initialReview = this.initialReview;
    if (this.initialReview === 'unreviewed') {
      state.reviews = reviewManager.initialReviews(text);
      state.human.reviews = structuredClone(state.reviews);
      state.human.metadataBaseHash = this.metadataHash(state.reviews, state.issues);
    }
    this.commit(state, [this.fileOperation('.paper-manager/human/draft.tex', text),
      this.fileOperation('.paper-manager/project.json', JSON.stringify({ schema: 1, masterFile: this.masterFile, initialReview: this.initialReview }) + '\n')]);
  }

  assertManagedFiles() {
    if (this.poisoned) throw new StoreError('Recovery required: restart the service.', 503);
    if (this.diskHash(this.masterFile) !== this.state.master.diskHash) {
      throw new StoreError('Master changed outside the manager. Submissions paused; preserve the external file and restore the recorded snapshot before restarting.');
    }
    if (this.diskHash('.paper-manager/human/draft.tex') !== this.state.human.draftHash) {
      throw new StoreError('Private Human Draft changed outside the service. Preserve it before recovery.');
    }
  }

  recover() {
    const row = this.db.prepare('SELECT json FROM pending WHERE id=1').get();
    if (row) this.finish(JSON.parse(row.json));
  }
  finish(journal) {
    // Validate every destination BEFORE materializing any of them.
    for (const op of journal.files) {
      const actual = this.diskHash(op.relative);
      if (actual !== op.before && actual !== op.after) throw new Error(`Recovery stopped: external modification of ${op.relative}`);
      this.text(op.after);
    }
    for (const op of journal.files) {
      if (this.diskHash(op.relative) !== op.after) atomicWrite(safePath(this.root, op.relative), Buffer.from(this.text(op.after), 'utf8'));
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const json = JSON.stringify(journal.state);
      this.db.prepare('INSERT OR REPLACE INTO state VALUES (1, ?)').run(json);
      this.db.prepare('INSERT INTO history VALUES (?, ?)').run(journal.state.sequence, json);
      if (journal.transaction) this.db.prepare('INSERT INTO transactions (id,fingerprint,response,sequence,createdAt) VALUES (?, ?, ?, ?, ?)').run(
        journal.transaction.id, journal.transaction.fingerprint, JSON.stringify(journal.transaction.response), journal.state.sequence, Date.now());
      if (journal.state.retention) {
        const limits = storage.policy(journal.state.retention.policy);
        this.db.prepare('DELETE FROM history WHERE sequence < ? OR sequence NOT IN (SELECT sequence FROM history ORDER BY sequence DESC LIMIT ?)')
          .run(journal.state.retention.resetAt || 0, limits.recovery);
      }
      this.db.exec('DELETE FROM pending; COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.state = journal.state;
  }
  commit(next, files, transaction) {
    if (this.state) this.assertManagedFiles();
    const removed = storage.prune(next);
    const deep = !this.state || transaction?.response?.storageMaintenance || next.sequence % 25 === 0 ||
      next.master.revision !== this.state.master.revision || removed.sessions.length || removed.revisions.length ||
      JSON.stringify(Object.keys(next.sessions)) !== JSON.stringify(Object.keys(this.state.sessions));
    // Recovery checkpoints do not duplicate potentially large HTTP responses.
    const receipt = transaction && { id: transaction.id, fingerprint: transaction.fingerprint };
    files = files.concat(this.fileOperation(`.paper-manager/recovery/checkpoints/${next.sequence}.json`, JSON.stringify({ state: next, transaction: receipt }) + '\n'));
    const journal = { state: next, files, transaction };
    this.db.prepare('INSERT INTO pending VALUES (1, ?)').run(JSON.stringify(journal));
    try { this.finish(journal); }
    catch (error) { this.poisoned = true; throw error; }
    // The durable state is committed first. Reclamation is repeatable and must
    // never turn a successful Push into a failed or duplicated submission.
    try { this.maintainStorage({ deep, compact: !!transaction?.response?.storageCompact }); this.maintenanceError = undefined; }
    catch (error) { this.maintenanceError = error.message; console.warn('Storage maintenance postponed:', error.message); }
  }
  transaction(id, fingerprint, operation) {
    if (!/^[a-zA-Z0-9-]{8,100}$/.test(id || '')) throw new StoreError('A unique X-Transaction-Id is required.', 400);
    const previous = this.db.prepare('SELECT * FROM transactions WHERE id=?').get(id);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new StoreError('Transaction ID was reused for a different request.');
      if (previous.expired) throw new StoreError('This transaction result was reclaimed. Refresh state; the request will not be executed again.', 410);
      return JSON.parse(previous.response);
    }
    this.assertManagedFiles();
    const next = structuredClone(this.state);
    next.sequence++;
    const files = [];
    const response = operation(next, files);
    this.commit(next, files, { id, fingerprint, response });
    return response;
  }
  expectDraft(next, version) {
    if (version !== next.human.version) throw new StoreError('Draft version changed. Reload state before retrying.');
  }
  prepareStorageSchema() {
    const columns = new Set(this.db.prepare('PRAGMA table_info(transactions)').all().map(c => c.name));
    for (const [name, definition] of Object.entries({ sequence: 'INTEGER NOT NULL DEFAULT 0', createdAt: 'INTEGER NOT NULL DEFAULT 0', expired: 'INTEGER NOT NULL DEFAULT 0' })) {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE transactions ADD COLUMN ${name} ${definition}`);
    }
    // Give pre-upgrade requests the normal retry grace period before expiring
    // payloads. IDs and fingerprints are retained permanently.
    this.db.prepare('UPDATE transactions SET createdAt=? WHERE createdAt=0 AND expired=0').run(Date.now());
  }
  maintainStorage({ deep = false, compact = false } = {}) {
    if (this.db.prepare('SELECT 1 FROM pending LIMIT 1').get()) throw Error('Recovery is pending; storage cleanup postponed.');
    const state = this.state, limits = storage.policy(state.retention.policy);
    this.db.prepare("UPDATE transactions SET response='{}', expired=1 WHERE expired=0 AND createdAt < ? AND id NOT IN (SELECT id FROM transactions ORDER BY sequence DESC, rowid DESC LIMIT 20)")
      .run(compact ? Date.now() + 1 : Date.now() - 120000);
    if (deep) {
      const extraStates = this.db.prepare('SELECT json FROM history').all().map(row => JSON.parse(row.json));
      storage.removeFiles(this.root, storage.filePlan(this.root, state, { extraStates }));
    } else {
      const checkpoints = storage.files(this.root, '.paper-manager/recovery/checkpoints').filter(f => !f.directory && /^(0|[1-9]\d*)\.json$/.test(f.base));
      const kept = checkpoints.filter(f => Number(f.base.slice(0, -5)) >= (state.retention.resetAt || 0))
        .sort((a, b) => Number(b.base.slice(0, -5)) - Number(a.base.slice(0, -5))).slice(0, limits.recovery);
      storage.removeFiles(this.root, { remove: checkpoints.filter(f => !kept.includes(f)) });
    }
    if (compact) {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      this.db.exec('VACUUM');
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    }
  }
  storageInfo() {
    const found = storage.inventory(this.root);
    const database = ['state.db', 'state.db-wal', 'state.db-shm'].reduce((n, name) => {
      const target = safePath(this.root, '.paper-manager/' + name);
      return n + (fs.existsSync(target) ? fs.statSync(target).size : 0);
    }, 0);
    return { policy: this.state.retention.policy, sequence: this.state.sequence, masterRevision: this.state.master.revision,
      oldestRevision: this.state.revisions[0]?.revision, revisionCount: this.state.revisions.length,
      databaseBytes: database, recoveryBytes: storage.treeBytes(this.root, '.paper-manager/recovery'),
      aiSessionBytes: storage.treeBytes(this.root, '.paper-manager/ai-sessions'), aiSessionCount: Object.keys(this.state.sessions).length,
      checkpointCount: found.checkpoints.length, historyCount: this.db.prepare('SELECT COUNT(*) count FROM history').get().count,
      warning: this.maintenanceError };
  }
  storagePreview(body) {
    this.assertManagedFiles();
    let request;
    try { request = storage.cleanupRequest(body, this.state.master.revision); } catch (error) { throw new StoreError(error.message, 400); }
    const next = structuredClone(this.state); next.sequence++;
    const removed = storage.prune(next, { beforeRevision: request.beforeRevision, ...(request.mode === 'sessions' ? { aiSessions: 0 } : {}) });
    const plan = storage.filePlan(this.root, next, { fresh: true });
    return { token: storage.token(this.state.sequence, request), sequence: this.state.sequence, request,
      removedRevisions: removed.revisions, completedSessions: removed.sessions.length, removedEvents: removed.events,
      files: plan.remove.length, fileBytes: plan.fileBytes, protectedBlobs: plan.protectedBlobs };
  }
  storageCleanup(next, body) {
    const preview = this.storagePreview(body);
    if (body.token !== preview.token) throw new StoreError('项目状态已变化，请重新预览清理范围。');
    storage.prune(next, { beforeRevision: preview.request.beforeRevision, ...(preview.request.mode === 'sessions' ? { aiSessions: 0 } : {}) });
    // A fresh recovery baseline releases references from pre-cleanup backups.
    // Persist it before unlinking anything so interrupted cleanup can resume.
    next.retention.resetAt = next.sequence;
    return { ok: true, storageMaintenance: true, storageCompact: true, removedRevisions: preview.removedRevisions.length, completedSessions: preview.completedSessions };
  }
  storagePolicy(next, body) {
    let selected;
    try { selected = storage.policy(body.policy); } catch (error) { throw new StoreError(error.message, 400); }
    next.retention.policy = selected;
    return { ok: true, policy: selected, storageMaintenance: true };
  }
  stateView() {
    let drift;
    try { this.assertManagedFiles(); } catch (error) { drift = error.message; }
    const s = this.state;
    return { masterRevision: s.master.revision, humanBaseRevision: s.human.baseRevision,
      draftVersion: s.human.version, draftMtime: s.human.mtime,
      unpushed: s.human.baseHash !== s.human.draftHash || !!s.human.reviewOps.length || !!s.human.issueOps.length || !!s.human.rejections.length,
      updateAvailable: (s.human.pulledRevision < s.master.revision &&
        s.master.hash !== s.human.baseHash && s.master.hash !== s.human.draftHash) ||
        s.human.metadataBaseHash !== this.metadataHash(s.reviews, s.issues),
      pendingCount: s.pendingSubmissions.length, activeConflict: s.activeConflict && { id: s.activeConflict.id, masterRevision: s.activeConflict.masterRevision, draftVersion: s.activeConflict.draftVersion, openedAt: s.activeConflict.openedAt },
      sequence: s.sequence, conflicts: s.conflicts.filter(c => c.status === 'open'), drift,
      reviewCount: s.reviews.length, draftReviewCount: s.human.reviews.length,
      issueCount: s.issues.filter(i => i.status === 'open').length,
      masterFile: s.masterFile, initialReview: s.initialReview || 'approved', aiNotification: s.aiNotification, phase: 5 };
  }
  humanFile() {
    return { text: this.text(this.state.human.draftHash), version: this.state.human.version,
      mtime: this.state.human.mtime };
  }
  saveDraft(next, files, body) {
    this.expectDraft(next, body.expectedDraftVersion);
    if (typeof body.text !== 'string' || !body.text.isWellFormed() || body.text.includes('\r') && /\r(?!\n)/.test(body.text)) throw new StoreError('Expected well-formed UTF-8 text with LF or CRLF.', 400);
    const text = normalize(body.text);
    const previous = this.text(next.human.draftHash);
    next.human.reviews = reviewManager.remap(next.human.reviews, previous, text);
    // Keep staged manual marks aligned with the edited Draft until Push.
    next.human.reviewOps = next.human.reviewOps.flatMap(op => op.action !== 'mark' ? [op] :
      reviewManager.remap([op.review], this.text(op.snapshotHash), text).map(review => ({ ...op, review, snapshotHash: this.blob(text) })));
    next.human.issues = this.relocateIssues(next.human.issues, previous, text);
    next.human.issueOps = next.human.issueOps.map(op => ({ ...op, issue: next.human.issues.find(issue => issue.id === op.issue.id) || op.issue }));
    next.human.draftHash = this.blob(text);
    next.human.version++; next.human.mtime = Date.now();
    files.push(this.fileOperation('.paper-manager/human/draft.tex', text));
    return { ok: true, draftVersion: next.human.version };
  }
  updateMaster(next, files, text, actor, sessionId, aiText = text, resolvingId) {
    if (next.activeConflict && next.activeConflict.id !== resolvingId) throw new StoreError('请先完成当前冲突处理；Master 已冻结。');
    const snapshot = this.blob(text);
    if (snapshot === next.master.hash) return;
    const previous = this.text(next.master.hash);
    if (actor === 'ai') {
      const audit = reviewManager.applyAI(next.reviews, previous, aiText, next.master.revision + 1, sessionId);
      next.reviews = reviewManager.remap(audit.reviews, aiText, text);
      next.changeEvents.push(...audit.events.map(event => ({ ...event, snapshotHash: this.blob(aiText), baseRevision: next.sessions[sessionId]?.baseRevision })));
    } else next.reviews = reviewManager.remap(next.reviews, previous, text);
    next.issues = this.relocateIssues(next.issues, previous, text);
    const diskText = text.replace(/\n/g, next.eol);
    next.master = { revision: next.master.revision + 1, hash: snapshot, diskHash: hash(diskText) };
    next.revisions.push({ revision: next.master.revision, hash: snapshot, actor, sessionId, time: Date.now(), sequence: next.sequence });
    files.push(this.fileOperation(next.masterFile, diskText));
  }
  conflict(next, files, kind, base, current, incoming, details, sessionId) {
    const id = randomUUID();
    const directory = `.paper-manager/conflicts/${id}`;
    const record = { id, kind, sessionId, status: 'open', revision: next.master.revision,
      draftVersion: next.human.version, createdAt: Date.now(), directory, details };
    for (const [name, text] of Object.entries({ base, current, incoming })) files.push(this.fileOperation(`${directory}/${name}.tex`, text));
    // Deliberately no result.tex: an untouched copy must never masquerade as a resolution.
    files.push(this.fileOperation(`${directory}/metadata.json`, JSON.stringify(record, null, 2) + '\n'));
    next.conflicts.push(record);
    next.issues.push({ id: randomUUID(), type: 'general', title: `Merge conflict: ${kind}`, description: `Conflict ${id}; snapshots: ${directory}`,
      conflictId: id, status: 'open', createdAt: Date.now(), version: next.sequence, revision: next.master.revision });
    return { ok: false, conflictId: id, masterRevision: next.master.revision };
  }
  humanPush(next, files, body, processingPending = false) {
    this.expectDraft(next, body.expectedDraftVersion);
    if (!processingPending && (next.activeConflict || next.pendingSubmissions.length)) return this.queueSubmission(next, { kind: 'human', human: structuredClone(next.human) });
    const base = this.text(next.human.baseHash), draft = this.text(next.human.draftHash), master = this.text(next.master.hash);
    const result = merge(base, master, draft);
    if (!result.ok) return this.conflict(next, files, 'human-push', base, master, draft, result.conflicts);
    this.updateMaster(next, files, result.text, 'human');
    return this.acceptHumanPush(next, draft, result.text);
  }
  acceptHumanPush(next, draft, mergedText) {
    for (const op of next.human.issueOps) {
      const current = next.issues.find(i => i.id === op.issue.id);
      if ((current?.version ?? null) !== op.expectedVersion) throw new StoreError('An Issue changed since the last update. Preserve local notes and reconcile the latest Issue before pushing.');
    }
    const audit = this.replayReviews(next.reviews, next.human.reviewOps, mergedText);
    next.reviews = audit.reviews;
    next.reviews = applyRejections(next.reviews, next.human.rejections);
    next.auditHistory.push(...audit.applied.map(operation => ({ ...operation, sequence: next.sequence, revision: next.master.revision, time: Date.now() })));
    next.auditHistory.push(...next.human.rejections.map(rejected => ({ ...rejected, action: 'reject', sequence: next.sequence, revision: next.master.revision, time: Date.now() })));
    next.human.rejections = [];
    next.human.reviewOps = [];
    for (const op of next.human.issueOps) {
      if (op.action === 'delete') {
        next.issues = next.issues.filter(i => i.id !== op.issue.id);
        next.issueTombstones.push({ id: op.issue.id, conflictId: op.issue.conflictId, version: next.sequence });
        continue;
      }
      let issue = structuredClone(op.issue);
      issue = this.relocateIssues([issue], draft, mergedText)[0];
      issue.version = next.sequence; issue.revision = next.master.revision;
      next.issues = next.issues.filter(i => i.id !== issue.id).concat(issue);
      const local = next.human.issues.find(i => i.id === issue.id);
      if (local) local.version = issue.version;
    }
    next.human.issueOps = [];
    const metadata = this.metadataHash(next.reviews, next.issues);
    if (metadata === this.metadataHash(next.human.reviews, next.human.issues)) next.human.metadataBaseHash = metadata;
    // This is the submitted Draft, NOT the resulting Master.
    next.human.baseHash = next.human.draftHash;
    next.human.baseRevision = next.master.revision;
    return { ok: true, masterRevision: next.master.revision, draftVersion: next.human.version, staleReviews: audit.stale.length };
  }
  humanUpdate(next, files, body) {
    this.expectDraft(next, body.expectedDraftVersion);
    const text = this.text(next.master.hash);
    next.human.baseHash = next.master.hash; next.human.draftHash = next.master.hash;
    next.human.baseRevision = next.master.revision; next.human.pulledRevision = next.master.revision;
    next.human.reviews = structuredClone(next.reviews); next.human.issues = structuredClone(next.issues);
    next.human.reviewOps = []; next.human.issueOps = []; next.human.rejections = [];
    next.human.metadataBaseHash = this.metadataHash(next.reviews, next.issues);
    next.human.version++; next.human.mtime = Date.now();
    files.push(this.fileOperation('.paper-manager/human/draft.tex', text));
    return { ok: true, text, draftVersion: next.human.version, masterRevision: next.master.revision };
  }
  humanMergeUpdate(next, files, body) {
    const pushed = this.humanPush(next, files, body);
    if (pushed.pending) return pushed;
    if (!pushed.ok) {
      next.conflicts.find(conflict => conflict.id === pushed.conflictId).followUp = 'merge-update';
      return pushed;
    }
    // Push already performed the three-way merge. Materialize precisely that
    // resulting Master in the same transaction; no second race or partial Push.
    return { ...pushed, ...this.humanUpdate(next, files, body) };
  }
  humanPull(next, files, body) {
    this.expectDraft(next, body.expectedDraftVersion);
    const base = this.text(next.human.baseHash), draft = this.text(next.human.draftHash), master = this.text(next.master.hash);
    const result = merge(base, draft, master);
    if (!result.ok) return this.conflict(next, files, 'human-pull', base, draft, master, result.conflicts);
    next.human.reviews = this.replayReviews(reviewManager.remap(next.reviews, master, result.text), next.human.reviewOps, result.text).reviews;
    next.human.reviews = applyRejections(next.human.reviews, next.human.rejections);
    const pulledIssues = this.relocateIssues(next.issues, master, result.text);
    const operations = [], staleIssueDeletes = [];
    for (const op of next.human.issueOps) {
      const current = next.issues.find(i => i.id === op.issue.id);
      if (op.action === 'delete') {
        if (!current) continue; // Already deleted elsewhere; do not resurrect it.
        if (current.version !== op.expectedVersion) { staleIssueDeletes.push(current.title); continue; }
        const index = pulledIssues.findIndex(i => i.id === current.id);
        if (index >= 0) pulledIssues.splice(index, 1);
        operations.push(op);
        continue;
      }
      let local = this.relocateIssues([op.issue], draft, result.text)[0];
      if ((current?.version ?? null) !== op.expectedVersion) {
        local = { id: randomUUID(), type: 'general', title: `Preserved local Issue edit: ${local.title}`,
          description: local.description, originalIssueId: op.issue.id, status: 'open', version: 0, createdAt: Date.now() };
        operations.push({ issue: local, expectedVersion: null });
      } else operations.push({ ...op, issue: local });
      const index = pulledIssues.findIndex(i => i.id === local.id);
      if (index >= 0) pulledIssues.splice(index, 1);
      pulledIssues.push(local);
    }
    next.human.issues = pulledIssues; next.human.issueOps = operations;
    next.human.metadataBaseHash = this.metadataHash(next.reviews, next.issues);
    next.human.baseHash = next.master.hash;
    next.human.baseRevision = next.master.revision;
    next.human.pulledRevision = next.master.revision;
    next.human.draftHash = this.blob(result.text);
    next.human.version++; next.human.mtime = Date.now();
    files.push(this.fileOperation('.paper-manager/human/draft.tex', result.text));
    return { ok: true, text: result.text, draftVersion: next.human.version, masterRevision: next.master.revision, staleIssueDeletes };
  }
  cloneAI(next, files) {
    const id = randomUUID(), directory = `.paper-manager/ai-sessions/${id}`;
    const text = this.text(next.master.hash);
    next.sessions[id] = { id, baseHash: next.master.hash, baseRevision: next.master.revision, createdAt: Date.now() };
    files.push(this.fileOperation(`${directory}/base.tex`, text), this.fileOperation(`${directory}/main.tex`, text));
    return { ok: true, sessionId: id, baseRevision: next.master.revision, file: safePath(this.root, `${directory}/main.tex`) };
  }
  pushAIFile(next, files, body) {
    const invalid = () => Object.assign(new StoreError('[Invalid path]', 400), { code: 'INVALID_AI_PATH' });
    let id;
    try {
      if (typeof body.file !== 'string' || !path.isAbsolute(body.file)) throw invalid();
      const requested = path.normalize(body.file), parts = path.relative(this.root, requested).split(path.sep);
      const equal = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
      if (parts.length !== 4 || !equal(parts[0], '.paper-manager') || !equal(parts[1], 'ai-sessions') || !equal(parts[3], 'main.tex')) throw invalid();
      id = process.platform === 'win32' ? parts[2].toLowerCase() : parts[2];
      if (!next.sessions[id] || next.sessions[id].closed) throw invalid();
      const expected = safePath(this.root, '.paper-manager/ai-sessions/' + id + '/main.tex');
      if (!equal(requested, expected) || !fs.statSync(expected).isFile()) throw invalid();
    } catch { throw invalid(); }
    return this.pushAI(next, files, id);
  }
  pushAI(next, files, id) {
    const session = next.sessions[id];
    if (!session) throw new StoreError('Unknown AI session.', 404);
    if (session.closed) throw new StoreError('Session already pushed; clone a fresh session.');
    const incoming = normalize(decode(fs.readFileSync(safePath(this.root, `.paper-manager/ai-sessions/${id}/main.tex`))));
    if (/\r/.test(incoming)) throw new StoreError('Lone CR line endings are unsupported.', 400);
    if (next.activeConflict || next.pendingSubmissions.length) {
      const pending = this.queueSubmission(next, { kind: 'ai', sessionId: id, incomingHash: this.blob(incoming) });
      session.closed = true; session.pending = true;
      next.aiNotification = { sequence: next.sequence, status: 'pending', masterRevision: next.master.revision };
      return pending;
    }
    return this.applyAISubmission(next, files, id, incoming);
  }
  queueSubmission(next, submission) {
    next.pendingSubmissions.push({ id: randomUUID(), createdAt: Date.now(), ...submission });
    return { ok: true, pending: true, masterRevision: next.master.revision, draftVersion: next.human.version };
  }
  processNextSubmission(next, files) {
    if (next.activeConflict || next.conflicts.some(c => c.status === 'open') || !next.pendingSubmissions.length) return { processed: false };
    const pending = next.pendingSubmissions.shift();
    if (pending.kind === 'ai') {
      next.sessions[pending.sessionId].pending = false;
      return { processed: true, ...this.applyAISubmission(next, files, pending.sessionId, this.text(pending.incomingHash)) };
    }
    if (pending.kind === 'restore') {
      this.updateMaster(next, files, this.text(pending.hash), 'human-restore');
      return { processed: true, ok: true, masterRevision: next.master.revision };
    }
    const live = next.human;
    try {
      next.human = structuredClone(pending.human);
      const result = this.humanPush(next, files, { expectedDraftVersion: next.human.version }, true);
      if (result.conflictId) next.conflicts.find(c => c.id === result.conflictId).submissionHuman = pending.human;
      return { processed: true, ...result };
    } finally { next.human = live; }
  }
  applyAISubmission(next, files, id, incoming) {
    const session = next.sessions[id], base = this.text(session.baseHash), master = this.text(next.master.hash);
    const result = merge(base, master, incoming);
    if (!result.ok) {
      const conflict = this.conflict(next, files, 'ai-push', base, master, incoming, result.conflicts, id);
      next.aiNotification = { sequence: next.sequence, status: 'conflict', masterRevision: next.master.revision, conflictId: conflict.conflictId };
      return conflict;
    }
    this.updateMaster(next, files, result.text, 'ai', id);
    session.closed = true; session.pushedRevision = next.master.revision;
    next.aiNotification = { sequence: next.sequence, status: 'submitted', masterRevision: next.master.revision };
    return { ok: true, masterRevision: next.master.revision };
  }

  replayReviews(reviews, operations, text) {
    return applyReviewOperations(reviews, operations, { mapOperation: (operation, review) => {
      // Only human text changes within the same inspected AI generation may
      // move a staged decision. New AI edits replace that generation.
      if (!review || !operation.sourceVersion || operation.sourceVersion !== (review.sourceVersion || review.version) || typeof operation.inspectedText !== 'string') return null;
      let selection;
      if (operation.selection) {
        selection = reviewManager.wholeRange(operation.selection, reviewManager.changes(operation.inspectedText, review.text));
        if (!selection) return null;
      }
      return { ...operation, version: review.version, contentHash: review.contentHash, selection };
    }, mapMark: operation => {
      const before = this.text(operation.snapshotHash), review = operation.review;
      const hunks = reviewManager.changes(before, text);
      if (hunks.some(h => h.start < review.end && h.end > review.start ||
        h.start === h.end && h.start > review.start && h.start < review.end)) return null;
      const start = reviewManager.position(review.start, hunks, true);
      const end = reviewManager.position(review.end, hunks, false);
      return hash(text.slice(start, end)) === review.contentHash ? { ...review, start, end } : null;
    } });
  }
  markSelection(next, body) {
    if (!['unreviewed', 'needsFix'].includes(body.action)) throw new StoreError('Only yellow or red can mark ordinary text.', 400);
    const text = this.text(next.human.draftHash);
    let { start, end } = body.range;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > text.length) throw new StoreError('Invalid review range.', 400);
    // A caret marks its word/LaTeX token; selections expand to token boundaries.
    let offset = 0;
    const spans = require('./mergeEngine').tokens(text).map(token => { const span = { start: offset, end: offset + token.length, token }; offset = span.end; return span; });
    const selected = spans.filter(span => start === end ? span.start <= start && start < span.end : span.start < end && span.end > start);
    if (!selected.length || !selected.some(span => span.token.trim())) throw new StoreError('Select text or place the caret inside a word.', 400);
    start = selected[0].start; end = selected.at(-1).end;
    let gaps = [{ start, end }];
    const operations = [];
    for (const review of next.human.reviews) {
      if (review.start >= end || review.end <= start) continue;
      operations.push({ reviewId: review.id, version: review.version, contentHash: review.contentHash,
        sourceVersion: review.sourceVersion || review.version, inspectedText: review.text, action: body.action,
        selection: { start: Math.max(start, review.start) - review.start, end: Math.min(end, review.end) - review.start } });
      gaps = gaps.flatMap(r => review.start >= r.end || review.end <= r.start ? [r] :
        [{ start: r.start, end: Math.min(r.end, review.start) }, { start: Math.max(r.start, review.end), end: r.end }].filter(r => r.end > r.start));
    }
    for (const range of gaps) {
      const value = text.slice(range.start, range.end);
      if (!value.trim()) continue;
      const review = { ...range, id: randomUUID(), eventId: randomUUID(), origin: 'manual', kind: 'token', status: body.action,
        text: value, initialText: value, original: null, version: randomUUID(), contentHash: hash(value), revision: next.master.revision };
      operations.push({ action: 'mark', review, snapshotHash: next.human.draftHash });
    }
    next.human.reviewOps.push(...operations);
    next.human.reviews = this.replayReviews(next.human.reviews, operations, text).reviews;
    return { ok: true, draftVersion: next.human.version };
  }
  reviewAction(next, files, body) {
    this.expectDraft(next, body.expectedDraftVersion);
    if (body.range) return this.markSelection(next, body);
    const review = next.human.reviews.find(r => r.id === body.reviewId);
    if (!review || !reviewManager.matches(review, body)) throw new StoreError('Review no longer matches the inspected Draft.');
    if (!['approve', 'unreviewed', 'needsFix', 'reject'].includes(body.action)) throw new StoreError('Unknown review action.', 400);
    if (body.action === 'reject') {
      if (review.origin === 'manual') throw new StoreError('Manual marks have no AI change to reject. Edit or approve the text.');
      if (review.origin === 'initial') throw new StoreError('Initial text has no earlier version to restore. Edit it manually, mark Needs Fix, or approve it.');
      let text, result;
      const draft = this.text(next.human.draftHash);
      if (body.rejectWholeEvent) {
        const event = next.changeEvents.find(e => e.id === review.eventId);
        if (!event?.snapshotHash) throw new StoreError('The original event snapshot is unavailable. Edit the text manually.');
        const snapshot = this.text(event.snapshotHash);
        const inverse = snapshot.slice(0, event.start) + event.before + snapshot.slice(event.end);
        result = merge(snapshot, draft, inverse);
        text = result.text;
      } else {
        if (review.original === null || review.rejectionMode === 'event') throw new StoreError('This fragment requires rejection of its complete original change.');
        result = merge(review.initialText, review.text, review.original);
        text = draft.slice(0, review.start) + result.text + draft.slice(review.end);
      }
      if (!result.ok) throw new StoreError('Rejection overlaps later edits. Preserve them and resolve manually.');
      this.saveDraft(next, files, { text, expectedDraftVersion: body.expectedDraftVersion });
      const rejected = { reviewId: review.id, wholeEvent: !!body.rejectWholeEvent,
        eventIds: body.rejectWholeEvent ? [review.eventId] : review.eventIds || [review.eventId] };
      next.human.rejections.push(rejected);
      next.human.reviews = applyRejections(next.human.reviews, [rejected]);
      return { ok: true, text, draftVersion: next.human.version };
    }
    if (body.selection) {
      const s = body.selection;
      if (review.kind !== 'token' || !Number.isInteger(s.start) || !Number.isInteger(s.end) || s.start < 0 || s.end > review.text.length || s.end <= s.start) throw new StoreError('Select a valid token range or the entire paragraph.', 400);
      const boundaries = new Set([0]); let offset = 0;
      for (const token of require('./mergeEngine').tokens(review.text)) boundaries.add(offset += token.length);
      if (!boundaries.has(s.start) || !boundaries.has(s.end)) throw new StoreError('Review selection must follow token boundaries.', 400);
    }
    const operation = { reviewId: review.id, version: review.version, contentHash: review.contentHash,
      sourceVersion: review.sourceVersion || review.version, inspectedText: review.text, action: body.action, selection: body.selection };
    next.human.reviewOps.push(operation);
    next.human.reviews = applyReviewOperations(next.human.reviews, [operation]).reviews;
    return { ok: true, draftVersion: next.human.version };
  }

  editIssue(next, files, body) {
    this.expectDraft(next, body.expectedDraftVersion);
    const previous = body.id ? next.human.issues.find(i => i.id === body.id) : undefined;
    if (body.id && (!previous || body.expectedVersion !== previous.version)) throw new StoreError('Issue version changed.');
    if (body.action === 'delete') {
      if (!previous) throw new StoreError('Issue no longer exists.', 404);
      const pending = next.human.issueOps.find(op => op.issue.id === previous.id);
      next.human.issues = next.human.issues.filter(i => i.id !== previous.id);
      next.human.issueOps = next.human.issueOps.filter(op => op.issue.id !== previous.id);
      if (!pending || pending.expectedVersion !== null) next.human.issueOps.push({
        action: 'delete', issue: previous, expectedVersion: pending ? pending.expectedVersion : previous.version });
      return { ok: true, deleted: previous.id };
    }
    if (body.action && body.action !== 'edit') throw new StoreError('Invalid Issue action.', 400);
    if (typeof body.title !== 'string' || !body.title.trim() || typeof body.description !== 'string' || /[\r\n]/.test(body.title) || !body.title.isWellFormed() || !body.description.isWellFormed()) throw new StoreError('Issue title and description are required.', 400);
    if (!['general', 'anchored'].includes(body.type) || !['open', 'resolved'].includes(body.status || 'open')) throw new StoreError('Invalid Issue type or status.', 400);
    let anchor;
    if (body.type === 'anchored') {
      if (body.offset === undefined && previous?.anchor) anchor = previous.anchor;
      else {
        if (!Number.isInteger(body.offset)) throw new StoreError('An anchored Issue requires a structure position.', 400);
        anchor = anchorAt(this.text(next.human.draftHash), body.offset, body.anchorMode || 'line');
      }
    }
    const issue = { ...previous, id: previous?.id || randomUUID(), title: body.title.trim(), description: body.description,
      type: body.type, anchor, status: body.status || 'open', createdAt: previous?.createdAt || Date.now(), version: next.sequence };
    next.human.issues = next.human.issues.filter(i => i.id !== issue.id).concat(issue);
    const pending = next.human.issueOps.find(op => op.issue.id === issue.id);
    next.human.issueOps = next.human.issueOps.filter(op => op.issue.id !== issue.id).concat({ issue,
      expectedVersion: pending ? pending.expectedVersion : previous ? previous.version : null });
    return { ok: true, issue };
  }

  prepareConflict(next, files, id) {
    const conflict = next.conflicts.find(c => c.id === id && c.status === 'open');
    if (!conflict) throw new StoreError('Unknown open conflict.', 404);
    if (next.activeConflict && next.activeConflict.id !== id) throw new StoreError('请先完成已打开的冲突处理。');
    const read = (directory, name) => normalize(decode(fs.readFileSync(safePath(this.root, directory + '/' + name + '.tex'))));
    const previousDirectory = conflict.preparedDirectory || conflict.directory;
    let directory = previousDirectory;
    if (next.master.revision !== (conflict.preparedRevision ?? conflict.revision)) {
      // Preserve the original snapshots and any saved human resolution. A new
      // attempt compares them with today's Master; never overwrite old files.
      const hasResult = fs.existsSync(safePath(this.root, previousDirectory + '/result.tex'));
      const previousMaster = previousDirectory === conflict.directory && conflict.kind === 'human-pull' ? 'incoming' : 'current';
      const saved = hasResult ? read(previousDirectory, 'result') : undefined;
      const edited = hasResult && saved !== read(previousDirectory, 'current');
      // An untouched initial result is just a copy of Current, not a decision
      // to discard Incoming. Keep the proposal visible when reopening it.
      const base = edited ? read(previousDirectory, previousMaster) : read(previousDirectory, 'base');
      const incoming = edited ? saved : read(previousDirectory, previousDirectory === conflict.directory && conflict.kind === 'human-pull' ? 'current' : 'incoming');
      directory = conflict.directory + '/attempts/' + randomUUID();
      const current = this.text(next.master.hash);
      for (const [name, text] of Object.entries({ base, current, incoming, result: current })) files.push(this.fileOperation(directory + '/' + name + '.tex', text));
      conflict.preparedDirectory = directory;
    } else if (!fs.existsSync(safePath(this.root, directory + '/result.tex'))) files.push(this.fileOperation(directory + '/result.tex', read(directory, 'current')));
    conflict.preparedRevision = next.master.revision;
    next.activeConflict ||= { id, masterRevision: next.master.revision, draftVersion: next.human.version, human: structuredClone(next.human), openedAt: Date.now() };
    return { ok: true, id, kind: conflict.kind, preparedRevision: conflict.preparedRevision,
      paths: Object.fromEntries(['base', 'current', 'incoming', 'result'].map(name => [name, safePath(this.root, directory + '/' + name + '.tex')])) };
  }

  resolveConflict(next, files, id, body) {
    const conflict = next.conflicts.find(c => c.id === id && c.status === 'open');
    if (!conflict || conflict.preparedRevision === undefined) throw new StoreError('Prepare the Merge Editor first.');
    if (body.expectedMasterRevision !== next.master.revision || next.master.revision !== conflict.preparedRevision) throw new StoreError('Master advanced. Click Conflicts to reopen against the latest Master; the saved resolution is preserved.');
    let text = normalize(decode(fs.readFileSync(safePath(this.root, (conflict.preparedDirectory || conflict.directory) + '/result.tex'))));
    const aiText = text;
    const queuedHuman = next.pendingSubmissions.some(p => p.kind === 'human' && JSON.stringify(p.human) === JSON.stringify(next.human));
    const resolutionHuman = queuedHuman ? { ...next.activeConflict.human, draftHash: next.activeConflict.human.baseHash,
      reviewOps: [], issueOps: [], rejections: [] } : next.human;
    if (/^(?:<{7}|={7}|>{7}|\|{7})/m.test(text) || /\r/.test(text)) throw new StoreError('Resolve all merge markers before submitting.');
    if (body.syncHuman) this.expectDraft(next, body.expectedDraftVersion);
    if (conflict.kind.startsWith('human')) {
      this.expectDraft(next, body.expectedDraftVersion);
      if (!conflict.submissionHuman && resolutionHuman.version !== conflict.draftVersion) throw new StoreError('Draft changed after this conflict. Preserve it and create a new merge.');
    }
    if (body.syncHuman && (conflict.kind === 'ai-push' || conflict.submissionHuman)) {
      const local = merge(this.text(resolutionHuman.baseHash), text, this.text(resolutionHuman.draftHash));
      if (!local.ok) throw new StoreError('人工草稿与合并结果仍有重叠修改。请将草稿中的相关修改调整为最终选择后再提交；Master 尚未更新。');
      text = local.text;
    }
    if (conflict.kind === 'human-pull' && !body.syncHuman) {
      this.saveDraft(next, files, { text, expectedDraftVersion: next.human.version });
      next.human.baseHash = next.master.hash; next.human.baseRevision = next.master.revision; next.human.pulledRevision = next.master.revision;
      next.human.reviews = this.replayReviews(reviewManager.remap(next.reviews, this.text(next.master.hash), text), next.human.reviewOps, text).reviews;
      const localIds = new Set(next.human.issueOps.map(op => op.issue.id));
      next.human.issues = this.relocateIssues(next.issues, this.text(next.master.hash), text).filter(issue => !localIds.has(issue.id)).concat(next.human.issueOps.filter(op => op.action !== 'delete').map(op => op.issue));
    } else {
      this.updateMaster(next, files, text, conflict.kind === 'ai-push' ? 'ai' : 'human', conflict.sessionId, aiText, id);
      if (conflict.sessionId) next.sessions[conflict.sessionId].closed = true;
      if (conflict.kind === 'human-push' || body.syncHuman) {
        if (conflict.submissionHuman || queuedHuman) {
          const live = next.human;
          try { next.human = structuredClone(conflict.submissionHuman || resolutionHuman); this.acceptHumanPush(next, this.text(next.human.draftHash), text); }
          finally { next.human = live; }
        } else this.acceptHumanPush(next, this.text(next.human.draftHash), text);
      }
    }
    conflict.status = 'resolved'; conflict.resolvedRevision = next.master.revision;
    if (next.activeConflict?.id === id) next.activeConflict = undefined;
    for (const issue of next.issues.filter(i => i.conflictId === id)) { issue.status = 'resolved'; issue.version = next.sequence; }
    for (const issue of next.human.issues.filter(i => i.conflictId === id)) { issue.status = 'resolved'; issue.version = next.sequence; }
    if (conflict.kind === 'human-pull') next.human.metadataBaseHash = this.metadataHash(next.reviews, next.issues);
    if (body.syncHuman || conflict.followUp === 'merge-update') return this.humanUpdate(next, files, { expectedDraftVersion: next.human.version });
    return { ok: true, masterRevision: next.master.revision, draftVersion: next.human.version,
      text: conflict.kind === 'human-pull' ? text : undefined };
  }

  restoreRevision(next, files, revision, body) {
    if (body.expectedMasterRevision !== next.master.revision) throw new StoreError('Master advanced before restore.');
    const selected = next.revisions.find(r => r.revision === revision);
    if (!selected) throw new StoreError('Unknown historical Revision.', 404);
    if (next.activeConflict || next.pendingSubmissions.length) return this.queueSubmission(next, { kind: 'restore', hash: selected.hash });
    this.updateMaster(next, files, this.text(selected.hash), 'human-restore');
    return { ok: true, masterRevision: next.master.revision };
  }
}
module.exports = { DocumentStore, StoreError };
