'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { validateProfile, expandSteps } = require('./compileProfiles');
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const normalized = text => text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');

function completePdf(bytes) {
  if (!bytes || !/^%PDF-[12]\.\d/.test(bytes.subarray(0, 16).toString('ascii'))) return false;
  const trailer = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(bytes.subarray(-2048).toString('ascii'));
  if (!trailer) return false;
  const offset = Number(trailer[1]);
  return offset > 0 && offset < bytes.length && /^(xref\b|\d+\s+\d+\s+obj\b)/.test(bytes.subarray(offset, offset + 80).toString('ascii'));
}

function runProcess(command, args, { root, signal, output }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, windowsHide: true, shell: false,
      stdio: ['ignore', 'pipe', 'pipe'], signal });
    for (const stream of [child.stdout, child.stderr].filter(Boolean)) stream.on('data', chunk => output?.append(chunk.toString('utf8')));
    let failure;
    child.once('error', error => { failure = error; });
    child.once('close', (code, killed) => failure ? reject(failure) : killed ? reject(new Error('Compiler process terminated: ' + killed)) : resolve(code));
  });
}

class BuildStorage {
  constructor(io = fs) { this.fs = io; }
  safe(root, relative) {
    if (path.isAbsolute(relative) || relative.split(/[\\/]/).some(part => ['.', '..'].includes(part) || !part || /[:\x00]/.test(part))) throw new Error('Invalid build path.');
    let target = root;
    for (const part of relative.split(/[\\/]/)) {
      target = path.join(target, part);
      try { if (this.fs.lstatSync(target).isSymbolicLink()) throw new Error('Build paths must not traverse links.'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return target;
  }
  fingerprint(file, bytes) {
    if (!this.fs.existsSync(file)) return undefined;
    const stat = this.fs.statSync(file, { bigint: true });
    return { hash: hash(bytes || this.fs.readFileSync(file)),
      stamp: [stat.mtimeNs ?? stat.mtimeMs, stat.ctimeNs ?? stat.ctimeMs, stat.size].map(String).join(':') };
  }
  prepare({ root, masterFile, revision, text }) {
    root = path.resolve(root);
    if (!samePath(this.fs.realpathSync(root), root)) throw new Error('Invalid project root.');
    if (!Number.isSafeInteger(revision) || revision < 1 || typeof text !== 'string' || !text.isWellFormed()) throw new Error('缺少已提交的 Master 修订版本。');
    const base = path.basename(masterFile, '.tex');
    if (path.basename(masterFile) !== masterFile || !masterFile.endsWith('.tex') || !base || /["\r\n]/.test(base) || base.startsWith('-')) throw new Error('The managed Master must be a .tex file in the project root.');
    const master = this.safe(root, masterFile), bytes = this.fs.readFileSync(master);
    if (normalized(bytes.toString('utf8')) !== normalized(text)) throw new Error('Master 已变化，与刚 Push 的修订版本不一致，请重新编译。');
    const build = this.safe(root, '.paper-manager/build'); this.fs.mkdirSync(build, { recursive: true });
    const lock = this.safe(root, '.paper-manager/build/compile.lock');
    if (this.fs.existsSync(lock)) {
      const owner = JSON.parse(this.fs.readFileSync(lock, 'utf8'));
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error('Invalid compile lock.');
      try { process.kill(owner.pid, 0); throw new Error('A compile is already running for this project.'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; this.fs.unlinkSync(lock); }
    }
    const job = { root, base, masterFile, masterHash: hash(bytes), revision, id: randomUUID(), lock,
      previous: this.fingerprint(this.safe(root, base + '.pdf')) };
    this.fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, id: job.id }), { flag: 'wx', encoding: 'utf8' });
    return job;
  }
  assertMaster(job) {
    const bytes = this.fs.readFileSync(this.safe(job.root, job.masterFile));
    if (hash(bytes) !== job.masterHash) throw new Error('编译期间 Master 已变化，本轮结果不作有效版本，请重新编译。');
  }
  needsBibliography(job) {
    const aux = this.safe(job.root, job.base + '.aux');
    return this.fs.existsSync(aux) && /\\(?:bibdata|bibstyle|citation)\b/.test(this.fs.readFileSync(aux, 'utf8'));
  }
  finish(job, codes, problem) {
    const candidate = this.safe(job.root, job.base + '.pdf');
    const bytes = this.fs.existsSync(candidate) ? this.fs.readFileSync(candidate) : undefined;
    const current = this.fingerprint(candidate, bytes);
    const fresh = !!current && (!job.previous || current.stamp !== job.previous.stamp || current.hash !== job.previous.hash);
    const generated = !problem && fresh && completePdf(bytes);
    const result = { buildId: job.id, masterRevision: job.revision, generated,
      status: problem?.cancelled ? 'cancelled' : !generated ? 'failed' : codes.some(code => code !== 0) ? 'pdf-with-errors' : 'pdf-ready',
      exitCodes: codes, error: problem?.message || (!generated ? '本轮未生成完整的新 PDF。' : undefined), time: Date.now() };
    const metadata = this.safe(job.root, '.paper-manager/build/last-result.json');
    let previous = {};
    try { if (this.fs.existsSync(metadata)) previous = JSON.parse(this.fs.readFileSync(metadata, 'utf8')); } catch {}
    result.pdfHash = current?.hash;
    result.pdfRevision = generated ? job.revision : result.pdfHash && result.pdfHash === previous.pdfHash ? previous.pdfRevision : undefined;
    // Root outputs are left exactly as the compiler produced them, with no backup,
    // relocation or rollback. Freshness distinguishes a retained old file.
    const temporary = this.safe(job.root, '.paper-manager/build/' + job.id + '.json.tmp');
    try {
      this.fs.writeFileSync(temporary, JSON.stringify(result, null, 2) + '\n', 'utf8');
      this.fs.renameSync(temporary, metadata);
    } finally { if (this.fs.existsSync(temporary)) this.fs.unlinkSync(temporary); }
    return result;
  }
  release(job) {
    if (this.fs.existsSync(job.lock) && JSON.parse(this.fs.readFileSync(job.lock, 'utf8')).id === job.id) this.fs.unlinkSync(job.lock);
  }
}

class CompileManager {
  constructor({ storage = new BuildStorage(), run = runProcess, output, timeoutMs = 300000 } = {}) {
    this.storage = storage; this.run = run; this.output = output; this.timeoutMs = timeoutMs;
  }
  async compile(input, progress = () => {}) {
    if (this.current) throw new Error('A compile is already running.');
    this.controller = new AbortController();
    const controller = this.controller;
    this.current = this.execute(input, progress, controller);
    try { return await this.current; } finally { this.current = undefined; this.controller = undefined; }
  }
  async execute(input, progress, controller) {
    const profile = validateProfile(input.profile || require('../package.json').contributes.configuration.properties['paperReview.compileProfiles'].default.find(p => p.id === 'pdflatex-bibtex'));
    if (!profile.steps.length) return { generated: false, status: 'disabled', masterRevision: input.revision };
    await input.verifyRevision?.();
    controller.signal.throwIfAborted();
    const job = this.storage.prepare(input), codes = [];
    const steps = expandSteps(profile, job);
    let problem;
    const timer = setTimeout(() => controller.abort(new Error('编译超时。')), this.timeoutMs);
    this.output?.appendLine('Working directory: ' + job.root + '\nInput: ' + job.masterFile + '\nOutput directory: ' + job.root);
    try {
      for (let index = 0; index < steps.length; index++) {
        controller.signal.throwIfAborted();
        await input.verifyRevision?.(); this.storage.assertMaster(job);
        const { command, args, ifBibliography } = steps[index]; progress(index + 1, command, steps.length);
        if (ifBibliography && !this.storage.needsBibliography(job)) { this.output?.appendLine('No bibliography data in auxiliary file; BibTeX skipped.'); continue; }
        this.output?.appendLine('\nMaster r' + job.revision + ' · ' + command + ' (' + (index + 1) + '/' + steps.length + ')\n> ' + command + ' ' + args.join(' '));
        codes.push(await this.run(command, args, { root: job.root, signal: controller.signal, output: this.output }));
        controller.signal.throwIfAborted();
        await input.verifyRevision?.(); this.storage.assertMaster(job);
      }
    } catch (error) {
      problem = { message: controller.signal.aborted ? controller.signal.reason?.message : error.message,
        cancelled: controller.signal.aborted && controller.signal.reason?.message !== '编译超时。' };
    } finally { clearTimeout(timer); }
    try { return this.storage.finish(job, codes, problem); } finally { this.storage.release(job); }
  }
  async cancel() {
    this.controller?.abort(new Error('编译已取消。'));
    await this.current?.catch(() => {});
  }
}
module.exports = { CompileManager, BuildStorage, completePdf };
