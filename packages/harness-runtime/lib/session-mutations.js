import { executionCleanup, executionDiagnostic, checkExecutionAdmission, executionPhase, quietExecutionPhase, executionSignal, executionProgressMeter, executionProgress, withExecutionMeter, withoutExecutionDeadline, waitForExecutionQueue } from './execution-admission.js';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isUtf8 } from 'node:buffer';
import { randomUUID, createHash } from 'node:crypto';
import { git, gitTokens, changeError } from './session-changes-git.js';
import { openChangeStore, changeKey } from './session-changes-store.js';
import { safeChangePath, verifyAncestors } from './session-changes-snapshot.js';
import { withCrossProcessFileLock, writeFileAtomic } from './atomic-file.js';
import { applyMutationText, initialMutationRuns, mutationText, visibleMutationRuns } from './session-mutation-text.js';
import { inspectMutationFile, copyMutationObject, mutationFileStamp, mutationStatStamp, GRANULAR_TEXT_BYTES } from './session-mutation-files.js';
import { withExecutionIO } from './execution-io-pool.js';
import { markObjectIfUnsynced } from './object-durability.js';
import { readSessionExecutionReceipt } from './session-execution.js';
import { removeExecutionDirectory } from './execution-cleanup.js';

const key = (kind, id) => `${kind}/${changeKey(id)}.json`;
const permissions = (entry) => !entry || entry.deleted || entry.mode === '120000' ? null
  : entry.permissions ?? (entry.mode === '100755' ? 0o755 : 0o644);
const equal = (a, b) => (a?.hash ?? null) === (b?.hash ?? null) && (a?.mode ?? null) === (b?.mode ?? null)
  && permissions(a) === permissions(b);
const validID = (id) => typeof id === 'string' && id.length > 0 && id.length <= 1024 && !id.includes('\0');
const scopeFields = ['sessionID', 'messageID', 'userMessageID', 'callID'];
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
// Dependency inputs are linked read-only into views and never ingested: these
// names anywhere, plus (in Git projects) every directory Git ignores that holds
// no tracked path. An ignored standalone file such as `.env` is still ingested.
const inputDirectories = new Set(['node_modules', '.venv', '__pycache__']);
const underInput = (file, inputs) => {
  if (inputs.has(file)) return true;
  for (let parent = path.posix.dirname(file); parent !== '.'; parent = path.posix.dirname(parent)) if (inputs.has(parent)) return true;
  return false;
};
// Ledger work runs on the host event loop (in Electron, the window's main
// thread). Walks and batches yield between units so requests and input are
// served in between.
const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve));
// Per-file filesystem work overlaps its I/O latency (the per-root I/O pool
// still bounds heavy work); results keep input order and the first failure
// stops new work.
const FILE_CONCURRENCY = 8;
// Observed rows installed per ledger transaction: each install rescans the
// active paths and commits, so tiny batches make a first reconciliation
// quadratic, while the lock is held for one batch at a time.
const INSTALL_BATCH = 128;
// A first build has no records to contend with, so larger batches mean fewer
// commits; the byte bound below still caps the staged text.
const INITIAL_INSTALL_BATCH = 1024;
// Staged text runs are held in memory until the batch commits.
const INSTALL_BATCH_BYTES = 32 * 1024 * 1024;
// A background first build skips repositories with more eligible files, or
// stops after ingesting more bytes, than this; their first confined call
// builds the rest as before. At about 100 s per 5.6k files, 200k files meant
// an hour of main-thread churn. The idle gap lets a busy host breathe.
const WARM_MAX_FILES = 20_000;
const WARM_MAX_BYTES = 512 * 1024 * 1024;
const WARM_BATCH_GAP_MS = 25;
// Kill switches: set to exactly '0' to restore the previous behaviour.
const fastIngest = () => process.env.DEVRYAN_LEDGER_FAST_INGEST !== '0';
// Ledger commits write loose Git objects and plumbing never packs them. Tens
// of thousands of loose objects make every read-tree, ls-tree -l and cat-file
// pay a filesystem lookup per object: 0.6 s per commit, about ten commits per
// call, on a 5.6k-file project (a packed store answers in about 40 ms).
const LEDGER_MAINTENANCE = Object.freeze({ looseObjects: 1_000, packs: 12, commits: 64, pruneExpiry: '2.hours.ago' });
const mapBounded = async (items, fn, limit = FILE_CONCURRENCY) => {
  const results = new Array(items.length);
  let next = 0, failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try { results[index] = await fn(items[index], index); }
      catch (error) { failed = true; throw error; }
    }
  };
  const settled = await Promise.allSettled(Array.from({ length: Math.min(limit, items.length) }, worker));
  const rejected = settled.find((result) => result.status === 'rejected');
  if (rejected) throw rejected.reason;
  return results;
};

/** Durable mutation ledger; not an execution sandbox.
 * Adapters must enforce write confinement and stop every writer before finish.
 * The private Git metadata store pages histories and commits accepted intent
 * with an atomic ref update before the publication transaction writes files. */
export function createSessionMutationRuntime({ directory: storage, onChange = () => {}, onMaterialize, onDiagnostic = () => {}, maintenance: maintenanceOptions } = {}) {
  if (!path.isAbsolute(storage ?? '')) throw new TypeError('Absolute mutation storage directory is required');
  // Background failures outside any admission context (codes only).
  const diagnostic = (record) => { try { onDiagnostic(record); } catch { /* Observer only. */ } };
  const queues = new Map();
  // Packs a ledger's Git objects in the background, never under the ledger
  // lock: Git keeps concurrent readers and writers safe while it repacks, and
  // objects of in-flight transactions stay loose until their ref update.
  // Unreachable objects older than the prune grace are dropped only after a
  // consolidating repack. One run per ledger at a time; best effort.
  // Kill switch: DEVRYAN_LEDGER_PACK=0.
  const maintenanceLimits = { ...LEDGER_MAINTENANCE, ...maintenanceOptions };
  const maintenanceStates = new Map();
  const maintainLedger = (root) => {
    if (process.env.DEVRYAN_LEDGER_PACK === '0') return null;
    const state = maintenanceStates.get(root) ?? { commits: 0, running: null };
    maintenanceStates.set(root, state);
    if (state.running) return state.running;
    state.commits = 0;
    state.running = withoutExecutionDeadline(async () => {
      const gitDir = path.join(root, 'git');
      const run = (args) => git(root, ['--git-dir', gitDir, ...args], { timeoutMs: 10 * 60_000 });
      const stats = Object.fromEntries((await run(['count-objects', '-v'])).toString().trim().split('\n')
        .map((line) => line.split(': ')).map(([name, value]) => [name, Number(value)]));
      if (stats.count >= maintenanceLimits.looseObjects) await run(['repack', '-d', '-q', '--no-write-bitmap-index']);
      if ((stats.packs ?? 0) + 1 >= maintenanceLimits.packs) {
        await run(['repack', '-a', '-d', '-q', '--no-write-bitmap-index']);
        await run(['prune', `--expire=${maintenanceLimits.pruneExpiry}`]);
      }
    }).catch((cause) => {
      // Still best effort (an unpacked ledger is only slower), but visible.
      diagnostic({ phase: 'ledger_maintenance', state: 'failed', code: cause?.code ?? 'ledger_maintenance_failed' });
    })
      .finally(() => { state.running = null; });
    return state.running;
  };
  const noteLedgerCommit = (root) => {
    const state = maintenanceStates.get(root) ?? { commits: 0, running: null };
    maintenanceStates.set(root, state);
    if (++state.commits >= maintenanceLimits.commits && !state.running) setImmediate(() => maintainLedger(root));
  };
  const rootFor = (directory) => path.join(storage, changeKey(directory));
  const bytesFor = async (repo, hash) => {
    if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) throw changeError('invalid_change_record');
    const bytes = await fs.readFile(path.join(repo.root, 'objects', hash));
    if (digest(bytes) !== hash) throw changeError('invalid_change_record');
    return bytes;
  };
  const putBytes = async (repo, bytes) => {
    const hash = digest(bytes), target = path.join(repo.root, 'objects', hash);
    try { markObjectIfUnsynced(path.dirname(target), (await fs.lstat(target)).ctimeMs); }
    catch (error) { if (error.code !== 'ENOENT') throw error; await writeFileAtomic(target, bytes); }
    return hash;
  };
  const inspect = (repo, file, directory) => withExecutionIO(repo.root, () => inspectMutationFile(repo, file, directory));
  const write = async (repo, file, entry, directory = repo.directory, { durable = true } = {}) => {
    await verifyAncestors(directory, file);
    const target = path.join(directory, file);
    if (!entry) { await fs.rm(target, { force: true }); return; }
    if (entry.mode !== '120000') {
      // copyMutationObject creates the parent directory.
      await withExecutionIO(repo.root, () => copyMutationObject(repo, entry, target, permissions(entry), { durable }));
      return;
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    const bytes = await bytesFor(repo, entry.hash);
    const temporary = `${target}.devryan-${randomUUID()}`;
    try { await fs.symlink(bytes, temporary); await fs.rename(temporary, target); }
    finally { await fs.rm(temporary, { force: true }); }
  };
  const recover = async (repo) => {
    const pending = await repo.db.get('materialization.json');
    if (!pending) return;
    for await (const row of repo.db.list(`materializations/${pending.id}`)) {
      const current = await inspect(repo, row.path);
      if (equal(current, row.after)) continue;
      if (!equal(current, row.before)) throw changeError('mutation_recovery_required', 503);
      await onMaterialize?.(row);
      await write(repo, row.path, row.after);
      if (!equal(await inspect(repo, row.path), row.after)) throw changeError('mutation_recovery_required', 503);
    }
    repo.db.remove('materialization.json');
    await repo.db.commit();
  };
  // Every ledger operation resolves its repository; avoid a git spawn per call.
  // A cached answer stays valid only while the repository's `.git` entry keeps
  // its identity and no nested `.git` appears between the directory and it.
  const repositories = new Map();
  const gitMarker = async (directory) => {
    const stat = await fs.lstat(path.join(directory, '.git'), { bigint: true }).catch((cause) => {
      if (['ENOENT', 'ENOTDIR'].includes(cause.code)) return null; throw cause;
    });
    return stat ? `${stat.dev}:${stat.ino}:${stat.ctimeNs}` : null;
  };
  const cachedRepository = async (logicalDirectory) => {
    const cached = repositories.get(logicalDirectory);
    if (!cached || await gitMarker(cached.directory) !== cached.marker) return null;
    for (let current = logicalDirectory; current !== cached.directory; current = path.dirname(current)) {
      if (current === path.dirname(current) || await gitMarker(current) !== null) return null;
    }
    return cached;
  };
  const resolveRepository = async (requested) => {
    const logicalDirectory = await fs.realpath(requested);
    if (process.env.DEVRYAN_LEDGER_REPOSITORY_CACHE !== '0') {
      const cached = await cachedRepository(logicalDirectory);
      if (cached) return { logicalDirectory, directory: cached.directory, vcs: true };
    }
    let vcs = true;
    const root = await git(logicalDirectory, ['rev-parse', '--show-toplevel'], { limit: 16 * 1024 }).then((value) => value.toString(), (cause) => {
      if (cause.code !== 'capture_not_git') throw cause;
      vcs = false; return logicalDirectory;
    });
    const directory = await fs.realpath(root.endsWith('\n') ? root.slice(0, -1) : root);
    const relative = path.relative(directory, logicalDirectory);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw changeError('session_directory_mismatch');
    const marker = vcs ? await gitMarker(directory) : null;
    if (marker) {
      repositories.delete(logicalDirectory); repositories.set(logicalDirectory, { directory, marker });
      while (repositories.size > 256) repositories.delete(repositories.keys().next().value);
    }
    return { logicalDirectory, directory, vcs };
  };
  // Callers queued behind a repository's lock follow its current holder's
  // progress, so waiting behind productive work is not reported as a stall.
  const queueMeters = new Map();
  const locked = async (requested, fn, { requireExisting = false } = {}) => {
    checkExecutionAdmission();
    const { logicalDirectory, directory, vcs } = await resolveRepository(requested);
    if (requireExisting) {
      // Read-only evidence queries never create a ledger as a side effect.
      try { await fs.access(path.join(rootFor(directory), 'git', 'HEAD')); }
      catch (error) { if (error.code === 'ENOENT') return fn(null); throw error; }
    }
    const previous = queues.get(directory) ?? Promise.resolve();
    let queueMeter = queueMeters.get(directory);
    if (!queueMeter) { queueMeter = { progress: Date.now(), waiters: 0, following: undefined }; queueMeters.set(directory, queueMeter); }
    const ready = executionPhase('queue_wait', () => waitForExecutionQueue(previous.catch(() => {}), queueMeter));
    const work = ready.then(() => {
      checkExecutionAdmission();
      const lockStarted = Date.now();
      let acquired = false;
      return withCrossProcessFileLock(path.join(rootFor(directory), 'owner.lock'), () => withExecutionMeter(async () => {
        acquired = true;
        executionProgress();
        const holder = executionProgressMeter();
        queueMeter.following = holder; queueMeter.progress = Date.now();
        try { return await holdLock(); }
        finally { if (queueMeter.following === holder) queueMeter.following = undefined; queueMeter.progress = Date.now(); }
      }), { timeoutMs: 30_000, signal: executionSignal() }).catch(cause => {
        if (!acquired) executionDiagnostic({ phase: 'lock_wait', state: 'failed', elapsedMs: Date.now() - lockStarted,
          code: cause?.code === 'LOCK_TIMEOUT' ? 'local_execution_timeout' : 'local_execution_failed' });
        throw cause;
      });
      async function holdLock() {
        // Journal only contended acquisitions; every tool call takes this lock.
        const lockWaitMs = Date.now() - lockStarted;
        if (lockWaitMs >= 250) executionDiagnostic({ phase: 'lock_wait', state: 'completed', elapsedMs: lockWaitMs, slow: true });
        const root = rootFor(directory), gitDir = path.join(root, 'git');
        await fs.mkdir(root, { recursive: true, mode: 0o700 });
        try { await fs.access(path.join(gitDir, 'HEAD')); }
        catch (error) { if (error.code !== 'ENOENT') throw error; await git(root, ['init', '--bare', '--quiet', gitDir]); }
        const db = await quietExecutionPhase('ledger_open', () => openChangeStore(root, gitDir));
        const storedMeta = await db.get('meta.json');
        const originalMeta = JSON.stringify(storedMeta);
        const meta = storedMeta ?? { version: 1, directory, sequence: 0 };
        if (meta.version !== 1 || meta.directory !== directory) throw changeError('invalid_change_record');
        const repo = { directory, logicalDirectory, root, gitDir, db, meta, vcs };
        await withoutExecutionDeadline(() => quietExecutionPhase('ledger_recovery', () => recover(repo)));
        checkExecutionAdmission();
        const result = await quietExecutionPhase('ledger_transaction', () => fn(repo));
        checkExecutionAdmission();
        // A lease lookup must not stage an unchanged blob and rebuild Git's
        // index under the owner lock. Mutations still commit atomically.
        if (JSON.stringify(meta) !== originalMeta) db.set('meta.json', meta);
        const wrote = db.pendingCount > 0;
        await withoutExecutionDeadline(() => quietExecutionPhase('ledger_commit', () => db.commit()));
        if (wrote) noteLedgerCommit(root);
        return result;
      }
    });
    // An expired waiter must not replace the actual owner in the queue.
    const tail = Promise.allSettled([previous, work]).then(() => undefined);
    queues.set(directory, tail);
    try { return await work; }
    finally {
      void tail.then(() => {
        if (queues.get(directory) === tail) { queues.delete(directory); queueMeters.delete(directory); }
      });
    }
  };
  const SNAPSHOT_MISS = Symbol('snapshot-miss');
  // Lock-free answer from the last committed ledger tree. Any durable write
  // or error falls back to the locked path, which stays authoritative; this
  // only removes queueing for reads that would not change state (per-step
  // prompt registration, admission, lease and outcome lookups) behind long
  // reconciliation or publication work.
  const readSnapshot = async (requested, fn) => {
    const { logicalDirectory, directory, vcs } = await resolveRepository(requested);
    const root = rootFor(directory), gitDir = path.join(root, 'git');
    try { await fs.access(path.join(gitDir, 'HEAD')); }
    catch (error) { if (error.code === 'ENOENT') return SNAPSHOT_MISS; throw error; }
    const db = await quietExecutionPhase('ledger_snapshot', () => openChangeStore(root, gitDir));
    // A pending materialization may be unrecoverable (for example a foreign
    // edit); only the locked path can recover it or fail closed.
    if (!db.exists || await db.get('materialization.json')) return SNAPSHOT_MISS;
    const meta = await db.get('meta.json');
    if (meta?.version !== 1 || meta.directory !== directory) return SNAPSHOT_MISS;
    const repo = { directory, logicalDirectory, root, gitDir, db, meta: { ...meta }, vcs, snapshot: true };
    const result = await fn(repo);
    return db.pendingCount === 0 && repo.meta.sequence === meta.sequence ? result : SNAPSHOT_MISS;
  };
  const snapshotOrLocked = async (requested, fn, options) => {
    checkExecutionAdmission();
    let result = SNAPSHOT_MISS;
    try { result = await readSnapshot(requested, fn); }
    catch { checkExecutionAdmission(); } // The locked path reports the authoritative error.
    return result === SNAPSHOT_MISS ? locked(requested, fn, options) : result;
  };
  const next = (repo) => ++repo.meta.sequence;
  // Parsed records keyed by the immutable subtree identity they were read
  // from, so an unchanged ledger is not re-read and re-parsed on every
  // transaction. Callers mutate records, so every answer is a private copy.
  const recordCache = new Map();
  const cachedRecords = async (repo, prefix, read, copy) => {
    if (process.env.DEVRYAN_LEDGER_RECORD_CACHE === '0' || repo.db.pendingCount !== 0) return read(repo);
    const identity = await repo.db.prefixIdentity(prefix);
    if (!identity) return read(repo);
    const cacheKey = `${repo.root}\0${prefix}\0${identity}`;
    let entry = recordCache.get(cacheKey);
    if (entry) recordCache.delete(cacheKey);
    else {
      entry = read(repo);
      void entry.catch(() => { if (recordCache.get(cacheKey) === entry) recordCache.delete(cacheKey); });
    }
    recordCache.set(cacheKey, entry);
    while (recordCache.size > 8) recordCache.delete(recordCache.keys().next().value);
    return copy(await entry);
  };
  const readInactive = async (repo) => {
    const ids = new Set();
    for await (const { value } of repo.db.entries('operations')) if (!value.active || value.fileUndone) ids.add(value.id);
    return ids;
  };
  const inactive = (repo) => cachedRecords(repo, 'operations', readInactive, (ids) => new Set(ids));
  const runsFor = async (repo, id, prefix = 'runs') => {
    const runs = [];
    for await (const run of repo.db.list(`${prefix}/${id}`)) runs.push({ ...run, text: Buffer.from(run.bytes, 'base64').toString('latin1') });
    return runs;
  };
  const saveRuns = async (repo, id, runs, prefix = 'runs', options) => {
    const rows = function* () {
      for (const run of runs) {
        for (let offset = 0; offset < run.text.length; offset += 32_768) {
          const { text, bytes: _bytes, ...metadata } = run;
          yield { ...metadata, start: run.start + offset, bytes: Buffer.from(text.slice(offset, offset + 32_768), 'latin1').toString('base64') };
        }
      }
    };
    await repo.db.setList(`${prefix}/${id}`, rows(), options);
  };
  const revisionsFor = async (repo, id) => {
    const revisions = [];
    for await (const revision of repo.db.list(`revisions/${id}`)) revisions.push(revision);
    return revisions;
  };
  const projection = async (repo, doc, disabled) => {
    const all = await revisionsFor(repo, doc.id);
    const revisions = all.filter((revision) => revision.owner === null || !disabled.has(revision.owner));
    const latest = revisions.at(-1);
    if (!latest) return null;
    const name = revisions.findLast((revision) => revision.path !== undefined)?.path ?? all[0]?.path;
    const mode = revisions.findLast((revision) => revision.mode !== undefined)?.mode ?? all[0]?.mode;
    const access = revisions.findLast((revision) => revision.permissions !== undefined)?.permissions;
    if (latest.deleted) return { path: name, sequence: latest.sequence, deleted: true };
    const content = revisions.findLast((revision) => revision.hash !== undefined);
    const hash = content?.binary ? content.hash : await putBytes(repo, Buffer.from(mutationText(await runsFor(repo, doc.id), disabled), 'latin1'));
    return { path: name, mode, ...(access === undefined ? {} : { permissions: access }),
      hash, sequence: latest.sequence };
  };
  const readActivePaths = async (repo) => {
    const paths = new Map();
    for await (const { value } of repo.db.entries('files')) {
      if (value.published && (!paths.has(value.published.path)
        || (paths.get(value.published.path).published.sequence ?? 0) < (value.published.sequence ?? 0))) paths.set(value.published.path, value);
    }
    return paths;
  };
  const activePaths = (repo) => cachedRecords(repo, 'files', readActivePaths,
    (paths) => new Map([...paths].map(([file, doc]) => [file, structuredClone(doc)])));
  const recordFile = async (repo, { doc, beforeRuns, baseEntry, basePath, entry, file, operation, disabled }) => {
    // A new document's id was just generated, so it has no stored revisions
    // or runs. Skip their listings: on a large ledger each one is a Git spawn,
    // about three per file in a first build.
    const fresh = !doc && fastIngest();
    doc ??= { id: randomUUID(), published: null };
    const revisions = fresh ? [] : await revisionsFor(repo, doc.id);
    if (entry) {
      // Keep whole-content ancestry once a document crosses the threshold.
      // Earlier granular revisions retain their runs for old-reader Revert.
      let binary = entry.whole || entry.size > GRANULAR_TEXT_BYTES || revisions.some((revision) => revision.binary);
      const bytes = binary ? null : await bytesFor(repo, entry.hash);
      binary ||= entry.mode === '120000' || bytes.includes(0) || !isUtf8(bytes);
      if (!binary) {
        const before = await runsFor(repo, doc.id);
        const runs = operation === null ? initialMutationRuns(bytes.toString('latin1'), `${doc.id}:baseline`)
          : applyMutationText(before, beforeRuns ?? visibleMutationRuns(before, disabled), bytes.toString('latin1'), operation.id);
        doc.runsUnfiltered = runs.every((run) => run.deletedBy.length === 0);
        await saveRuns(repo, doc.id, runs, 'runs', { absent: fresh });
      }
      revisions.push({ owner: operation?.id ?? null, sequence: operation?.sequence ?? 0,
        ...(file !== (basePath ?? doc.published?.path) ? { path: file } : {}),
        ...(entry.mode !== (baseEntry ?? doc.published)?.mode ? { mode: entry.mode } : {}),
        ...(permissions(entry) !== permissions(baseEntry ?? doc.published) ? { permissions: permissions(entry) } : {}),
        ...(entry.hash !== (baseEntry ?? doc.published)?.hash ? { hash: entry.hash, binary } : {}), deleted: false });
    } else revisions.push({ owner: operation.id, sequence: operation.sequence, deleted: true });
    await repo.db.setList(`revisions/${doc.id}`, revisions, { absent: fresh });
    repo.db.set(key('files', doc.id), doc);
    return doc;
  };
  // Directories holding a tracked path are never inputs, whatever Git's ignore
  // rules say: their tracked files must stay observable and publishable.
  const inputClassifier = async (directory, vcs) => {
    if (!vcs) return null;
    const tracked = new Set();
    for await (const file of gitTokens(directory, ['ls-files', '-z', '--cached'])) {
      checkExecutionAdmission();
      for (let parent = path.posix.dirname(file); parent !== '.' && !tracked.has(parent); parent = path.posix.dirname(parent)) tracked.add(parent);
    }
    return { directory, tracked };
  };
  // One `git check-ignore` per tree level. Bare paths (no trailing slash) let
  // Git lstat each directory, so directory-only patterns and negations resolve
  // exactly as Git would; a trailing slash made `dir/*` match `dir/` itself.
  const ignoredAmong = async (classifier, directories) => {
    const candidates = directories.filter((directory) => !classifier.tracked.has(directory));
    if (!candidates.length) return new Set();
    const output = await git(classifier.directory, ['check-ignore', '-z', '--stdin'],
      { input: `${candidates.join('\0')}\0`, limit: 64 * 1024 * 1024, acceptExitCodes: [1] });
    return new Set(output.toString().split('\0').filter(Boolean));
  };
  // A classification failure fails a background warm; a real call falls back
  // to walking ignored directories as before (slow but complete).
  const classifierFor = async (directory, vcs, strict) => {
    try { return await inputClassifier(directory, vcs); }
    catch (cause) {
      checkExecutionAdmission();
      if (strict) throw cause;
      diagnostic({ phase: 'ledger_inputs', state: 'failed', code: cause?.code ?? 'ledger_inputs_failed' });
      return null;
    }
  };
  // External edits are their own origin. They cannot be attributed to whichever
  // agent happens to be active when a snapshot is observed. Breadth-first, so
  // each tree level classifies its directories in one Git call. `walk.inputs`
  // collects the dependency inputs found; `walk.excluded` (a view's persisted
  // inputs) is skipped without classification.
  async function* walkFiles(root, walk = {}) {
    walk.inputs ??= new Set();
    for (let level = ['']; level.length;) {
      const directories = [];
      for (const relative of level) {
        for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
          checkExecutionAdmission();
          if (entry.name === '.git' || path.resolve(root, relative, entry.name) === storage) continue;
          const file = path.posix.join(relative, entry.name);
          if (walk.excluded?.has(file)) continue;
          if (inputDirectories.has(entry.name)) { walk.inputs.add(file); continue; }
          if (entry.isDirectory()) directories.push(file);
          else yield file;
        }
        executionProgress();
      }
      let ignored = new Set();
      if (walk.classifier && directories.length) {
        try { ignored = await ignoredAmong(walk.classifier, directories); }
        catch (cause) {
          checkExecutionAdmission();
          if (walk.strict) throw cause;
          diagnostic({ phase: 'ledger_inputs', state: 'failed', code: cause?.code ?? 'ledger_inputs_failed' });
          walk.classifier = null;
        }
      }
      for (const directory of ignored) walk.inputs.add(directory);
      level = ignored.size ? directories.filter((directory) => !ignored.has(directory)) : directories;
      await yieldToEventLoop();
    }
  }
  // Ledger paths plus everything the walk found, minus anything now inside a
  // dependency input: records ingested before a directory became an input are
  // neither inspected nor installed.
  const observedNames = async (directory, paths, walk) => {
    const found = [];
    for await (const file of walkFiles(directory, walk)) if (safeChangePath(file)) found.push(file);
    const names = new Set();
    for (const file of paths.keys()) if (!underInput(file, walk.inputs)) names.add(file);
    for (const file of found) names.add(file);
    return names;
  };
  const reconcile = async (repo, selected) => {
    const paths = await activePaths(repo), disabled = await inactive(repo), walk = { inputs: new Set() };
    let names = new Set(selected ?? []);
    if (!selected) {
      walk.classifier = await classifierFor(repo.directory, repo.vcs, false);
      names = await observedNames(repo.directory, paths, walk);
    }
    let visited = 0;
    for (const file of names) {
      checkExecutionAdmission();
      if (++visited % 64 === 0) await yieldToEventLoop();
      const doc = paths.get(file), entry = await inspect(repo, file);
      if (!doc && !entry) continue;
      if (equal(doc?.published, entry)) continue;
      const operation = doc ? { id: randomUUID(), sequence: next(repo), active: true, origin: 'external', scope: null } : null;
      const changed = await recordFile(repo, { doc, entry, file, operation, disabled });
      changed.published = entry ? { ...entry, path: file, sequence: operation?.sequence ?? 0 } : null;
      repo.db.set(key('files', changed.id), changed);
      if (operation) { operation.files = [changed.id]; repo.db.set(key('operations', operation.id), operation); }
    }
    return { inputs: walk.inputs };
  };
  const observations = new Map();
  // A warm pass is a best-effort background build: one pass, budgeted, and it
  // skips files that change mid-pass. It never certifies a real call's
  // observation; a real call may wait for it, then runs or joins an
  // authoritative pass that started after its reservation.
  const observe = async (lease, { warm = false, maxFiles = Infinity, maxBytes = Infinity } = {}) => {
    const joinable = (pass) => pass && (warm || (pass.authoritative && pass.started >= lease.reservedAt));
    const previous = observations.get(lease.projectDirectory);
    if (joinable(previous)) {
      try { return await waitForExecutionQueue(previous.work, previous.progress); }
      catch { checkExecutionAdmission(); } // The observing caller may have been cancelled independently.
    }
    if (previous) await waitForExecutionQueue(previous.work.catch(() => {}), previous.progress);
    // Recheck after waiting: another reservation may have installed the next
    // sufficiently fresh pass while this caller was queued.
    const current = observations.get(lease.projectDirectory);
    if (current && current !== previous && joinable(current)) {
      try { return await waitForExecutionQueue(current.work, current.progress); }
      catch { checkExecutionAdmission(); }
    }
    const pass = { started: Date.now(), work: null, progress: executionProgressMeter(), authoritative: !warm };
    pass.work = (async () => {
      const root = rootFor(lease.projectDirectory), gitDir = path.join(root, 'git');
      let dirty, attempts = 0, installed = 0, ingestedBytes = 0, skipped = null, inputs = new Set();
      do {
        if (++attempts > 4) throw changeError('workspace_changing', 503);
        dirty = false;
        const snapshot = { directory: lease.projectDirectory, root, gitDir, db: await openChangeStore(root, gitDir) };
        // Read-only here: reuse the listing cached by immutable `files` tree identity.
        const paths = await snapshotPaths(snapshot);
        const walk = { classifier: await classifierFor(snapshot.directory, lease.vcs !== false, warm), strict: warm, inputs: new Set() };
        const names = await observedNames(snapshot.directory, paths, walk);
        inputs = walk.inputs;
        if (names.size > maxFiles) { skipped = 'too-large'; break; }
        const fast = fastIngest(), batchRows = fast && paths.size === 0 ? INITIAL_INSTALL_BATCH : INSTALL_BATCH;
        // The walk just listed these directories; each is checked for symlinks
        // once per pass instead of once per file below it. Advisory only: the
        // install below re-stamps every changed file without this memo.
        const ancestors = process.env.DEVRYAN_LEDGER_ANCESTOR_MEMO === '0' ? undefined : new Set();
        let rows = [], rowBytes = 0, carried = null;
        const install = async () => {
          if (!rows.length) return;
          let written = null;
          await locked(lease.directory, async (repo) => {
            // While no other writer has committed since this pass's previous
            // batch, its parsed state is still exact; re-reading every record
            // per batch made a first build quadratic.
            const reuse = carried && repo.db.tree === carried.tree;
            const latest = reuse ? carried.latest : await activePaths(repo), disabled = reuse ? carried.disabled : await inactive(repo);
            for (const row of rows) {
              const doc = latest.get(row.file);
              if (JSON.stringify(doc?.published ?? null) !== JSON.stringify(row.published)
                || await mutationFileStamp(repo.directory, row.file) !== (row.entry?.observation ?? null)) { dirty = true; continue; }
              if (equal(doc?.published, row.entry)) {
                if (doc?.published && row.entry) { doc.published = { ...doc.published, ...row.entry }; repo.db.set(key('files', doc.id), doc); }
                continue;
              }
              const operation = doc ? { id: randomUUID(), sequence: next(repo), active: true, origin: 'external', scope: null } : null;
              const changed = await recordFile(repo, { doc, entry: row.entry, file: row.file, operation, disabled });
              changed.published = row.entry ? { ...row.entry, path: row.file, sequence: operation?.sequence ?? 0 } : null;
              repo.db.set(key('files', changed.id), changed);
              if (changed.published) latest.set(row.file, changed); else latest.delete(row.file);
              if (operation) { operation.files = [changed.id]; repo.db.set(key('operations', operation.id), operation); }
              executionProgress();
            }
            written = { db: repo.db, latest, disabled };
          });
          // The store's tree is the one this batch committed (or read, if it
          // changed nothing); the next batch reuses state only from that tree.
          carried = fast && written ? { tree: written.db.tree, latest: written.latest, disabled: written.disabled } : null;
          executionProgress();
          installed += rows.length;
          rows = []; rowBytes = 0;
          if (warm) await new Promise((resolve) => setTimeout(resolve, WARM_BATCH_GAP_MS));
        };
        const ordered = [...names];
        for (let start = 0; start < ordered.length && !skipped; start += 64) {
          await yieldToEventLoop();
          const observed = await mapBounded(ordered.slice(start, start + 64), async (file) => {
            checkExecutionAdmission();
            const published = paths.get(file)?.published ?? null;
            // Advisory only. Publication and projection always inspect affected
            // current bytes again; legacy records have no observation and rehash.
            if (published?.observation && await mutationFileStamp(snapshot.directory, file, ancestors) === published.observation) {
              executionProgress();
              return null;
            }
            try { return { file, published, entry: await inspect(snapshot, file) }; }
            catch (cause) { if (cause.code !== 'observation_changed') throw cause; dirty = true; return null; }
          });
          for (const row of observed) {
            if (!row || (!row.published && !row.entry)) continue;
            rows.push(row);
            // Only granular text is staged in memory; whole-content files are not.
            rowBytes += row.entry && !row.entry.whole ? row.entry.size : 0;
            ingestedBytes += row.entry?.size ?? 0;
            if (rows.length >= batchRows || rowBytes >= INSTALL_BATCH_BYTES) await install();
            if (ingestedBytes > maxBytes) { skipped = 'too-large'; break; }
          }
        }
        await install();
      } while (dirty && !warm && !skipped);
      // Marks that a background build is not to be repeated: a completed pass,
      // or one that met the warm budget (the first real call builds the rest).
      await fs.writeFile(path.join(root, 'observed'), '');
      // A large first build leaves one loose object per record: pack now.
      if (installed >= maintenanceLimits.looseObjects) void maintainLedger(root);
      return { inputs: [...inputs].sort(), ...(skipped ? { skipped } : {}) };
    })();
    observations.set(lease.projectDirectory, pass);
    try { return await pass.work; }
    finally { if (observations.get(lease.projectDirectory) === pass) observations.delete(lease.projectDirectory); }
  };
  // `fence(path)` withholds documents inside dependency inputs from history
  // replay: the ledger no longer observes those paths, so writing old content
  // there could overwrite an unrecorded edit. Their records stay unchanged.
  const materialize = async (repo, documents, accept, { fence } = {}) => {
    const disabled = await inactive(repo), paths = new Set();
    for (const doc of documents) {
      if (fence && doc.published && fence(doc.published.path)) continue;
      const after = await projection(repo, doc, disabled);
      if (fence && after && fence(after.path)) continue;
      if (doc.published) paths.add(doc.published.path);
      if (after) paths.add(after.path);
      doc.published = after;
      repo.db.set(key('files', doc.id), doc);
    }
    const rows = [], winners = await activePaths(repo);
    for (const file of paths) {
      const winner = winners.get(file)?.published;
      const after = winner?.deleted ? null : winner ?? null;
      const before = await inspect(repo, file);
      if (!equal(before, after)) rows.push({ path: file, before, after });
    }
    if (rows.length) {
      const id = randomUUID();
      await repo.db.setList(`materializations/${id}`, rows);
      repo.db.set('materialization.json', { id });
    }
    const files = rows.map((row) => ({ path: row.path, status: !row.before ? 'added' : !row.after ? 'deleted' : 'modified' }));
    // Commit the result and decision in the same durable intent as its writes.
    // Recovery must not rediscover an empty diff and lose the original receipt.
    await accept?.(files);
    repo.db.set('meta.json', repo.meta);
    await repo.db.commit();
    await recover(repo);
    return files;
  };
  const register = async (repo, input) => {
    if (!validID(input.sessionID) || !validID(input.userMessageID)) throw changeError('invalid_capture_identity', 400);
    const sessionKey = key('sessions', input.sessionID);
    let session = await repo.db.get(sessionKey);
    if (!session) session = { id: input.sessionID, parentID: input.parentID ?? null, generation: 0, pending: null };
    if (session.directory && session.directory !== repo.logicalDirectory) throw changeError('session_directory_mismatch');
    session.directory = repo.logicalDirectory;
    if (input.parentID && session.parentID && input.parentID !== session.parentID) throw changeError('capture_identity_mismatch');
    session.parentID ??= input.parentID ?? null;
    const visited = new Set([session.id]);
    const origins = {};
    let child = session;
    for (let parentID = session.parentID; parentID;) {
      if (visited.has(parentID)) throw changeError('invalid_session_lineage');
      visited.add(parentID);
      const parent = await repo.db.get(key('sessions', parentID));
      if (!parent) throw changeError('mutation_parent_unavailable');
      if (parent.pending) throw changeError('session_reverting');
      const parentGeneration = input.parentGeneration ?? session.parentGeneration;
      if (parentID === session.parentID && (parentGeneration !== undefined || parent.generation > 0)
        && parentGeneration !== parent.generation) throw changeError('execution_reverted');
      if (child.parentCallID) {
        const call = await repo.db.get(key('calls', `${parentID}\0${child.parentCallID}`));
        const lease = call && await repo.db.get(key('leases', call.token));
        if (!lease) throw changeError('mutation_history_unavailable');
        origins[parentID] = lease.promptSequence;
      }
      child = parent;
      parentID = parent.parentID;
    }
    const promptKey = key('prompts', `${input.sessionID}\0${input.userMessageID}`);
    let prompt = await repo.db.get(promptKey);
    if (prompt?.reverted) throw changeError('execution_reverted');
    if (!prompt) {
      if (session.pending) throw changeError('session_reverting');
      // Native providers discard reverted suffixes on the next prompt. Do not
      // offer a file redo whose corresponding conversation can no longer return.
      for (const rootSessionID of visited) {
        repo.db.remove(key('last-redos', rootSessionID));
        const lastKey = key('last-reverts', rootSessionID);
        const last = await repo.db.get(lastKey);
        for (const transactionID of last?.ids ?? []) {
          const tx = await repo.db.get(key('transactions', transactionID));
          if (tx?.targets.some((target) => target.id === session.id)) { repo.db.remove(lastKey); break; }
        }
      }
      prompt = { sessionID: input.sessionID, messageID: input.userMessageID, sequence: next(repo), origins };
      repo.db.set(promptKey, prompt);
    }
    repo.db.set(sessionKey, session);
    return { session, prompt };
  };
  const registerPrompt = (input) => snapshotOrLocked(input.directory, async (repo) => {
    const { prompt } = await register(repo, input);
    return { sequence: prompt.sequence };
  });
  const assertAdmission = (input) => snapshotOrLocked(input.directory, async (repo) => {
    if (!validID(input.sessionID)) throw changeError('invalid_capture_identity', 400);
    let session = await repo.db.get(key('sessions', input.sessionID));
    if (session?.directory && session.directory !== repo.logicalDirectory) throw changeError('session_directory_mismatch');
    const seen = new Set();
    while (session) {
      if (seen.has(session.id)) throw changeError('invalid_session_lineage');
      seen.add(session.id);
      if (session.pending) throw changeError('session_reverting');
      session = session.parentID ? await repo.db.get(key('sessions', session.parentID)) : null;
    }
    return { admitted: true };
  });
  const reserve = async (input) => {
    if (!scopeFields.every((field) => validID(input[field]))) throw changeError('invalid_capture_identity', 400);
    if (input.executionFingerprint !== undefined && !/^[a-f0-9]{64}$/.test(input.executionFingerprint)) {
      throw changeError('invalid_capture_identity', 400);
    }
    return locked(input.directory, async (repo) => {
      const { session, prompt } = await register(repo, input);
      if (session.pending) throw changeError('session_reverting');
      const scopeKey = `${input.sessionID}\0${input.callID}`;
      if (await repo.db.get(key('cancelled-calls', scopeKey))) throw changeError('execution_cancelled');
      const existing = await repo.db.get(key('calls', scopeKey));
      if (existing) {
        const old = await repo.db.get(key('leases', existing.token));
        if (!old || scopeFields.some((field) => old.scope[field] !== input[field])
          || old.parentCallID !== (input.parentCallID ?? null)
          || old.executionFingerprint !== input.executionFingerprint
          || (old.preparation === 'none') !== (input.kind === 'control')) throw changeError('capture_identity_mismatch');
        if (['preparing', 'published', 'ready'].includes(old.state)) return old;
        throw changeError('execution_cancelled');
      }
      const control = input.kind === 'control';
      const token = randomUUID(), viewDirectory = path.join(repo.root, 'views', token, 'worktree');
      const scope = Object.fromEntries(scopeFields.map((field) => [field, input[field]]));
      const result = { token, scope, directory: repo.logicalDirectory, projectDirectory: repo.directory,
        auxiliaryDirectory: path.join(repo.root, 'context-cache'),
        workingDirectory: path.join(viewDirectory, path.relative(repo.directory, repo.logicalDirectory)),
        generation: session.generation, baseSequence: repo.meta.sequence,
        vcs: repo.vcs,
        origins: prompt.origins,
        promptSequence: prompt.sequence, viewDirectory, state: 'preparing', parentCallID: input.parentCallID ?? null,
        executionFingerprint: input.executionFingerprint, reservedAt: Date.now(),
        ...(input.ownerID ? { ownerID: input.ownerID } : {}), ...(control ? { preparation: 'none' } : {}) };
      repo.db.set(key('leases', token), result);
      repo.db.set(key('calls', scopeKey), { token });
      return result;
    });
  };
  // Read-only callers share one parsed listing per immutable `files` tree;
  // they never mutate these records, so no copy is made.
  // Direct receipts for built-in read, glob, grep and skill (read-only by audit;
  // see companion/SEAMS.md). Admission is a snapshot read with no commit, the
  // tool runs in the control process, and `finishDirect` then records the
  // reservation and its publication in one locked commit, fenced by the
  // admitted generation and by cancellation, idempotent per (session, call).
  // Nothing is recorded before the read: a crash in between leaves the call
  // `uncertain`, exactly as a missing lease does today.
  const admitDirect = (input) => snapshotOrLocked(input.directory, async (repo) => {
    if (!scopeFields.every((field) => validID(input[field]))) throw changeError('invalid_capture_identity', 400);
    let session = await repo.db.get(key('sessions', input.sessionID));
    if (session?.directory && session.directory !== repo.logicalDirectory) throw changeError('session_directory_mismatch');
    const generation = session?.generation ?? 0;
    for (const seen = new Set(); session; session = session.parentID ? await repo.db.get(key('sessions', session.parentID)) : null) {
      if (seen.has(session.id)) throw changeError('invalid_session_lineage');
      seen.add(session.id);
      if (session.pending) throw changeError('session_reverting');
    }
    const scopeKey = `${input.sessionID}\0${input.callID}`;
    if (await repo.db.get(key('cancelled-calls', scopeKey))) throw changeError('execution_cancelled');
    if (await repo.db.get(key('calls', scopeKey))) throw changeError('execution_already_started');
    return { generation };
  });
  const finishDirect = (input) => {
    if (!scopeFields.every((field) => validID(input[field])) || !/^[a-f0-9-]{36}$/.test(input.token ?? '')
      || !Number.isSafeInteger(input.generation) || !/^[a-f0-9]{64}$/.test(input.executionFingerprint ?? '')) {
      return Promise.reject(changeError('invalid_capture_identity', 400));
    }
    return locked(input.directory, async (repo) => {
      const scopeKey = `${input.sessionID}\0${input.callID}`;
      const existing = await repo.db.get(key('calls', scopeKey));
      if (existing) {
        const lease = await repo.db.get(key('leases', existing.token));
        // A retried finish after a lost response returns the same receipt.
        if (lease?.direct && lease.token === input.token && lease.executionFingerprint === input.executionFingerprint
          && scopeFields.every((field) => lease.scope[field] === input[field])) return lease.result;
        throw changeError('capture_identity_mismatch');
      }
      if (await repo.db.get(key('cancelled-calls', scopeKey))) throw changeError('execution_cancelled');
      const { session, prompt } = await register(repo, input);
      if (session.pending) throw changeError('session_reverting');
      if (session.generation !== input.generation) throw changeError('execution_reverted');
      const baseSequence = repo.meta.sequence;
      const scope = Object.fromEntries(scopeFields.map((field) => [field, input[field]]));
      const operation = { id: randomUUID(), sequence: next(repo), scope, parentCallID: input.parentCallID ?? null,
        promptSequence: prompt.sequence, origins: prompt.origins, active: true, origin: 'execution', files: [], baseSequence };
      repo.db.set(key('operations', operation.id), operation);
      const lease = { token: input.token, scope, directory: repo.logicalDirectory, projectDirectory: repo.directory,
        generation: session.generation, baseSequence, vcs: repo.vcs, origins: prompt.origins, promptSequence: prompt.sequence,
        state: 'published', parentCallID: input.parentCallID ?? null, executionFingerprint: input.executionFingerprint,
        reservedAt: Date.now(), preparation: 'none', executionKind: 'control', direct: true, cleaned: true, cleanupPending: false,
        ...(input.ownerID ? { ownerID: input.ownerID } : {}),
        result: { operationID: operation.id, sequence: operation.sequence, files: [] } };
      repo.db.set(key('leases', lease.token), lease);
      repo.db.set(key('calls', scopeKey), { token: lease.token });
      return lease.result;
    });
  };
  const snapshotPaths = (repo) => process.env.DEVRYAN_LEDGER_SNAPSHOT_REUSE === '0'
    ? readActivePaths(repo) : cachedRecords(repo, 'files', readActivePaths, (paths) => paths);
  const preparations = new Map();
  const prepare = (lease) => {
    if (lease.state === 'ready' || lease.state === 'published') return Promise.resolve(lease);
    if (preparations.has(lease.token)) return preparations.get(lease.token);
    const work = prepareView(lease).catch(async (cause) => {
      preparations.delete(lease.token);
      await executionCleanup(() => cleanupLease({ directory: lease.directory, token: lease.token })).catch(() => {});
      throw cause;
    }).finally(() => { preparations.delete(lease.token); });
    preparations.set(lease.token, work);
    return work;
  };
  const prepareView = async (lease) => {
    try {
      await fs.mkdir(lease.viewDirectory, { recursive: true, mode: 0o700 });
      if (lease.preparation === 'none') {
        await fs.mkdir(lease.workingDirectory, { recursive: true, mode: 0o700 });
        return await locked(lease.directory, async (repo) => {
          const current = await repo.db.get(key('leases', lease.token));
          if (current?.state !== 'preparing') throw changeError('execution_cancelled');
          const session = await repo.db.get(key('sessions', lease.scope.sessionID));
          if (session?.generation !== lease.generation || session.pending) throw changeError('execution_reverted');
          lease.state = 'ready'; repo.db.set(key('leases', lease.token), lease); return lease;
        });
      }
      const { inputs } = await executionPhase('reconciliation', () => observe(lease));
      await locked(lease.directory, async (repo) => {
        const current = await repo.db.get(key('leases', lease.token));
        const session = await repo.db.get(key('sessions', lease.scope.sessionID));
        if (current?.state !== 'preparing') throw changeError('execution_cancelled');
        if (session?.generation !== lease.generation || session.pending) throw changeError('execution_reverted');
        lease.baseSequence = repo.meta.sequence;
        // Classified from the project, never from the agent-editable view:
        // publication skips exactly these paths.
        lease.inputs = inputs;
        lease.snapshotRef = repo.db.leaseRef(lease.token);
        // Base runs are recomputed from this pinned, immutable snapshot at
        // publication, for changed files only, instead of being copied per file.
        if (process.env.DEVRYAN_LAZY_BASE_RUNS !== '0') lease.lazyBaseRuns = true;
        repo.db.set(key('leases', lease.token), lease);
        // pin commits the identity before installing the ref, closing the
        // crash window between ref creation and its durable association.
        await repo.db.pin(lease.token);
      });
      // Materialization uses immutable objects captured under the publication
      // lock; commands and copying do not hold that lock.
      const root = rootFor(lease.projectDirectory), db = await openChangeStore(root, path.join(root, 'git'), { ref: lease.snapshotRef });
      const repo = { root, directory: lease.projectDirectory, db }, disabled = await inactive(repo);
      const inputSet = new Set(lease.inputs);
      const base = async function* () {
        const live = [...await snapshotPaths(repo)].filter(([file, doc]) => !doc.published.deleted && !underInput(file, inputSet));
        for (let start = 0; start < live.length; start += 64) {
          // Copies overlap; ledger rows stay sequential and ordered.
          const identities = await mapBounded(live.slice(start, start + 64), async ([file, doc]) => {
            checkExecutionAdmission();
            await write(repo, file, doc.published, lease.viewDirectory, { durable: false });
            const stat = await fs.lstat(path.join(lease.viewDirectory, file), { bigint: true });
            // The full stamp lets publication reuse this entry for an untouched file.
            return { identity: `${stat.dev}:${stat.ino}`, stamp: mutationStatStamp(stat) };
          });
          for (const [index, [file, doc]] of live.slice(start, start + 64).entries()) {
            if (lease.lazyBaseRuns) { /* derived from the pinned snapshot at publication */ }
            else if (!disabled.size && doc.runsUnfiltered) await db.importPrefix(db.tree, `runs/${doc.id}`, `bases/${lease.token}/${doc.id}`);
            else await saveRuns(repo, doc.id, visibleMutationRuns(await runsFor(repo, doc.id), disabled), `bases/${lease.token}`);
            yield { path: file, documentID: doc.id, entry: doc.published, ...identities[index] };
          }
        }
      };
      await db.setList(`bases/${lease.token}/files`, base());
      await db.commit();
      noteLedgerCommit(root);
      await git(lease.viewDirectory, ['init', '--quiet']);
      if (lease.vcs) {
        // Git commands can inspect the real revision and staged state without
        // gaining write access to the original metadata or object database.
        const common = (await git(lease.projectDirectory, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).toString().trim();
        const metadata = (await git(lease.projectDirectory, ['rev-parse', '--absolute-git-dir'])).toString().trim();
        if (/[\r\n]/.test(common)) throw changeError('invalid_execution_path');
        await fs.mkdir(path.join(lease.viewDirectory, '.git', 'objects', 'info'), { recursive: true });
        await fs.writeFile(path.join(lease.viewDirectory, '.git', 'objects', 'info', 'alternates'), path.join(common, 'objects') + '\n');
        const head = await git(lease.projectDirectory, ['rev-parse', '--verify', 'HEAD']).then((value) => value.toString().trim(), () => null);
        if (head) await git(lease.viewDirectory, ['update-ref', 'HEAD', head]);
        try { await fs.copyFile(path.join(metadata, 'index'), path.join(lease.viewDirectory, '.git', 'index')); }
        catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
      }
      // The execution launcher must enforce read-only access to this input.
      // A symlink and a private cwd alone do not provide write confinement.
      for (const file of lease.inputs) {
        checkExecutionAdmission();
        await verifyAncestors(lease.viewDirectory, file);
        const target = path.join(lease.viewDirectory, file);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.symlink(path.join(lease.projectDirectory, file), target, 'dir');
      }
      await fs.mkdir(lease.workingDirectory, { recursive: true });
      return await locked(lease.directory, async (current) => {
        if ((await current.db.get(key('leases', lease.token)))?.state === 'cancelled') throw changeError('execution_cancelled');
        const session = await current.db.get(key('sessions', lease.scope.sessionID));
        if (session.generation !== lease.generation || session.pending) throw changeError('execution_reverted');
        if (!lease.lazyBaseRuns) await current.db.importPrefix(db.tree, `bases/${lease.token}`);
        lease.state = 'ready'; current.db.set(key('leases', lease.token), lease); return lease;
      });
    } catch (error) {
      // This method has not admitted a writer. A failed/cancelled copy must not
      // leave an immortal preparing lease that later recovery cannot attest.
      await executionCleanup(() => locked(lease.directory, async (repo) => {
        const current = await repo.db.get(key('leases', lease.token));
        if (current?.state === 'preparing') { current.state = 'cancelled'; current.cleanupPending = true; repo.db.set(key('leases', lease.token), current); }
      })).catch(() => {});
      throw error;
    }
  };
  // Builds a missing ledger ahead of the first confined call (95-105 s on a
  // 5.6k-file repository). The caller bounds it (one build at a time, cancelled
  // with its signal); batches already committed are kept and resumed. A real
  // call arriving meanwhile queues behind this pass and then stamps quickly.
  // Ownership is unchanged: every observation outside a lease stays external.
  const warm = async ({ directory, maxFiles = WARM_MAX_FILES, maxBytes = WARM_MAX_BYTES }) => {
    checkExecutionAdmission();
    const { logicalDirectory, directory: projectDirectory, vcs } = await resolveRepository(directory);
    if (!vcs) return { skipped: 'not-git' };
    if (projectDirectory === await fs.realpath(os.homedir()).catch(() => os.homedir())) return { skipped: 'home-directory' };
    try { await fs.access(path.join(rootFor(projectDirectory), 'observed')); return { skipped: 'already-built' }; }
    catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
    // A cheap lower bound (tracked plus untracked, non-ignored files) before
    // walking; the pass enforces the exact eligible count. A budget that
    // cannot be established skips the background build.
    const listing = await git(projectDirectory, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { limit: 64 * 1024 * 1024 }).catch(() => null);
    if (!listing) return { skipped: 'listing-unavailable' };
    let files = 0;
    for (const byte of listing) if (byte === 0 && ++files > maxFiles) return { skipped: 'too-large' };
    // Creates the ledger root and store exactly as a reservation would.
    await locked(logicalDirectory, async () => {});
    const started = Date.now();
    const result = await observe({ directory: logicalDirectory, projectDirectory, vcs, reservedAt: Date.now() }, { warm: true, maxFiles, maxBytes });
    if (result.skipped) return { skipped: result.skipped };
    return { built: true, files, elapsedMs: Date.now() - started };
  };
  const begin = async (input) => {
    const lease = await reserve(input);
    if (lease.state === 'preparing' && preparations.has(lease.token)) throw changeError('execution_already_started');
    return prepare(lease);
  };
  const finishOwned = async ({ directory, token, renames = [] }) => {
    const captured = await locked(directory, (repo) => repo.db.get(key('leases', token)));
    if (!captured) throw changeError('execution_unavailable');
    if (captured.state === 'published') return captured.result;
    if (captured.state !== 'ready') throw changeError('execution_not_ready');
    const base = new Map(), identities = new Map(), files = new Map(), ignoredInputs = [];
    let snapshot = null, snapshotInactive = null;
    // Exactly the runs the view was materialized from: the pinned snapshot's
    // runs filtered by the operations inactive in that same snapshot.
    const baseRuns = async (repo, documentID) => {
      if (!captured.lazyBaseRuns) return runsFor(repo, documentID, `bases/${token}`);
      snapshotInactive ??= await inactive(snapshot);
      return visibleMutationRuns(await runsFor(snapshot, documentID), snapshotInactive);
    };
    if (captured.preparation !== 'none') {
      const root = rootFor(captured.projectDirectory), db = await openChangeStore(root, path.join(root, 'git'),
        captured.snapshotRef ? { ref: captured.snapshotRef } : {});
      const repo = { root, directory: captured.projectDirectory };
      snapshot = { root, directory: captured.projectDirectory, db };
      for await (const file of db.list(`bases/${token}/files`)) { base.set(file.path, file); if (file.identity) identities.set(file.identity, file); }
      // The host has verified native termination before calling finish. Hashing
      // this immutable output does not serialize unrelated project admissions.
      const viewFiles = [];
      // Dependency inputs persisted at preparation are never outputs, even if
      // the agent replaced the read-only link. Leases prepared before inputs
      // were persisted keep the name-only rule.
      const excluded = Array.isArray(captured.inputs) ? new Set(captured.inputs) : null;
      for await (const file of walkFiles(captured.viewDirectory, { excluded })) if (safeChangePath(file)) viewFiles.push(file);
      for (const file of excluded ?? []) {
        const stat = await fs.lstat(path.join(captured.viewDirectory, file)).catch((cause) => {
          if (['ENOENT', 'ENOTDIR'].includes(cause.code)) return null; throw cause;
        });
        if (stat && !stat.isSymbolicLink()) ignoredInputs.push(file);
      }
      // An untouched view file keeps its materialization stamp (inode, size,
      // mode and nanosecond mtime/ctime): any write, chmod or replacement moves
      // ctime or the inode. Whole-second ctimes cannot rule out a same-tick
      // write (git's racy-clean case), so those files are always re-hashed.
      const reuse = process.env.DEVRYAN_VIEW_STAT_REUSE !== '0';
      const precise = (value) => typeof value === 'string' && value.split(':')[4] !== undefined && !value.split(':')[4].endsWith('000000000');
      const entries = await mapBounded(viewFiles, async (file) => {
        const row = base.get(file);
        // The walk descends only real directories and every writer has
        // terminated, so the file's own lstat is sufficient here.
        if (reuse && row?.stamp && precise(row.stamp) && mutationStatStamp(await fs.lstat(path.join(captured.viewDirectory, file), { bigint: true })
          .catch((cause) => { if (['ENOENT', 'ENOTDIR'].includes(cause.code)) return null; throw cause; })) === row.stamp) return row.entry;
        return inspect(repo, file, captured.viewDirectory);
      });
      viewFiles.forEach((file, index) => files.set(file, entries[index]));
      for (const file of base.keys()) if (!files.has(file)) files.set(file, null);
    }
    const result = await locked(directory, async (repo) => {
      const lease = await repo.db.get(key('leases', token));
      if (!lease) throw changeError('execution_unavailable');
      if (lease.state === 'published') return lease.result;
      const session = await repo.db.get(key('sessions', lease.scope.sessionID));
      if (session.generation !== lease.generation || session.pending) throw changeError('execution_reverted');
      if (lease.state !== 'ready') throw changeError('execution_not_ready');
      if (lease.preparation === 'none') {
        if (lease.executionKind !== 'control') throw changeError('execution_not_ready');
        const operation = { id: randomUUID(), sequence: next(repo), scope: lease.scope, parentCallID: lease.parentCallID,
          promptSequence: lease.promptSequence, origins: lease.origins, active: true, origin: 'execution', files: [], baseSequence: lease.baseSequence };
        repo.db.set(key('operations', operation.id), operation);
        lease.state = 'published'; lease.cleanupPending = true; lease.result = { operationID: operation.id, sequence: operation.sequence, files: [] };
        repo.db.set(key('leases', token), lease);
        return lease.result;
      }
      const touched = [...new Set([...base.keys(), ...files.keys()])].filter((file) => !equal(base.get(file)?.entry, files.get(file)));
      await reconcile(repo, touched);
      const renamed = new Map(), sources = new Set();
      if (!Array.isArray(renames)) throw changeError('invalid_rename_receipt');
      for (const move of renames) {
        if (!safeChangePath(move?.from) || !safeChangePath(move?.to) || move.from === move.to
          || sources.has(move.from) || renamed.has(move.to) || !base.has(move.from)
          || files.get(move.from) || !files.get(move.to)) throw changeError('invalid_rename_receipt');
        sources.add(move.from); renamed.set(move.to, base.get(move.from));
      }
      const operation = { id: randomUUID(), sequence: next(repo), scope: lease.scope, parentCallID: lease.parentCallID,
        promptSequence: lease.promptSequence, origins: lease.origins,
        active: true, origin: 'execution', files: [], baseSequence: lease.baseSequence };
      const changed = new Map(), moved = new Set(), disabled = await inactive(repo), conflicts = [];
      // Read-only; the tree-identity cache applies only without pending writes.
      const published = repo.db.pendingCount === 0 ? await snapshotPaths(repo) : await activePaths(repo);
      const conflict = async (file, from, entry, doc) => {
        const before = from?.entry ?? null, current = doc?.published?.deleted ? null : doc?.published ?? null;
        const changesContent = (before?.hash ?? null) !== (entry?.hash ?? null);
        const changesMode = permissions(before) !== permissions(entry);
        const whole = entry?.whole || before?.whole || (doc && (await revisionsFor(repo, doc.id)).some((revision) => revision.binary));
        const sourceMoved = from && from.path !== file && current?.path !== from.path;
        const destination = published.get(file)?.published;
        const destinationTaken = from && from.path !== file && destination && destination.path !== current?.path;
        if (!(sourceMoved || destinationTaken
          || changesContent && (whole || !entry) && (current?.hash ?? null) !== (before?.hash ?? null) && current?.hash !== entry?.hash
          || changesMode && permissions(current) !== permissions(before) && permissions(current) !== permissions(entry))) return false;
        const value = { path: file, base: before, current, proposed: entry, ...(from && from.path !== file ? { source: from.path } : {}) };
        conflicts.push(value);
        return true;
      };
      for (const [file, entry] of files) {
        let from = renamed.get(file) ?? base.get(file);
        if (renamed.has(file)) moved.add(from.path);
        if (!from && entry) {
          const candidate = identities.get(entry.identity);
          if (candidate && !files.get(candidate.path)) { from = candidate; moved.add(candidate.path); }
        }
        if (from?.path === file && equal(from.entry, entry) || !from && !entry) continue;
        if (!entry) continue;
        const doc = from ? await repo.db.get(key('files', from.documentID)) : null;
        if (await conflict(file, from, entry, doc ?? published.get(file))) continue;
        const updated = await recordFile(repo, { doc, entry, file, operation, disabled, baseEntry: from?.entry, basePath: from?.path,
          beforeRuns: from ? await baseRuns(repo, from.documentID) : [] });
        changed.set(updated.id, updated);
      }
      for (const [file, from] of base) {
        if (files.get(file) || moved.has(file)) continue;
        const doc = await repo.db.get(key('files', from.documentID));
        if (await conflict(file, from, null, doc)) continue;
        const updated = await recordFile(repo, { doc, entry: null, file, operation, disabled });
        changed.set(updated.id, updated);
      }
      operation.files = [...changed.keys()];
      if (conflicts.length) {
        // Old readers project every normal revision. Conflicting proposals must
        // therefore live outside that prefix, with objects retained by receipt.
        operation.conflicts = `conflicts/${token}`;
        await repo.db.setList(operation.conflicts, conflicts);
      }
      const rejected = new Set(conflicts.flatMap((row) => [row.path, ...(row.source ? [row.source] : [])]));
      const receipt = [];
      for (const file of new Set([...base.keys(), ...files.keys()])) {
        const before = base.get(file)?.entry ?? null, after = files.get(file) ?? null;
        if (!rejected.has(file) && !equal(before, after)) receipt.push({ path: file, before, after });
      }
      await repo.db.setList(`publications/${token}/files`, receipt);
      repo.db.set(key('operations', operation.id), operation);
      await materialize(repo, [...changed.values()], (files) => {
        lease.state = 'published'; lease.cleanupPending = true; lease.result = { operationID: operation.id, sequence: operation.sequence, files,
          ...(conflicts.length ? { outcome: 'partial', conflicts: conflicts.map(({ path, source }) => ({ path, ...(source ? { source } : {}) })) } : {}),
          ...(ignoredInputs.length ? { ignoredInputs } : {}) };
        repo.db.set(key('leases', token), lease);
      });
      return lease.result;
    });
    await onChange({ directory, ...result });
    return result;
  };
  const settlements = new Map();
  const finish = (input) => {
    if (settlements.has(input.token)) return settlements.get(input.token);
    const work = finishOwned(input).finally(() => settlements.delete(input.token));
    settlements.set(input.token, work); return work;
  };
  const cleanupLease = async (input) => {
    if (preparations.has(input.token) || settlements.has(input.token)) return false;
    const lease = await locked(input.directory, async (repo) => {
      const lease = await repo.db.get(key('leases', input.token));
      if (!lease || lease.cleaned || !['published', 'cancelled'].includes(lease.state)) return null;
      if (lease.executionKind === 'process' && !lease.cancelledBeforeStart) await readSessionExecutionReceipt(lease);
      else if (lease.state === 'published' && lease.executionKind !== 'control') return null;
      return lease;
    });
    if (!lease) return false;
    // The parent holds termination.json. It is recovery evidence, not scratch.
    await removeExecutionDirectory(lease.viewDirectory);
    await removeExecutionDirectory(path.join(path.dirname(lease.viewDirectory), 'scratch'));
    await locked(input.directory, async (repo) => {
      // Deterministic ref identity also recovers pins from older crash windows.
      await repo.db.release(lease.token);
      for await (const { key: page } of repo.db.entries(`bases/${lease.token}`)) repo.db.remove(page);
      const current = await repo.db.get(key('leases', lease.token));
      current.cleaned = true; current.cleanupPending = false; repo.db.set(key('leases', lease.token), current);
    });
    return true;
  };
  const prepareRevert = (input) => locked(input.directory, async (repo) => {
    const prompt = await repo.db.get(key('prompts', `${input.sessionID}\0${input.messageID}`));
    if (!prompt) throw changeError('mutation_history_unavailable');
    const pending = (await repo.db.get(key('sessions', input.sessionID)))?.pending;
    if (pending) {
      const previous = await repo.db.get(key('transactions', pending));
      if (previous && !previous.redo && previous.boundarySequence === prompt.sequence
        && previous.scope === (input.scope ?? 'tree')) return previous;
      throw changeError('session_reverting');
    }
    if (prompt.reverted) {
      const receipt = await repo.db.get(key('last-reverts', input.sessionID));
      const previous = receipt?.ids?.length && await repo.db.get(key('transactions', receipt.ids.at(-1)));
      // A delayed retry of a later boundary must not reveal messages while
      // leaving their operations disabled by an earlier completed Revert.
      if (previous?.state !== 'committed' || previous.redo || previous.boundarySequence > prompt.sequence) {
        throw changeError('mutation_history_unavailable');
      }
      if (previous.boundarySequence < prompt.sequence || (previous.scope ?? 'tree') === 'tree' || input.scope === 'session') return previous;
      // The same boundary may deliberately expand from session-only to tree.
      // Keep the root boundary and select the still-active descendant work.
    }
    const members = new Set([input.sessionID]), sessions = [];
    for await (const { value } of repo.db.entries('sessions')) sessions.push(value);
    if (input.scope !== 'session') {
      for (let grew = true; grew;) {
        grew = false;
        for (const session of sessions) if (members.has(session.parentID) && !members.has(session.id)) { members.add(session.id); grew = true; }
      }
    }
    const selected = [], targets = new Map([[input.sessionID, { id: input.sessionID, targetMessageID: input.messageID }]]);
    const prompts = [];
    for await (const { value } of repo.db.entries('prompts')) if (members.has(value.sessionID)) prompts.push(value);
    prompts.sort((a, b) => a.sequence - b.sequence);
    for (const candidate of prompts) {
      if ((candidate.origins?.[input.sessionID] ?? candidate.sequence) >= prompt.sequence && !targets.has(candidate.sessionID)) {
        targets.set(candidate.sessionID, { id: candidate.sessionID, targetMessageID: candidate.messageID });
      }
    }
    const operations = [];
    for await (const { value } of repo.db.entries('operations')) operations.push(value);
    operations.sort((a, b) => a.sequence - b.sequence);
    for (const op of operations) {
      if (!op.active || !members.has(op.scope?.sessionID) || (op.origins?.[input.sessionID] ?? op.sequence) < prompt.sequence
        || op.scope.sessionID === input.sessionID && (op.promptSequence ?? op.sequence) < prompt.sequence) continue;
      selected.push(op.id);
      if (!targets.has(op.scope.sessionID)) targets.set(op.scope.sessionID, { id: op.scope.sessionID,
        targetMessageID: op.scope.messageID, callID: op.scope.callID });
    }
    const id = randomUUID();
    repo.db.remove(key('last-redos', input.sessionID));
    for (const session of sessions) {
      if (!members.has(session.id)) continue;
      if (session.pending) throw changeError('session_reverting');
      session.generation++; session.pending = id; repo.db.set(key('sessions', session.id), session);
    }
    const tx = { id, rootSessionID: input.sessionID, boundarySequence: prompt.sequence,
      state: 'prepared', phase: 'prepared', scope: input.scope ?? 'tree',
      targets: [...targets.values()], members: [...members], redo: false };
    await repo.db.setList(`transactions/${id}/operations`, selected);
    repo.db.set(key('transactions', id), tx);
    return tx;
  });
  const settleRevert = (input) => locked(input.directory, async (repo) => {
    const tx = await repo.db.get(key('transactions', input.transactionID));
    if (!tx) throw changeError('revert_unavailable');
    if (tx.state === 'committed') return tx.result;
    if (tx.state !== 'prepared') throw changeError('revert_unavailable');
    const documents = new Map(), conflicts = [], fenced = new Set();
    let inputs = new Set();
    if (input.commit) {
      ({ inputs } = await reconcile(repo));
      for await (const id of repo.db.list(`transactions/${tx.id}/operations`)) {
        const op = await repo.db.get(key('operations', id));
        if (!op) throw changeError('invalid_change_record');
        if (op.conflicts) for await (const row of repo.db.list(op.conflicts)) conflicts.push({ path: row.path });
        if (tx.kind === 'files') op.fileUndone = !tx.redo;
        else op.active = tx.redo;
        repo.db.set(key('operations', id), op);
        for (const file of op.files) documents.set(file, await repo.db.get(key('files', file)));
      }
      if (tx.kind !== 'files') for await (const { key: promptKey, value: prompt } of repo.db.entries('prompts')) {
        if (tx.members.includes(prompt.sessionID) && (prompt.origins?.[tx.rootSessionID] ?? prompt.sequence) >= tx.boundarySequence) {
          prompt.reverted = !tx.redo;
          repo.db.set(promptKey, prompt);
        }
      }
    }
    const accept = async (files) => {
      tx.state = input.commit ? 'committed' : 'cancelled';
      tx.phase = tx.state;
      tx.result = { files, sessions: tx.targets, redoAvailable: input.commit && !tx.redo,
        ...(conflicts.length ? { outcome: 'partial', conflicts } : {}) };
      repo.db.set(key('transactions', tx.id), tx);
      for (const member of tx.members) {
        const session = await repo.db.get(key('sessions', member));
        if (session?.pending === tx.id) { session.pending = null; repo.db.set(key('sessions', member), session); }
      }
      if (input.commit && tx.kind === 'files') return;
      if (input.commit && !tx.redo) {
        const previous = await repo.db.get(key('last-reverts', tx.rootSessionID));
        repo.db.set(key('last-reverts', tx.rootSessionID), { ids: [...(previous?.ids ?? []), tx.id] });
      } else if (input.commit) {
        repo.db.remove(key('last-reverts', tx.rootSessionID));
        repo.db.set(key('last-redos', tx.rootSessionID), { id: tx.id });
      }
    };
    const fence = (file) => {
      if (!underInput(file, inputs)) return false;
      if (!fenced.has(file)) { fenced.add(file); conflicts.push({ path: file, code: 'ignored_input' }); }
      return true;
    };
    if (input.commit) await materialize(repo, [...documents.values()], accept, { fence });
    else await accept([]);
    return tx.result;
  });
  const prepareRedo = (input) => locked(input.directory, async (repo) => {
    const pending = (await repo.db.get(key('sessions', input.sessionID)))?.pending;
    if (pending) {
      const previous = await repo.db.get(key('transactions', pending));
      if (previous?.redo && previous.rootSessionID === input.sessionID) return previous;
      throw changeError('session_reverting');
    }
    const last = await repo.db.get(key('last-reverts', input.sessionID));
    if (!last?.ids?.length) {
      const receipt = await repo.db.get(key('last-redos', input.sessionID));
      const completed = receipt && await repo.db.get(key('transactions', receipt.id));
      if (completed?.state === 'committed' && completed.redo) return completed;
      throw changeError('redo_unavailable');
    }
    const operations = new Set(), members = new Set(), targets = new Map();
    let boundarySequence = Infinity;
    for (const previousID of last.ids) {
      const previous = await repo.db.get(key('transactions', previousID));
      if (!previous || previous.state !== 'committed' || previous.redo) throw changeError('redo_unavailable');
      for await (const op of repo.db.list(`transactions/${previousID}/operations`)) operations.add(op);
      for (const member of previous.members) members.add(member);
      for (const target of previous.targets) targets.set(target.id, target);
      boundarySequence = Math.min(boundarySequence, previous.boundarySequence);
    }
    const id = randomUUID(), tx = { id, rootSessionID: input.sessionID, members: [...members],
      targets: [...targets.values()], boundarySequence, redo: true, state: 'prepared', phase: 'prepared' };
    for (const member of tx.members) {
      const session = await repo.db.get(key('sessions', member));
      if (session.pending) throw changeError('session_reverting');
      session.generation++; session.pending = id; repo.db.set(key('sessions', member), session);
    }
    await repo.db.setList(`transactions/${id}/operations`, operations);
    repo.db.set(key('transactions', id), tx); return tx;
  });
  const prepareFileRestore = (input) => locked(input.directory, async (repo) => {
    if (!validID(input.sessionID) || !validID(input.revision) || !Array.isArray(input.calls)
      || !input.calls.length || input.calls.some((call) => !validID(call.sessionID) || !validID(call.callID))) {
      throw changeError('mutation_history_unavailable');
    }
    const identity = JSON.stringify([input.sessionID, input.revision, input.redo === true]);
    const receipt = await repo.db.get(key('file-restores', identity));
    const fingerprint = digest(Buffer.from(JSON.stringify(input.calls.map((call) => [call.sessionID, call.callID]).sort())));
    if (receipt) {
      if (receipt.fingerprint !== fingerprint) throw changeError('capture_identity_mismatch');
      const previous = await repo.db.get(key('transactions', receipt.id));
      if (!previous) throw changeError('mutation_recovery_failed');
      if (previous.state !== 'cancelled') return previous;
    }
    const members = new Set([input.sessionID]), operations = new Set();
    for (const call of input.calls) {
      const entry = await repo.db.get(key('calls', `${call.sessionID}\0${call.callID}`));
      const lease = entry && await repo.db.get(key('leases', entry.token));
      if (lease?.state !== 'published' || !lease.result?.operationID) throw changeError('mutation_history_unavailable');
      if (call.messageID && call.messageID !== lease.scope.messageID) throw changeError('capture_identity_mismatch');
      let id = call.sessionID;
      const seen = new Set();
      while (id !== input.sessionID) {
        if (!id || seen.has(id)) throw changeError('invalid_session_lineage');
        seen.add(id); members.add(id);
        id = (await repo.db.get(key('sessions', id)))?.parentID;
      }
      operations.add(lease.result.operationID);
    }
    const id = randomUUID();
    // A hidden descendant may still publish through an older parent call.
    // Fence the entire selected review tree before waiting for termination.
    const descendants = [];
    for await (const { value } of repo.db.entries('sessions')) descendants.push(value);
    for (let grew = true; grew;) {
      grew = false;
      for (const session of descendants) if (members.has(session.parentID) && !members.has(session.id)) {
        members.add(session.id); grew = true;
      }
    }
    for (const member of members) {
      const session = await repo.db.get(key('sessions', member));
      if (!session || session.pending) throw changeError('session_reverting');
      session.generation++; session.pending = id; repo.db.set(key('sessions', member), session);
    }
    const tx = { id, kind: 'files', rootSessionID: input.sessionID, members: [...members], targets: [],
      boundarySequence: 0, redo: input.redo === true, state: 'prepared', phase: 'prepared' };
    await repo.db.setList(`transactions/${id}/operations`, operations);
    repo.db.set(key('transactions', id), tx);
    repo.db.set(key('file-restores', identity), { id, fingerprint });
    return tx;
  });
  const leaseForCall = (input) => snapshotOrLocked(input.directory, async (repo) => {
    const call = await repo.db.get(key('calls', `${input.sessionID}\0${input.callID}`));
    // Absence is only authoritative behind any queued reservation.
    if (!call && repo.snapshot) throw changeError('snapshot_lease_absent');
    return call ? repo.db.get(key('leases', call.token)) : null;
  });
  // Read only host-owned durable evidence. A tool error or a missing lease is
  // never proof that a command did not execute. Batch one transcript per lock.
  const executionOutcomes = (input) => snapshotOrLocked(input.directory, async (repo) => {
    if (!validID(input.sessionID) || !Array.isArray(input.calls) || input.calls.length > 10_000
      || input.calls.some(call => !validID(call.callID) || !validID(call.messageID))) throw changeError('invalid_capture_identity');
    if (!repo) return input.calls.map(call => ({ sessionID: input.sessionID, messageID: call.messageID, callID: call.callID, outcome: 'uncertain' }));
    const outcomes = [];
    for (const call of input.calls) {
      const scopeKey = `${input.sessionID}\0${call.callID}`;
      const cancelled = await repo.db.get(key('cancelled-calls', scopeKey));
      const pointer = await repo.db.get(key('calls', scopeKey));
      const lease = pointer ? await repo.db.get(key('leases', pointer.token)) : null;
      let outcome = 'uncertain';
      if (lease && lease.directory === repo.logicalDirectory && lease.scope.sessionID === input.sessionID
        && lease.scope.messageID === call.messageID && lease.scope.callID === call.callID) {
        if (lease.state === 'published') outcome = 'finished';
        else if (lease.state === 'cancelled' && lease.cleaned && !lease.cleanupPending
          && (lease.cancelledBeforeStart || !lease.executionKind)) outcome = 'never_started';
      } else if (!pointer && cancelled?.messageID === call.messageID) outcome = 'never_started';
      outcomes.push({ sessionID: input.sessionID, messageID: call.messageID, callID: call.callID, outcome });
    }
    return outcomes;
  }, { requireExisting: true });
  const aliasCalls = (input) => locked(input.directory, async (repo) => {
    const lease = await repo.db.get(key('leases', input.token));
    if (!lease || !Array.isArray(input.calls) || input.calls.some((call) => !validID(call))) throw changeError('capture_identity_mismatch');
    for (const callID of input.calls) {
      const callKey = key('calls', `${lease.scope.sessionID}\0${callID}`), existing = await repo.db.get(callKey);
      if (existing && existing.token !== lease.token) throw changeError('capture_identity_mismatch');
      repo.db.set(callKey, { token: lease.token });
    }
  });
  const executionReceipt = (input) => locked(input.directory, async (repo) => {
    const lease = await repo.db.get(key('leases', input.token));
    if (lease?.state !== 'published') throw changeError('execution_unavailable');
    const files = [];
    const content = (entry) => {
      if (!entry) return null;
      if (!/^[a-f0-9]{64}$/.test(entry.hash ?? '')) throw changeError('invalid_change_record');
      // Lazy streams cross only the in-process trusted receipt boundary. No
      // large file buffer or lock-held file read is needed to return a receipt.
      const byteStream = async function* () {
        const hash = createHash('sha256');
        for await (const chunk of createReadStream(path.join(repo.root, 'objects', entry.hash), { highWaterMark: 128 * 1024 })) {
          hash.update(chunk); yield chunk;
        }
        if (hash.digest('hex') !== entry.hash) throw changeError('invalid_change_record');
      };
      return { byteStream: byteStream(), sha256: entry.hash, mode: entry.mode };
    };
    for await (const file of repo.db.list(`publications/${input.token}/files`)) {
      files.push({ path: path.join(repo.directory, file.path), before: await content(file.before), after: await content(file.after) });
    }
    return { ...lease.scope, directory: lease.directory, source: 'confined-execution', complete: true, files,
      ...(lease.result?.outcome ? { outcome: lease.result.outcome, conflicts: lease.result.conflicts } : {}) };
  });
  const claimLease = (input) => locked(input.directory, async (repo) => {
    const lease = await repo.db.get(key('leases', input.token));
    if (!['control', 'process'].includes(input.kind) || lease?.state !== 'ready' || lease.executionKind) throw changeError('execution_already_started');
    if (lease.preparation === 'none' && input.kind !== 'control') throw changeError('capture_identity_mismatch');
    const session = await repo.db.get(key('sessions', lease.scope.sessionID));
    if (session?.pending || session?.generation !== lease.generation) throw changeError('execution_reverted');
    lease.executionKind = input.kind;
    repo.db.set(key('leases', input.token), lease); return lease;
  });
  const registerChild = (input) => locked(input.directory, async (repo) => {
    if (!validID(input.sessionID) || !validID(input.parentID) || !validID(input.parentCallID)) throw changeError('invalid_capture_identity');
    const parent = await repo.db.get(key('sessions', input.parentID));
    const call = await repo.db.get(key('calls', `${input.parentID}\0${input.parentCallID}`));
    const lease = call && await repo.db.get(key('leases', call.token));
    if (!parent || parent.pending || !lease || lease.generation !== parent.generation || !['ready', 'published'].includes(lease.state)) {
      throw changeError('execution_reverted');
    }
    const session = await repo.db.get(key('sessions', input.sessionID));
    if (session && session.parentID !== input.parentID) throw changeError('invalid_session_lineage');
    if (session?.pending) throw changeError('session_reverting');
    repo.db.set(key('sessions', input.sessionID), { id: input.sessionID, generation: 0, pending: null, ...session,
      parentID: input.parentID, parentGeneration: parent.generation, parentCallID: input.parentCallID });
    return { parentGeneration: parent.generation };
  });
  const transaction = (input) => locked(input.directory, (repo) => repo.db.get(key('transactions', input.transactionID)));
  const updateTransaction = (input) => locked(input.directory, async (repo) => {
    const tx = await repo.db.get(key('transactions', input.transactionID));
    if (!tx || tx.state !== 'prepared') throw changeError('revert_unavailable');
    if (input.expectedPhase !== tx.phase) throw changeError('revert_phase_mismatch');
    const transitions = { prepared: ['stopped', 'restoring'], stopped: ['conversation', 'restoring'],
      conversation: ['files', 'restoring'], restoring: ['restoring'], files: [] };
    if (!transitions[tx.phase]?.includes(input.phase)) throw changeError('revert_phase_mismatch');
    if (input.boundaries) {
      if (tx.boundaries || !Array.isArray(input.boundaries) || input.boundaries.length !== tx.targets.length
        || tx.targets.some((target) => input.boundaries.filter((item) => item.id === target.id).length !== 1)) {
        throw changeError('invalid_revert_boundaries');
      }
      tx.boundaries = input.boundaries;
    }
    if (input.phase === 'conversation' && !tx.boundaries) throw changeError('invalid_revert_boundaries');
    tx.phase = input.phase;
    repo.db.set(key('transactions', tx.id), tx);
    return tx;
  });
  // Compare-and-swap restoration of content the ledger does not own (legacy,
  // uncaptured conversations). Under the publication lock, each path is
  // written only while its bytes still equal `expected`; a path already at
  // `target` is done (idempotent recovery); anything else is a conflict and is
  // left untouched. Results are reconciled as external changes, like any
  // foreign edit. Entries are { path, expected, target } with each side
  // { mode, bytes } or null for an absent file.
  const restoreForeign = (input) => locked(input.directory, async (repo) => {
    const files = [], conflicts = [], written = [];
    // Only a target is stored; an expected side is compared by digest.
    const describeSide = async (side, store) => side ? { hash: store ? await putBytes(repo, side.bytes) : digest(side.bytes), mode: side.mode,
      ...(side.mode === '120000' ? {} : { permissions: side.mode === '100755' ? 0o755 : 0o644 }) } : null;
    const same = (current, side) => (current?.hash ?? null) === (side?.hash ?? null) && (current?.mode ?? null) === (side?.mode ?? null);
    for (const change of input.files ?? []) {
      if (!safeChangePath(change?.path)) throw changeError('invalid_change_record');
      checkExecutionAdmission();
      const expected = await describeSide(change.expected, false), target = await describeSide(change.target, true);
      const current = await inspect(repo, change.path);
      if (same(current, target)) { files.push({ path: change.path, status: 'unchanged' }); continue; }
      if (!same(current, expected)) { conflicts.push({ path: change.path }); continue; }
      await write(repo, change.path, target);
      if (!same(await inspect(repo, change.path), target)) throw changeError('mutation_recovery_required', 503);
      written.push(change.path);
      files.push({ path: change.path, status: !target ? 'deleted' : !expected ? 'added' : 'modified' });
    }
    if (written.length) await reconcile(repo, written);
    return { files, conflicts };
  });
  // Read-only ownership evidence for callers that run without the companion.
  // A session the ledger has registered, or any prepared transaction in its
  // project, must never be reverted by a path that bypasses the ledger.
  const capturedSessionState = (input) => snapshotOrLocked(input.directory, async (repo) => {
    if (!repo) return { captured: false, pending: false };
    const session = await repo.db.get(key('sessions', input.sessionID));
    let pending = Boolean(session?.pending);
    if (!pending) for await (const { value } of repo.db.entries('transactions')) if (value.state === 'prepared') { pending = true; break; }
    return { captured: Boolean(session), pending };
  }, { requireExisting: true });
  const pendingTransactions = (input) => locked(input.directory, async (repo) => {
    const entries = [];
    for await (const { value } of repo.db.entries('transactions')) if (value.state === 'prepared') entries.push(value);
    return entries;
  });
  const cancelLease = (input) => locked(input.directory, async (repo) => {
    const lease = await repo.db.get(key('leases', input.token));
    if (!lease) throw changeError('execution_unavailable');
    if (lease.state === 'published') throw changeError('execution_already_published');
    lease.state = 'cancelled'; lease.cleanupPending = !lease.cleaned; repo.db.set(key('leases', lease.token), lease);
  });
  const cancelUnstartedCall = (input) => locked(input.directory, async (repo) => {
    if (!validID(input.sessionID) || !validID(input.callID) || !validID(input.messageID)) throw changeError('invalid_capture_identity');
    const scopeKey = `${input.sessionID}\0${input.callID}`, call = await repo.db.get(key('calls', scopeKey));
    if (call) {
      const lease = await repo.db.get(key('leases', call.token));
      if (!lease || lease.scope.messageID !== input.messageID || input.token && lease.token !== input.token) throw changeError('capture_identity_mismatch');
      if (lease.state === 'published') throw changeError('execution_already_published');
      lease.cancelledBeforeStart = true;
      lease.state = 'cancelled'; lease.cleanupPending = !lease.cleaned; repo.db.set(key('leases', lease.token), lease);
    }
    repo.db.set(key('cancelled-calls', scopeKey), { messageID: input.messageID });
  });
  const activeLeases = (input) => locked(input.directory, async (repo) => {
    const entries = [];
    for await (const { value } of repo.db.entries('leases')) {
      if (['preparing', 'ready'].includes(value.state) && (!input.sessions || input.sessions.includes(value.scope.sessionID))) entries.push(value);
    }
    return entries;
  });
  const pendingCleanup = (input) => locked(input.directory, async (repo) => {
    const entries = [];
    for await (const { value } of repo.db.entries('leases')) {
      // Include pre-marker terminal records to recover existing installations.
      if (!value.cleaned && ['published', 'cancelled'].includes(value.state)) entries.push(value);
    }
    return entries;
  });
  const projectDirectories = async () => {
    const directories = [];
    for (const entry of await fs.readdir(storage, { withFileTypes: true }).catch((cause) => { if (cause.code === 'ENOENT') return []; throw cause; })) {
      if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
      const root = path.join(storage, entry.name);
      const db = await openChangeStore(root, path.join(root, 'git'));
      const meta = await db.get('meta.json');
      if (meta?.version === 1 && path.isAbsolute(meta.directory ?? '')) directories.push(meta.directory);
    }
    return directories;
  };
  return { projectDirectories, projectDirectory: (input) => locked(input.directory, (repo) => repo.directory),
    assertAdmission, registerPrompt, registerChild, reserve, prepare, warm, begin, admitDirect, finishDirect, claimLease, finish, cleanupLease, executionReceipt, aliasCalls, prepareRevert, prepareRedo, prepareFileRestore, settleRevert, leaseForCall,
    transaction, updateTransaction, pendingTransactions, capturedSessionState, restoreForeign, cancelLease, cancelUnstartedCall, activeLeases, pendingCleanup, executionOutcomes,
    maintainLedger: ({ directory }) => resolveRepository(directory).then(({ directory: project }) => maintainLedger(rootFor(project))),
    drain: () => Promise.allSettled([...preparations.values(), ...settlements.values(), ...queues.values(),
      ...[...maintenanceStates.values()].map((state) => state.running).filter(Boolean)]) };
}
