import { executionCleanup, executionDiagnostic, executionReporting, executionStep, timedExecutionStep, checkExecutionAdmission, executionPhase, quietExecutionPhase, executionSignal, executionProgressMeter, executionProgress, withExecutionMeter, withoutExecutionDeadline, waitForExecutionQueue } from './execution-admission.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs/promises';
import { createReadStream, lstatSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isUtf8 } from 'node:buffer';
import { randomUUID, createHash } from 'node:crypto';
import { git, gitTokens, changeError } from './session-changes-git.js';
import { openChangeStore, changeKey } from './session-changes-store.js';
import { safeChangePath, verifyAncestors } from './session-changes-snapshot.js';
import { withCrossProcessFileLock, writeFileAtomic } from './atomic-file.js';
import { applyMutationText, decodeMutationRunRows, encodeMutationRunRows, initialMutationRuns, minimizeMutationAncestry, mutationText,
  visibleMutationRuns } from './session-mutation-text.js';
import { reviewedToolEffect } from './session-tool-effects.js';
import { inspectMutationFile, copyMutationObject, createViewMaterializer, mutationFileStamp, mutationFileStampSync, mutationStatStamp, GRANULAR_TEXT_BYTES } from './session-mutation-files.js';
import { withExecutionIO } from './execution-io-pool.js';
import { markObjectIfUnsynced, syncPendingObjectDirectory } from './object-durability.js';
import { readSessionExecutionReceipt, removeExecutionSocketDirectory } from './session-execution.js';
import { removeExecutionDirectory } from './execution-cleanup.js';
import { DEPENDENCY_INPUT_NAMES } from './execution-inputs.js';

const key = (kind, id) => `${kind}/${changeKey(id)}.json`;
const permissions = (entry) => !entry || entry.deleted || entry.mode === '120000' ? null
  : entry.permissions ?? (entry.mode === '100755' ? 0o755 : 0o644);
const equal = (a, b) => (a?.hash ?? null) === (b?.hash ?? null) && (a?.mode ?? null) === (b?.mode ?? null)
  && permissions(a) === permissions(b);
const validID = (id) => typeof id === 'string' && id.length > 0 && id.length <= 1024 && !id.includes('\0');
// Both history coverage and restore use this exact durable no-start proof.
const neverStartedCall = ({ directory, sessionID, messageID, callID, pointer, lease, cancelled }) => validID(messageID) && (
  !pointer ? cancelled?.sessionID === sessionID && cancelled.messageID === messageID
    : lease?.directory === directory && lease.scope.sessionID === sessionID && lease.scope.messageID === messageID
      && lease.scope.callID === callID && lease.state === 'cancelled' && !lease.rebootRecovery
      && lease.cleaned === true && !lease.cleanupPending && (lease.cancelledBeforeStart === true || !lease.executionKind));
const scopeFields = ['sessionID', 'messageID', 'userMessageID', 'callID'];
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
// Dependency inputs: see execution-inputs.js. Ignored output folders among
// them are written through on macOS; the ledger still never ingests them.
const inputDirectories = DEPENDENCY_INPUT_NAMES;
const underInput = (file, inputs) => {
  if (inputs.has(file)) return true;
  for (let parent = path.posix.dirname(file); parent !== '.'; parent = path.posix.dirname(parent)) if (inputs.has(parent)) return true;
  return false;
};
// Ledger work runs on the event loop of the thread that created the runtime:
// the ledger worker (session-mutation-host.js) or, inline, the host's. Walks
// and batches yield between units so other ledger calls are served in between.
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
// A warm batch checks this often whether a call is queued for its lock, then
// commits what it installed and yields (an initial batch held it 10–15 s).
const WARM_YIELD_ROWS = 32;
// Lock timings outside a journaled context reach the journal from this long.
const LOCK_TIMING_SLOW_MS = 250;
// Kill switches: set to exactly '0' to restore the previous behaviour.
const fastIngest = () => process.env.DEVRYAN_LEDGER_FAST_INGEST !== '0';
// Rows whose content is unchanged (a new inode or ctime only) cost one record
// update each, so they install in first-build-sized batches with their
// under-lock stamps checked concurrently; content changes keep INSTALL_BATCH.
// A mass re-stamp otherwise committed the whole ledger once per 128 rows
// (99 commits, 53 s, on a 12k-file project).
const restampBatching = () => process.env.DEVRYAN_LEDGER_RESTAMP_BATCH !== '0';
// Ledger commits write loose Git objects and plumbing never packs them. Tens
// of thousands of loose objects make every read-tree, ls-tree -l and cat-file
// pay a filesystem lookup per object: 0.6 s per commit, about ten commits per
// call, on a 5.6k-file project (a packed store answers in about 40 ms).
const LEDGER_MAINTENANCE = Object.freeze({ looseObjects: 1_000, packs: 12, commits: 64, pruneExpiry: '2.hours.ago' });
// A document whose runs are exactly its first observed text stores one marker
// page naming that text's content object instead of base64 pages: the bytes
// already live in `objects/`, which is never collected. On a 12k-file project
// these baselines were 124 of 148 MB of `runs/`. A marker is not an array, so
// a host predating it fails closed (`invalid_change_record`) instead of
// reading empty text. Kill switch: DEVRYAN_LEDGER_BASELINE_REFS=0 writes and
// compacts no markers; existing markers stay readable.
const baselineRefs = () => process.env.DEVRYAN_LEDGER_BASELINE_REFS !== '0';
const BASELINE_PAGE = '0000000000.json';
// Written once a compaction pass leaves no inline baseline behind.
const BASELINE_COMPACTED = 'baseline-refs';
const COMPACT_BATCH = 1024;
const baselineMarker = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === 2 && /^[a-f0-9]{64}$/.test(value.baseline) && Number.isSafeInteger(value.size) && value.size > 0;
// Runs written with direct ancestry (session-mutation-text.js) are fenced by a
// format page at `BASELINE_PAGE`, ahead of their rows. A host predating direct
// ancestry would read the rows but derive a shallower closure, so it must fail
// closed (`invalid_change_record`, as for baseline markers) rather than order
// boundary inserts differently after multi-level undo. Fenced rows store a
// run's metadata once (`continues` rows carry only text). The transition is
// one-way per document; format 1 documents stay readable. Runs that replace
// nothing (a baseline, pure insertions) keep format 1 rows and need no fence.
const ANCESTRY_FORMAT = Object.freeze({ format: 'ancestry', version: 2 });
const ancestryFormatPage = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === 2 && value.format === 'ancestry' && value.version === 2;
// Documents written before direct ancestry store every run's closure; those
// with at least this many stored entries are reduced (`compactAncestry`). An
// entry is at least `{"id":"","start":0,"length":0}`, so a document whose pages
// are smaller is passed over from the listing alone. Pages are parsed
// synchronously, so they are read in short batches. Kill switch:
// DEVRYAN_LEDGER_ANCESTRY_COMPACTION=0 stops further passes; documents
// already compacted stay fenced and readable.
const ancestryCompaction = () => process.env.DEVRYAN_LEDGER_ANCESTRY_COMPACTION !== '0';
const ANCESTRY_COMPACTED = 'ancestry-compacted';
const ANCESTRY_COMPACTION_ENTRIES = 1024;
const ANCESTRY_ENTRY_MIN_BYTES = 30;
const ANCESTRY_READ_BYTES = 2 * 1024 * 1024;
// A foreground step waits at most one slice of compaction work.
const COMPACTION_SLICE_MS = 5;
// The text of runs that are exactly a document's untouched baseline (stored
// whole or in 32 KiB rows), or null.
const baselineText = (runs, id) => {
  let text = '';
  for (const run of runs) {
    if (run.id !== `${id}:baseline` || run.owner !== null || run.deletedBy.length || run.replaces.length || run.start !== text.length) return null;
    text += run.text;
  }
  return text || null;
};
// Build tools write caches inside node_modules (Vite's bundled config and
// dependency optimizer, loader caches), which the read-only dependency input
// denies. A view's node_modules therefore links to a host-owned overlay: one
// link per project entry, and cache entries linked into the project's shared
// execution cache, which workers may write. Resolution still realpaths into
// the project; nothing reaches the project's own caches. Windows keeps the
// direct link. Kill switch: DEVRYAN_MODULE_CACHE_OVERLAY=0.
const MODULE_CACHE_ENTRIES = Object.freeze(['.vite', '.vite-temp', '.cache']);
const moduleOverlay = (file) => process.env.DEVRYAN_MODULE_CACHE_OVERLAY !== '0' && process.platform !== 'win32'
  && path.posix.basename(file) === 'node_modules';
const ignoreCode = (...codes) => (cause) => { if (!codes.includes(cause.code)) throw cause; };
// A view's Git metadata needs the project's common and private Git
// directories and its HEAD. One rev-parse answers all three (`--` keeps a
// file named HEAD from making the revision ambiguous); an unborn HEAD fails
// it, and the directories are then asked for alone.
const OBJECT_ID = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const projectGitLocation = async (directory) => {
  const lines = await git(directory, ['rev-parse', '--path-format=absolute', '--git-common-dir', '--absolute-git-dir', 'HEAD', '--'])
    .then((value) => value.toString().split('\n'), () => null);
  let [common, metadata, head] = lines ?? [];
  if (!lines || !OBJECT_ID.test(head ?? '')) {
    [common, metadata] = (await git(directory, ['rev-parse', '--path-format=absolute', '--git-common-dir', '--absolute-git-dir']))
      .toString().split('\n');
    head = null;
  }
  if (!common || !metadata || /[\r\n]/.test(common) || /[\r\n]/.test(metadata)) throw changeError('invalid_execution_path');
  return { common, metadata, head };
};
// `git init` left HEAD as a symbolic ref to an unborn branch; writing that
// loose ref is what `update-ref HEAD` does, without a process. Anything else
// in HEAD keeps the plumbing path.
const pointViewHead = async (view, head) => {
  const metadata = path.join(view, '.git');
  const symbolic = /^ref: (refs\/heads\/[A-Za-z0-9._/-]+)\n?$/.exec(await fs.readFile(path.join(metadata, 'HEAD'), 'utf8').catch(() => ''));
  const ref = symbolic?.[1];
  if (!ref || ref.split('/').some((part) => !part || part === '.' || part === '..' || part.endsWith('.lock'))) {
    await git(view, ['update-ref', 'HEAD', head]);
    return;
  }
  await fs.mkdir(path.dirname(path.join(metadata, ref)), { recursive: true });
  await fs.writeFile(path.join(metadata, ref), `${head}\n`, { flag: 'wx' }).catch(async (cause) => {
    if (cause.code !== 'EEXIST') throw cause;
    await git(view, ['update-ref', 'HEAD', head]);
  });
};
// Whole-second ctimes cannot rule out a same-tick write (git's racy-clean
// case), so a stamp with them never proves a file or directory untouched.
const preciseStamp = (value) => typeof value === 'string' && value.split(':')[4] !== undefined && !value.split(':')[4].endsWith('000000000');
// A session's published lease parks its private view as a standby; the
// session's next preparation adopts what is still exactly as materialized and
// copies only the rest (adoptStandbyView). Linux and macOS: Windows views carry
// owner-created ACLs and are rebuilt per lease. Standbys are known only to the
// process that parked them; one left by another or an earlier process is never
// adopted. Nothing adopts a standby older than STANDBY_MAX_AGE_MS, and only
// standbys twice that old are swept, so a sweep never races an adoption in
// another process. A few per session serve parallel calls; Linux views are
// full copies, so the total stays small. Kill switch: DEVRYAN_VIEW_REUSE=0.
const viewReuse = () => process.platform !== 'win32' && process.env.DEVRYAN_VIEW_REUSE !== '0';
// Parallel calls in one session each need a view, so a session keeps up to
// four (views are clones on APFS: about a directory entry and inode per file).
const STANDBY_PER_SESSION = 4;
const STANDBY_LIMIT = 12;
const STANDBY_MAX_AGE_MS = 30 * 60_000;
// Mirrors the project listing on every preparation (two directory reads), so
// installed or removed packages appear without rebuilding. Overlay entries
// are only links this host created; concurrent preparations converge.
async function syncModuleOverlay({ source, overlay, caches }) {
  const [wanted, present] = await Promise.all([fs.readdir(source), fs.readdir(overlay).catch((cause) => {
    if (cause.code === 'ENOENT') return []; throw cause;
  })]);
  await fs.mkdir(overlay, { recursive: true, mode: 0o700 });
  const want = new Set(wanted.filter((name) => !MODULE_CACHE_ENTRIES.includes(name))), have = new Set(present);
  await mapBounded([...want].filter((name) => !have.has(name)),
    (name) => fs.symlink(path.join(source, name), path.join(overlay, name)).catch(ignoreCode('EEXIST')));
  await mapBounded(present.filter((name) => !want.has(name) && !MODULE_CACHE_ENTRIES.includes(name)),
    (name) => fs.unlink(path.join(overlay, name)).catch(ignoreCode('ENOENT')));
  for (const name of MODULE_CACHE_ENTRIES) {
    await fs.mkdir(path.join(caches, name), { recursive: true, mode: 0o700 });
    if (!have.has(name)) await fs.symlink(path.join(caches, name), path.join(overlay, name)).catch(ignoreCode('EEXIST'));
  }
}
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
// `synchronousWalks`: the caller's thread may block (the ledger worker,
// session-mutation-worker.js). Project and view walks then list directories
// and stamp files with synchronous calls: on 13k files a stamp pass took
// 49 ms instead of 311 ms through the thread pool. Chunks still yield between
// each other. Kill switch, read per use: DEVRYAN_LEDGER_SYNC_WALKS=0.
export function createSessionMutationRuntime({ directory: storage, onChange = () => {}, onMaterialize, onDiagnostic = () => {}, onLockTiming, maintenance: maintenanceOptions, batching = {}, windowsOwner, windowsLauncher, gitRunner, synchronousWalks = false } = {}) {
  const syncWalks = () => synchronousWalks === true && process.env.DEVRYAN_LEDGER_SYNC_WALKS !== '0';
  const listDirectory = (directory) => syncWalks() ? readdirSync(directory, { withFileTypes: true }) : fs.readdir(directory, { withFileTypes: true });
  const lstatEntry = (file) => {
    if (!syncWalks()) return fs.lstat(file, { bigint: true });
    try { return lstatSync(file, { bigint: true }); }
    catch (cause) { return Promise.reject(cause); }
  };
  if (!path.isAbsolute(storage ?? '')) throw new TypeError('Absolute mutation storage directory is required');
  // Rows per install transaction. Tests shrink both to cross batch boundaries
  // with a few hundred files instead of thousands; production keeps the defaults.
  const { install: installBatch = INSTALL_BATCH, initialInstall: initialInstallBatch = INITIAL_INSTALL_BATCH } = batching;
  // Ledger store Git I/O (tests count processes and commits through it).
  const storeOptions = gitRunner ? { gitRunner } : {};
  if (![installBatch, initialInstallBatch].every((value) => Number.isSafeInteger(value) && value > 0)) throw new TypeError('Install batch sizes must be positive integers');
  // Background failures outside any admission context (codes only).
  const diagnostic = (record) => { try { onDiagnostic(record); } catch { /* Observer only. */ } };
  // Every owner-lock acquisition, with or without an execution context:
  // queue and lock wait, then hold time (transaction and commit). Observer
  // only; contended or long holds outside a journaled context are journaled
  // here, because no admission summary carries them.
  const lockTiming = (timing) => {
    try { onLockTiming?.(timing); } catch { /* Observer only. */ }
    if (executionReporting() || (timing.waitMs < LOCK_TIMING_SLOW_MS && timing.holdMs < LOCK_TIMING_SLOW_MS && !timing.failed)) return;
    diagnostic({ phase: 'ledger_lock', state: timing.failed ? 'failed' : 'completed', elapsedMs: timing.waitMs + timing.holdMs, slow: true,
      action: timing.operation, ...(timing.sessionID ? { sessionID: timing.sessionID } : {}),
      // A read that would have answered lock-free names why it could not.
      ...(timing.snapshotMiss ? { reason: `snapshot_${timing.snapshotMiss}` } : {}),
      steps: `queue_wait:1/${timing.queueMs},lock_wait:1/${timing.waitMs - timing.queueMs},lock_hold:1/${timing.holdMs}` });
  };
  const queues = new Map();
  // The public runtime operation that took a lock, for lock timings only.
  const lockOperation = new AsyncLocalStorage();
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
      // Its loose objects are packed below; a failure leaves inline pages.
      await compactBaselines(root).catch((cause) => {
        diagnostic({ phase: 'ledger_compaction', state: 'failed', code: cause?.code ?? 'ledger_compaction_failed' });
      });
      await compactAncestry(root).catch((cause) => {
        diagnostic({ phase: 'ledger_ancestry_compaction', state: 'failed', code: cause?.code ?? 'ledger_compaction_failed' });
      });
      const stats = Object.fromEntries((await run(['count-objects', '-v'])).toString().trim().split('\n')
        .map((line) => line.split(': ')).map(([name, value]) => [name, Number(value)]));
      if (stats.count >= maintenanceLimits.looseObjects) {
        await run(['repack', '-d', '-q', '--no-write-bitmap-index']);
        // What stays loose is unreachable: superseded trees (each commit
        // rewrites the large `files/`, `runs/` and `revisions/` trees) and
        // replaced pages. Waiting for the consolidation below left 380 MiB of
        // them in one two-week-old ledger. The grace keeps in-flight objects.
        await run(['prune', `--expire=${maintenanceLimits.pruneExpiry}`]);
      }
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
  const syncObjects = (root) => syncPendingObjectDirectory(root, { windowsLauncher });
  const bytesFor = async (repo, hash) => {
    if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) throw changeError('invalid_change_record');
    const bytes = await fs.readFile(path.join(repo.root, 'objects', hash));
    if (digest(bytes) !== hash) throw changeError('invalid_change_record');
    return bytes;
  };
  const putBytes = async (repo, bytes) => {
    const hash = digest(bytes), target = path.join(repo.root, 'objects', hash);
    try { markObjectIfUnsynced(path.dirname(target), (await fs.lstat(target)).ctimeMs); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (process.platform === 'win32') await windowsOwner.ensureDirectory(path.dirname(target));
      await writeFileAtomic(target, bytes, { windowsOwner });
    }
    return hash;
  };
  const inspect = (repo, file, directory, options) => withExecutionIO(repo.root, () => inspectMutationFile(repo, file, directory, options));
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
    const written = [];
    for await (const row of repo.db.list(`materializations/${pending.id}`)) {
      let current = await inspect(repo, row.path);
      if (!equal(current, row.after)) {
        if (!equal(current, row.before)) throw changeError('mutation_recovery_required', 503);
        await onMaterialize?.(row);
        await write(repo, row.path, row.after);
        current = await inspect(repo, row.path);
        if (!equal(current, row.after)) throw changeError('mutation_recovery_required', 503);
      }
      if (current && row.documentID) written.push({ id: row.documentID, entry: current });
    }
    // Record the observation of each verified write, as reconciliation would:
    // otherwise the next observation re-inspects every published file and
    // restamps it in a commit of its own. Rows from older hosts carry no
    // document and are left to reconciliation.
    for (const { id, entry } of written) {
      const doc = await repo.db.get(key('files', id));
      if (!doc?.published || doc.published.deleted || !equal(doc.published, entry)) continue;
      doc.published = { ...doc.published, ...entry }; repo.db.set(key('files', id), doc);
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
  const queueMeters = new Map(), queuedCalls = new Map();
  const locked = async (requested, fn, { requireExisting = false, operation: explicitOperation, sessionID: explicitSessionID, assertCurrent, snapshotMiss } = {}) => {
    await assertCurrent?.();
    checkExecutionAdmission();
    const label = lockOperation.getStore();
    const operation = explicitOperation ?? label?.operation ?? 'ledger', sessionID = explicitSessionID ?? label?.sessionID;
    const { logicalDirectory, directory, vcs } = await resolveRepository(requested);
    if (requireExisting) {
      // Read-only evidence queries never create a ledger as a side effect.
      try { await fs.access(path.join(rootFor(directory), 'git', 'HEAD')); }
      catch (error) { if (error.code === 'ENOENT') return fn(null); throw error; }
    }
    const queued = Date.now();
    const timing = { operation, ...(validID(sessionID) ? { sessionID } : {}), ...(snapshotMiss ? { snapshotMiss } : {}), queueMs: 0, waitMs: 0, holdMs: 0, wrote: false, failed: false };
    const previous = queues.get(directory) ?? Promise.resolve();
    let queueMeter = queueMeters.get(directory);
    if (!queueMeter) { queueMeter = { progress: Date.now(), waiters: 0, following: undefined }; queueMeters.set(directory, queueMeter); }
    // Callers queued for this lock (not `waiters`, which marks I/O-slot progress).
    queuedCalls.set(directory, (queuedCalls.get(directory) ?? 0) + 1);
    const ready = executionPhase('queue_wait', () => waitForExecutionQueue(previous.catch(() => {}), queueMeter))
      .finally(() => { const left = queuedCalls.get(directory) - 1; if (left) queuedCalls.set(directory, left); else queuedCalls.delete(directory); });
    const work = ready.then(async () => {
      checkExecutionAdmission();
      if (process.platform === 'win32') {
        if (typeof windowsOwner?.ensureDirectory !== 'function') throw changeError('private_windows_storage_authority_unavailable', 503);
        await windowsOwner.ensureDirectory(storage);
      }
      const lockStarted = Date.now();
      timing.queueMs = lockStarted - queued;
      let acquired = false;
      return withCrossProcessFileLock(path.join(rootFor(directory), 'owner.lock'), () => withExecutionMeter(async () => {
        acquired = true;
        executionProgress();
        const holder = executionProgressMeter();
        queueMeter.following = holder; queueMeter.progress = Date.now();
        try { return await holdLock(); }
        finally { if (queueMeter.following === holder) queueMeter.following = undefined; queueMeter.progress = Date.now(); }
      }), { timeoutMs: 30_000, signal: executionSignal(), windowsLauncher }).catch(cause => {
        if (!acquired) executionDiagnostic({ phase: 'lock_wait', state: 'failed', elapsedMs: Date.now() - lockStarted,
          code: cause?.code === 'LOCK_TIMEOUT' ? 'local_execution_timeout' : 'local_execution_failed' });
        timing.failed = true;
        if (!acquired) timing.waitMs = Date.now() - queued;
        throw cause;
      });
      async function holdLock() {
        const lockWaitMs = Date.now() - lockStarted;
        const held = Date.now();
        timing.waitMs = held - queued;
        executionStep('lock_wait', lockWaitMs);
        try { return await holdLockedTransaction(lockWaitMs); }
        finally { timing.holdMs = Date.now() - held; executionStep('lock_hold', timing.holdMs); }
      }
      async function holdLockedTransaction(lockWaitMs) {
        // Journal only contended acquisitions; every tool call takes this lock.
        if (lockWaitMs >= 250) executionDiagnostic({ phase: 'lock_wait', state: 'completed', elapsedMs: lockWaitMs, slow: true });
        const root = rootFor(directory), gitDir = path.join(root, 'git');
        if (process.platform === 'win32') {
          await windowsOwner.ensureDirectory(root); await windowsOwner.ensureDirectory(path.join(root, 'objects'));
        } else await fs.mkdir(root, { recursive: true, mode: 0o700 });
        try { await fs.access(path.join(gitDir, 'HEAD')); }
        catch (error) { if (error.code !== 'ENOENT') throw error; await git(root, ['init', '--bare', '--quiet', gitDir]); }
        const db = await quietExecutionPhase('ledger_open', () => openChangeStore(root, gitDir, { ...storeOptions, syncObjects, persistentIndex: true }));
        const storedMeta = await db.get('meta.json');
        const originalMeta = JSON.stringify(storedMeta);
        const meta = storedMeta ?? { version: 1, directory, sequence: 0 };
        if (meta.version !== 1 || meta.directory !== directory) throw changeError('invalid_change_record');
        const repo = { directory, logicalDirectory, root, gitDir, db, meta, vcs };
        await withoutExecutionDeadline(() => quietExecutionPhase('ledger_recovery', () => recover(repo)));
        await assertCurrent?.();
        checkExecutionAdmission();
        const result = await quietExecutionPhase('ledger_transaction', () => fn(repo));
        await assertCurrent?.();
        checkExecutionAdmission();
        // A lease lookup must not stage an unchanged blob and rebuild Git's
        // index under the owner lock. Mutations still commit atomically.
        if (JSON.stringify(meta) !== originalMeta) db.set('meta.json', meta);
        const wrote = db.pendingCount > 0;
        await withoutExecutionDeadline(() => quietExecutionPhase('ledger_commit', () => db.commit({ assertCurrent })));
        if (wrote) noteLedgerCommit(root);
        timing.wrote = wrote;
        return result;
      }
    });
    // An expired waiter must not replace the actual owner in the queue.
    const tail = Promise.allSettled([previous, work]).then(() => undefined);
    queues.set(directory, tail);
    try { return await work; }
    catch (cause) {
      timing.failed = true;
      if (!timing.waitMs) timing.waitMs = Date.now() - queued;
      throw cause;
    }
    finally {
      lockTiming(timing);
      void tail.then(() => {
        if (queues.get(directory) === tail) { queues.delete(directory); queueMeters.delete(directory); }
      });
    }
  };
  // Why a snapshot read fell back to the lock (named in slow lock timings).
  const miss = (reason) => ({ miss: reason });
  // Ledger root -> tree committed before the intent its owner applies now.
  const materializing = new Map();
  // Lock-free answer from the last committed ledger tree. Any durable write
  // or error falls back to the locked path, which stays authoritative; this
  // only removes queueing for reads that would not change state (per-step
  // prompt registration, admission, lease and outcome lookups) behind long
  // reconciliation or publication work. Reads in flight are foreground work
  // that ledger maintenance yields to.
  const snapshotReads = new Set();
  const readSnapshot = (requested, fn) => {
    const work = readLedgerSnapshot(requested, fn), settled = () => snapshotReads.delete(work);
    snapshotReads.add(work); work.then(settled, settled);
    return work;
  };
  const readLedgerSnapshot = async (requested, fn) => {
    const { logicalDirectory, directory, vcs } = await resolveRepository(requested);
    const root = rootFor(directory), gitDir = path.join(root, 'git');
    try { await fs.access(path.join(gitDir, 'HEAD')); }
    catch (error) { if (error.code === 'ENOENT') return miss('absent'); throw error; }
    // While an owner in this process applies a publication or revert intent,
    // answer from the tree committed before that intent: the operation has not
    // completed, so a reader may still be ordered before it. Locked callers
    // keep queueing behind it; another process's intent still misses below.
    const before = materializing.get(root);
    const db = await quietExecutionPhase('ledger_snapshot', () => openChangeStore(root, gitDir, { ...storeOptions, syncObjects, ...(before ? { at: before } : {}) }));
    // A pending materialization may be unrecoverable (for example a foreign
    // edit); only the locked path can recover it or fail closed.
    if (!db.exists) return miss('absent');
    if (await db.get('materialization.json')) return miss('materialization');
    const meta = await db.get('meta.json');
    if (meta?.version !== 1 || meta.directory !== directory) return miss('meta');
    const repo = { directory, logicalDirectory, root, gitDir, db, meta: { ...meta }, vcs, snapshot: true };
    const result = await fn(repo);
    return db.pendingCount === 0 && repo.meta.sequence === meta.sequence ? { value: result } : miss('write');
  };
  const snapshotOrLocked = async (requested, fn, options) => {
    checkExecutionAdmission();
    let result;
    try { result = await readSnapshot(requested, fn); }
    catch { checkExecutionAdmission(); result = miss('error'); } // The locked path reports the authoritative error.
    return 'value' in result ? result.value : locked(requested, fn, { ...options, snapshotMiss: result.miss });
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
    const runs = [], rows = [];
    let marker = false, fenced = false, first = true;
    for await (const { value } of repo.db.entries(`${prefix}/${id}`)) {
      // The format page is valid only as a document's first page.
      if (first && ancestryFormatPage(value)) { fenced = true; first = false; continue; }
      first = false;
      if (fenced) {
        if (!Array.isArray(value)) throw changeError('invalid_change_record');
        rows.push(...value);
        continue;
      }
      // A marker is the document's only page.
      if (marker || (baselineMarker(value) && runs.length)) throw changeError('invalid_change_record');
      if (baselineMarker(value)) {
        const bytes = await bytesFor(repo, value.baseline);
        if (bytes.length !== value.size) throw changeError('invalid_change_record');
        runs.push(...initialMutationRuns(bytes.toString('latin1'), `${id}:baseline`));
        marker = true;
        continue;
      }
      if (!Array.isArray(value)) throw changeError('invalid_change_record');
      for (const run of value) runs.push({ ...run, text: Buffer.from(run.bytes, 'base64').toString('latin1') });
    }
    if (!fenced) return runs;
    try { return decodeMutationRunRows(rows); } catch { throw changeError('invalid_change_record'); }
  };
  // Format 1 rows: one per 32 KiB of text, each repeating the run's metadata.
  const formatOneRows = function* (runs) {
    for (const run of runs) {
      for (let offset = 0; offset < run.text.length; offset += 32_768) {
        const { text, bytes: _bytes, ...metadata } = run;
        yield { ...metadata, start: run.start + offset, bytes: Buffer.from(text.slice(offset, offset + 32_768), 'latin1').toString('base64') };
      }
    }
  };
  const saveRuns = async (repo, id, runs, prefix = 'runs', options) => {
    const baseline = baselineRefs() ? baselineText(runs, id) : null;
    if (baseline !== null) {
      // The object is normally present already; this also marks it for sync.
      const bytes = Buffer.from(baseline, 'latin1'), hash = await putBytes(repo, bytes);
      if (!options?.absent) for await (const { key: page } of repo.db.entries(`${prefix}/${id}`)) repo.db.remove(page);
      repo.db.set(`${prefix}/${id}/${BASELINE_PAGE}`, { baseline: hash, size: bytes.length });
      return;
    }
    if (!options?.absent) for await (const { key: page } of repo.db.entries(`${prefix}/${id}`)) repo.db.remove(page);
    // Only replacement ancestry differs between formats: runs that replace
    // nothing keep format 1 rows, which every host reads alike.
    if (!runs.some((run) => run.replaces.length)) {
      await repo.db.setList(`${prefix}/${id}`, formatOneRows(runs), { absent: true });
      return;
    }
    repo.db.set(`${prefix}/${id}/${BASELINE_PAGE}`, ANCESTRY_FORMAT);
    await repo.db.setList(`${prefix}/${id}`, encodeMutationRunRows(runs), { absent: true, firstPage: 1 });
  };
  // Replaces inline baselines written before markers, in batches under the
  // owner lock. Candidates are read lock-free from one snapshot; a batch
  // rewrites a document only while its `runs/<id>` subtree is still that
  // snapshot's, so a concurrent edit is never replaced. Each batch publishes
  // through the normal compare-and-swap ref update; lease refs keep pinned
  // trees and their inline pages reachable. Projected text is unchanged.
  const compactBaselines = async (root) => {
    if (!baselineRefs()) return;
    const stamp = path.join(root, BASELINE_COMPACTED);
    try { await fs.access(stamp); return; }
    catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
    const snapshot = { root, db: await openChangeStore(root, path.join(root, 'git'), { ...storeOptions, syncObjects }) };
    const meta = await snapshot.db.get('meta.json');
    if (meta?.version !== 1 || !path.isAbsolute(meta.directory ?? '')) return;
    // A moved or deleted project resolves elsewhere; never lock another root.
    const resolved = await resolveRepository(meta.directory).catch(() => null);
    if (!resolved || rootFor(resolved.directory) !== root) return;
    const candidates = [];
    let id = null, pages = [], runs = [], inline = true, visited = 0;
    const consider = async () => {
      const text = id !== null && inline ? baselineText(runs, id) : null;
      if (text === null) return;
      const bytes = Buffer.from(text, 'latin1');
      candidates.push({ id, pages, marker: { baseline: await putBytes(snapshot, bytes), size: bytes.length } });
    };
    for await (const { key: page, value } of snapshot.db.entries('runs')) {
      const doc = page.slice('runs/'.length, page.lastIndexOf('/'));
      if (doc !== id) {
        await consider();
        id = doc; pages = []; runs = []; inline = true;
        if (++visited % 64 === 0) await yieldToEventLoop();
      }
      pages.push(page);
      if (!Array.isArray(value)) { inline = false; continue; }
      for (const run of value) runs.push({ ...run, text: Buffer.from(run.bytes, 'base64').toString('latin1') });
    }
    await consider();
    // Read while the snapshot is still the published tree.
    const expected = await snapshot.db.prefixIdentities(candidates.map((candidate) => `runs/${candidate.id}`));
    let skipped = 0;
    for (let start = 0; start < candidates.length; start += COMPACT_BATCH) {
      const batch = candidates.slice(start, start + COMPACT_BATCH), prefixes = batch.map((candidate) => `runs/${candidate.id}`);
      await locked(meta.directory, async (repo) => {
        if (!repo || repo.root !== root) { skipped += batch.length; return; }
        const current = await repo.db.prefixIdentities(prefixes);
        for (const [index, candidate] of batch.entries()) {
          const prefix = prefixes[index];
          if (!expected.get(prefix) || current.get(prefix) !== expected.get(prefix)) { skipped += 1; continue; }
          for (const page of candidate.pages) repo.db.remove(page);
          repo.db.set(`${prefix}/${BASELINE_PAGE}`, candidate.marker);
        }
      }, { requireExisting: true, operation: 'ledger_compaction' });
      await new Promise((resolve) => setTimeout(resolve, WARM_BATCH_GAP_MS));
    }
    // Skipped documents changed meanwhile; the next maintenance retries them.
    if (!skipped) await fs.writeFile(stamp, '');
  };
  // Reduces closures stored before direct ancestry to the ranges that generate
  // them (`minimizeMutationAncestry` shows every closure is kept), one document
  // at a time. Documents are found from one lock-free snapshot listing, read in
  // short batches and reduced off the lock in time slices. Foreground ledger
  // work comes first: a slice starts only when no lock of this runtime is held
  // or queued and no snapshot read, view preparation or publication is in
  // flight, so a call waits at most one slice instead of once per step (beside
  // a 1.8M-entry document's pass, a begin otherwise took 1.2 s, not 0.13 s).
  // The new pages are written before the lock; under it, the document (fenced,
  // format 2) only swaps its page list, and only while its `runs/<id>` subtree
  // is still the snapshot's, so a concurrent edit is never replaced and is
  // retried by the next maintenance. Projected text is unchanged.
  const compactAncestry = async (root) => {
    if (!ancestryCompaction()) return;
    const stamp = path.join(root, ANCESTRY_COMPACTED);
    try { await fs.access(stamp); return; }
    catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
    const started = Date.now();
    const snapshot = { root, db: await openChangeStore(root, path.join(root, 'git'), { ...storeOptions, syncObjects }) };
    const meta = await snapshot.db.get('meta.json');
    if (meta?.version !== 1 || !path.isAbsolute(meta.directory ?? '')) return;
    // A moved or deleted project resolves elsewhere; never lock another root.
    const resolved = await resolveRepository(meta.directory).catch(() => null);
    if (!resolved || rootFor(resolved.directory) !== root) return;
    const foreground = () => [...queues.values(), ...snapshotReads, ...preparations.values(), ...settlements.values()];
    const yieldToForeground = async () => {
      await yieldToEventLoop();
      for (let busy = foreground(); busy.length; busy = foreground()) await Promise.allSettled(busy);
    };
    let sliceStarted = Date.now();
    const pace = async () => {
      if (Date.now() - sliceStarted < COMPACTION_SLICE_MS) return;
      await yieldToForeground(); sliceStarted = Date.now();
    };
    const documents = new Map();
    for await (const row of snapshot.db.committedRows('runs')) {
      const id = row.key.slice('runs/'.length, row.key.lastIndexOf('/'));
      const document = documents.get(id) ?? { rows: [], bytes: 0 };
      document.rows.push(row); document.bytes += row.size;
      documents.set(id, document);
      await pace();
    }
    for (const [id, document] of documents) {
      if (document.bytes < ANCESTRY_COMPACTION_ENTRIES * ANCESTRY_ENTRY_MIN_BYTES) documents.delete(id);
    }
    // Read while the snapshot is still the published tree.
    const expected = await snapshot.db.prefixIdentities([...documents.keys()].map((id) => `runs/${id}`));
    // A document's runs, or null when it holds too little ancestry or a
    // baseline marker. Its pages and rows are released before the reduction.
    const runsOf = async (document) => {
      const pages = [];
      for (let start = 0; start < document.rows.length;) {
        const batch = [];
        for (let bytes = 0; start < document.rows.length && (!batch.length || bytes + document.rows[start].size <= ANCESTRY_READ_BYTES); start++) {
          batch.push(document.rows[start]); bytes += document.rows[start].size;
        }
        for await (const { value } of snapshot.db.readRows(batch)) pages.push(value);
        await pace();
      }
      const body = pages.slice(ancestryFormatPage(pages[0]) ? 1 : 0);
      if (body.some((page) => !Array.isArray(page))) return null;
      const rows = body.flat();
      if (rows.reduce((sum, row) => sum + (Array.isArray(row?.replaces) ? row.replaces.length : 0), 0) < ANCESTRY_COMPACTION_ENTRIES) return null;
      return decodeMutationRunRows(rows);
    };
    let skipped = 0, compacted = 0;
    for (const [id, document] of documents) {
      let reduction;
      try {
        const runs = await runsOf(document);
        if (!runs) continue;
        reduction = await minimizeMutationAncestry(runs, { yieldNow: yieldToForeground, sliceMs: COMPACTION_SLICE_MS });
      } catch (cause) {
        // Read failures end the pass, which the next maintenance retries.
        if (cause?.code && cause.code !== 'invalid_change_record') throw cause;
        // Malformed or cyclic ancestry stays as stored; reading it is unchanged.
        diagnostic({ phase: 'ledger_ancestry_compaction', state: 'failed', code: 'ledger_ancestry_unsupported' });
        continue;
      }
      if (!reduction.changed) continue;
      const encoded = async function* () {
        for (let start = 0; start < reduction.runs.length; start += 256) {
          yield* encodeMutationRunRows(reduction.runs.slice(start, start + 256));
          await pace();
        }
      };
      // Pages are written before the lock; the locked commit only records them.
      const objects = await snapshot.db.writeList(encoded());
      const prefix = `runs/${id}`;
      const written = await locked(meta.directory, async (repo) => {
        if (!repo || repo.root !== root) return false;
        const current = await repo.db.prefixIdentities([prefix]);
        if (!expected.get(prefix) || current.get(prefix) !== expected.get(prefix)) return false;
        for (const row of document.rows) repo.db.remove(row.key);
        repo.db.set(`${prefix}/${BASELINE_PAGE}`, ANCESTRY_FORMAT);
        repo.db.setListObjects(prefix, objects, { firstPage: 1 });
        return true;
      }, { requireExisting: true, operation: 'ledger_compaction' });
      if (written) compacted += 1; else skipped += 1;
      await new Promise((resolve) => setTimeout(resolve, WARM_BATCH_GAP_MS));
    }
    if (compacted) diagnostic({ phase: 'ledger_ancestry_compaction', state: 'completed', count: compacted, elapsedMs: Date.now() - started });
    if (!skipped) await fs.writeFile(stamp, '');
  };
  const revisionsFor = async (repo, id) => {
    const revisions = [];
    for await (const revision of repo.db.list(`revisions/${id}`)) revisions.push(revision);
    return revisions;
  };
  const projection = async (repo, doc, disabled, { preview = false } = {}) => {
    const all = await revisionsFor(repo, doc.id);
    const revisions = all.filter((revision) => revision.owner === null || !disabled.has(revision.owner));
    const latest = revisions.at(-1);
    if (!latest) return null;
    const name = revisions.findLast((revision) => revision.path !== undefined)?.path ?? all[0]?.path;
    const mode = revisions.findLast((revision) => revision.mode !== undefined)?.mode ?? all[0]?.mode;
    const access = revisions.findLast((revision) => revision.permissions !== undefined)?.permissions;
    if (latest.deleted) return { path: name, sequence: latest.sequence, deleted: true };
    const content = revisions.findLast((revision) => revision.hash !== undefined);
    const bytes = content?.binary ? null : Buffer.from(mutationText(await runsFor(repo, doc.id), disabled), 'latin1');
    const hash = content?.binary ? content.hash : preview ? digest(bytes) : await putBytes(repo, bytes);
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
  // One parsed listing of the committed `files` documents per tree identity,
  // shared by every reader of that tree: the winning document per published
  // path (as readActivePaths: highest sequence, earliest on a tie) and every
  // document per path, in listing order. Staged writes do not invalidate it,
  // so a preparation and the publication that follows it read the documents
  // once. The records are shared and never mutated; activePaths copies them.
  // A new listing reuses the previous one's records whose object id is
  // unchanged: a publication changes a few documents, but every one of a
  // 13k-file project's documents was read and parsed again after each.
  // Kill switch: DEVRYAN_LEDGER_INCREMENTAL_FILE_INDEX=0.
  const fileIndexes = new Map();
  const fileIndexRecords = new Map();
  const EMPTY_INDEX = Object.freeze({ winners: new Map(), byPath: new Map() });
  const committedFileIndex = async (repo) => {
    if (!repo.db.tree) return EMPTY_INDEX;
    const identity = await repo.db.committedIdentity('files');
    if (!identity) return EMPTY_INDEX;
    const cacheKey = `${repo.root}\0${identity}`;
    let work = fileIndexes.get(cacheKey);
    if (work) fileIndexes.delete(cacheKey);
    else {
      work = (async () => {
        // A read-only store of the committed tree never lists a staged row.
        const committed = await openChangeStore(repo.root, path.join(repo.root, 'git'), { ...storeOptions, syncObjects, at: repo.db.tree });
        const previous = process.env.DEVRYAN_LEDGER_INCREMENTAL_FILE_INDEX === '0' ? null : fileIndexRecords.get(repo.root);
        const records = new Map(), rows = [], missing = [];
        if (previous) {
          for await (const row of committed.committedRows('files')) {
            rows.push(row);
            const known = previous.get(row.key);
            if (known?.oid === row.oid) records.set(row.key, known); else missing.push(row);
          }
          for await (const { key: documentKey, oid, value } of committed.readRows(missing)) records.set(documentKey, { oid, value });
        } else {
          for await (const { key: documentKey, oid, value } of committed.entries('files')) {
            rows.push({ key: documentKey }); records.set(documentKey, { oid, value });
          }
        }
        // Records of the two most recently indexed projects only: each holds
        // every file document of its ledger (13k on a large project).
        fileIndexRecords.delete(repo.root); fileIndexRecords.set(repo.root, records);
        while (fileIndexRecords.size > 2) fileIndexRecords.delete(fileIndexRecords.keys().next().value);
        const winners = new Map(), byPath = new Map();
        for (const { key: documentKey } of rows) {
          const { value } = records.get(documentKey);
          if (!value.published) continue;
          const file = value.published.path, list = byPath.get(file);
          if (list) list.push([documentKey, value]); else byPath.set(file, [[documentKey, value]]);
          if (!winners.has(file) || (winners.get(file).published.sequence ?? 0) < (value.published.sequence ?? 0)) winners.set(file, value);
        }
        return { winners, byPath };
      })();
      void work.catch(() => {
        if (fileIndexes.get(cacheKey) === work) fileIndexes.delete(cacheKey);
        fileIndexRecords.delete(repo.root);
      });
    }
    fileIndexes.set(cacheKey, work);
    while (fileIndexes.size > 2) fileIndexes.delete(fileIndexes.keys().next().value);
    return work;
  };
  const recordCacheOff = () => process.env.DEVRYAN_LEDGER_RECORD_CACHE === '0';
  const activePaths = async (repo) => recordCacheOff() || repo.db.pendingCount !== 0 ? readActivePaths(repo)
    : new Map([...(await committedFileIndex(repo)).winners].map(([file, doc]) => [file, structuredClone(doc)]));
  // Read-only callers share the committed winners; no copy is made.
  const snapshotPaths = async (repo) => process.env.DEVRYAN_LEDGER_SNAPSHOT_REUSE === '0' || recordCacheOff() || repo.db.pendingCount !== 0
    ? readActivePaths(repo) : (await committedFileIndex(repo)).winners;
  // activePaths restricted to `paths` inside a transaction, without reading
  // every document again: the same winner among the committed documents this
  // transaction has not staged and the staged ones. Read-only.
  // Kill switch: DEVRYAN_LEDGER_PATH_WINNERS=0.
  const activePathsFor = async (repo, paths, overrides = new Map()) => {
    if (process.env.DEVRYAN_LEDGER_PATH_WINNERS === '0' || recordCacheOff()) {
      const result = new Map(), seen = new Set();
      const consider = (value) => {
        const file = value?.published?.path;
        if (paths.has(file) && (!result.has(file) || (result.get(file).published.sequence ?? 0) < (value.published.sequence ?? 0))) result.set(file, value);
      };
      for await (const { key: documentKey, value } of repo.db.entries('files')) {
        seen.add(documentKey); consider(overrides.has(documentKey) ? overrides.get(documentKey) : value);
      }
      for (const [documentKey, value] of overrides) if (!seen.has(documentKey)) consider(value);
      return result;
    }
    const staged = await repo.db.staged('files'), { byPath } = await committedFileIndex(repo);
    for (const [documentKey, value] of overrides) staged.set(documentKey, value);
    const orderedStaged = [...staged].sort(([a], [b]) => a.localeCompare(b));
    const result = new Map();
    for (const file of paths) {
      let winner = null;
      const consider = (value) => {
        if (value?.published?.path === file && (!winner || (winner.published.sequence ?? 0) < (value.published.sequence ?? 0))) winner = value;
      };
      for (const [documentKey, value] of byPath.get(file) ?? []) if (!staged.has(documentKey)) consider(value);
      for (const [, value] of orderedStaged) consider(value);
      if (winner) result.set(file, winner);
    }
    return result;
  };
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
    let visited = 0;
    for (let level = ['']; level.length;) {
      const directories = [];
      for (const relative of level) {
        walk.assertCurrent?.();
        for (const entry of await listDirectory(path.join(root, relative))) {
          checkExecutionAdmission();
          walk.assertCurrent?.();
          if (entry.name === '.git' || path.resolve(root, relative, entry.name) === storage) continue;
          if (++visited > (walk.maxEntries ?? Infinity)) throw changeError('ledger_warm_budget', 409);
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
    for await (const file of walkFiles(directory, walk)) if (safeChangePath(file)) {
      found.push(file);
      if (found.length > (walk.maxFiles ?? Infinity)) throw changeError('ledger_warm_budget', 409);
    }
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
  // observation; a real call supersedes it, then runs or joins an
  // authoritative pass that started after its reservation.
  const observe = async (lease, { warm = false, refresh = false, maxFiles = Infinity, maxBytes = Infinity } = {}) => {
    const joinable = (pass) => pass && (warm || (pass.authoritative && pass.started >= lease.reservedAt));
    const previous = observations.get(lease.projectDirectory);
    if (!warm && previous && !previous.authoritative) previous.superseded = true;
    if (joinable(previous)) {
      try { return await waitForExecutionQueue(previous.work, previous.progress); }
      catch { checkExecutionAdmission(); } // The observing caller may have been cancelled independently.
    }
    if (previous) await waitForExecutionQueue(previous.work.catch(() => {}), previous.progress);
    // Recheck after waiting: another reservation may have installed the next
    // sufficiently fresh pass while this caller was queued.
    const current = observations.get(lease.projectDirectory);
    if (!warm && current && current !== previous && !current.authoritative) {
      current.superseded = true;
      await waitForExecutionQueue(current.work.catch(() => {}), current.progress);
    }
    if (current && current !== previous && joinable(current)) {
      try { return await waitForExecutionQueue(current.work, current.progress); }
      catch { checkExecutionAdmission(); }
    }
    const pass = { started: Date.now(), work: null, progress: executionProgressMeter(), authoritative: !warm };
    const assertCurrent = () => {
      if (warm && pass.superseded) throw changeError('ledger_warm_superseded', 409);
    };
    pass.work = (async () => {
      const root = rootFor(lease.projectDirectory), gitDir = path.join(root, 'git');
      let dirty, attempts = 0, installed = 0, recorded = 0, restamped = 0, ingestedBytes = 0, skipped = null, inputs = new Set();
      do {
        if (++attempts > 4) throw changeError('workspace_changing', 503);
        dirty = false;
        const snapshot = { directory: lease.projectDirectory, root, gitDir, db: await openChangeStore(root, gitDir, { ...storeOptions, syncObjects }) };
        // Read-only here: reuse the listing cached by immutable `files` tree identity.
        const paths = await snapshotPaths(snapshot);
        const walk = { classifier: await classifierFor(snapshot.directory, lease.vcs !== false, warm), strict: warm, inputs: new Set(),
          ...(warm ? { maxFiles, maxEntries: maxFiles * 4, assertCurrent } : {}) };
        const names = await observedNames(snapshot.directory, paths, walk);
        inputs = walk.inputs;
        if (names.size > maxFiles) { skipped = 'too-large'; break; }
        const fast = fastIngest(), restamp = fast && (!warm || refresh) && restampBatching();
        const batchRows = fast && (paths.size === 0 || restamp) ? initialInstallBatch : installBatch;
        const changedBatchRows = fast && paths.size === 0 ? initialInstallBatch : installBatch;
        // The walk just listed these directories; each is checked for symlinks
        // once per pass instead of once per file below it. Advisory only: the
        // install below re-stamps every changed file without this memo.
        const ancestors = process.env.DEVRYAN_LEDGER_ANCESTOR_MEMO === '0' ? undefined : new Set();
        let rows = [], rowBytes = 0, changedRows = 0, carried = null;
        const install = async () => {
          if (!rows.length) return;
          assertCurrent();
          let written = null;
          await locked(lease.directory, async (repo) => {
            // While no other writer has committed since this pass's previous
            // batch, its parsed state is still exact; re-reading every record
            // per batch made a first build quadratic.
            const reuse = carried && repo.db.tree === carried.tree;
            const latest = reuse ? carried.latest : await activePaths(repo), disabled = reuse ? carried.disabled : await inactive(repo);
            // Same checks, same lock; only the independent lstat work overlaps.
            const stamps = restamp
              ? await mapBounded(rows, (row) => { checkExecutionAdmission(); return mutationFileStamp(repo.directory, row.file); })
              : null;
            let done = rows.length;
            for (const [index, row] of rows.entries()) {
              if (warm && index && index % WARM_YIELD_ROWS === 0 && queuedCalls.has(repo.directory)) { done = index; break; }
              const doc = latest.get(row.file);
              if (JSON.stringify(doc?.published ?? null) !== JSON.stringify(row.published)
                || (stamps ? stamps[index] : await mutationFileStamp(repo.directory, row.file)) !== (row.entry?.observation ?? null)) { dirty = true; continue; }
              if (equal(doc?.published, row.entry)) {
                if (doc?.published && row.entry) { doc.published = { ...doc.published, ...row.entry }; repo.db.set(key('files', doc.id), doc); restamped += 1; }
                continue;
              }
              recorded += 1;
              const operation = doc ? { id: randomUUID(), sequence: next(repo), active: true, origin: 'external', scope: null } : null;
              const changed = await recordFile(repo, { doc, entry: row.entry, file: row.file, operation, disabled });
              changed.published = row.entry ? { ...row.entry, path: row.file, sequence: operation?.sequence ?? 0 } : null;
              repo.db.set(key('files', changed.id), changed);
              if (changed.published) latest.set(row.file, changed); else latest.delete(row.file);
              if (operation) { operation.files = [changed.id]; repo.db.set(key('operations', operation.id), operation); }
              executionProgress();
            }
            written = { db: repo.db, latest, disabled, done };
          }, { operation: warm ? 'ledger_warm_install' : 'observation_install', ...(warm ? { assertCurrent } : {}) });
          // The store's tree is the one this batch committed (or read, if it
          // changed nothing); the next batch reuses state only from that tree.
          carried = fast && written ? { tree: written.db.tree, latest: written.latest, disabled: written.disabled } : null;
          executionProgress();
          // A yielded warm batch keeps its uninstalled rows for the next one.
          const done = written?.done ?? rows.length;
          installed += done;
          rows = rows.slice(done); rowBytes = 0; changedRows = 0;
          for (const row of rows) {
            rowBytes += row.entry && !row.entry.whole ? row.entry.size : 0;
            if (!equal(row.published, row.entry)) changedRows += 1;
          }
          if (warm) await new Promise((resolve) => setTimeout(resolve, WARM_BATCH_GAP_MS));
        };
        const ordered = [...names];
        for (let start = 0; start < ordered.length && !skipped; start += 64) {
          assertCurrent();
          await yieldToEventLoop();
          const observed = await mapBounded(ordered.slice(start, start + 64), async (file) => {
            checkExecutionAdmission();
            const published = paths.get(file)?.published ?? null;
            // Advisory only. Publication and projection always inspect affected
            // current bytes again; legacy records have no observation and rehash.
            if (published?.observation && (syncWalks() ? mutationFileStampSync(snapshot.directory, file, ancestors)
              : await mutationFileStamp(snapshot.directory, file, ancestors)) === published.observation) {
              executionProgress();
              return null;
            }
            try { return { file, published, entry: await inspect(snapshot, file) }; }
            catch (cause) { if (cause.code !== 'observation_changed') throw cause; dirty = true; return null; }
          });
          for (const row of observed) {
            if (!row || (!row.published && !row.entry)) continue;
            rows.push(row);
            if (!equal(row.published, row.entry)) changedRows += 1;
            // Only granular text is staged in memory; whole-content files are not.
            rowBytes += row.entry && !row.entry.whole ? row.entry.size : 0;
            ingestedBytes += row.entry?.size ?? 0;
            if (rows.length >= batchRows || changedRows >= changedBatchRows || rowBytes >= INSTALL_BATCH_BYTES) await install();
            if (ingestedBytes > maxBytes) { skipped = 'too-large'; break; }
          }
        }
        while (rows.length) await install();
      } while (dirty && !warm && !skipped);
      // Counts only (no paths): shows what drove a large reconciliation, such
      // as a checkout or tool that rewrote many files with identical bytes.
      if (recorded >= INSTALL_BATCH) executionDiagnostic({ phase: 'reconciliation_install', state: 'completed', count: recorded });
      if (restamped >= INSTALL_BATCH) executionDiagnostic({ phase: 'reconciliation_restamp', state: 'completed', count: restamped });
      // Marks that a background build is not to be repeated: a completed pass,
      // or one that met the warm budget (the first real call builds the rest).
      await fs.writeFile(path.join(root, 'observed'), '');
      // A large first build leaves one loose object per record: pack now.
      if (installed >= maintenanceLimits.looseObjects) void maintainLedger(root);
      return { inputs: [...inputs].sort(), ...(skipped ? { skipped } : {}) };
    })().catch(cause => {
      if (warm && ['ledger_warm_budget', 'ledger_warm_superseded'].includes(cause?.code)) {
        return { skipped: cause.code === 'ledger_warm_budget' ? 'too-large' : 'foreground' };
      }
      throw cause;
    });
    observations.set(lease.projectDirectory, pass);
    try { return await pass.work; }
    finally { if (observations.get(lease.projectDirectory) === pass) observations.delete(lease.projectDirectory); }
  };
  // `fence(path)` withholds documents inside dependency inputs from history
  // replay: the ledger no longer observes those paths, so writing old content
  // there could overwrite an unrecorded edit. Their records stay unchanged.
  const materializationTargets = async (repo, documents, disabled, { fence, preview = false } = {}) => {
    const paths = new Set(), updates = new Map();
    for (const doc of documents) {
      if (fence && doc.published && fence(doc.published.path)) continue;
      const after = await projection(repo, doc, disabled, { preview });
      if (fence && after && fence(after.path)) continue;
      if (doc.published) paths.add(doc.published.path);
      if (after) paths.add(after.path);
      updates.set(key('files', doc.id), { ...doc, published: after });
    }
    const rows = [], winners = await activePathsFor(repo, paths, updates);
    for (const file of paths) {
      const winner = winners.get(file)?.published;
      const after = winner?.deleted ? null : winner ?? null;
      const before = await inspect(repo, file, undefined, { preview });
      rows.push({ path: file, before, after, ...(after && winners.get(file) ? { documentID: winners.get(file).id } : {}) });
    }
    return { paths, updates, rows };
  };
  const materialize = async (repo, documents, accept, { fence } = {}) => {
    const disabled = await inactive(repo);
    const { updates, rows: targets } = await materializationTargets(repo, documents, disabled, { fence });
    for (const [documentKey, doc] of updates) repo.db.set(documentKey, doc);
    const rows = targets.filter(row => !equal(row.before, row.after));
    if (rows.length) {
      const id = randomUUID();
      await repo.db.setList(`materializations/${id}`, rows);
      repo.db.set('materialization.json', { id });
    }
    const files = rows.map((row) => ({ path: row.path, status: !row.before ? 'added' : !row.after ? 'deleted' : 'modified' }))
      .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    // Commit the result and decision in the same durable intent as its writes.
    // Recovery must not rediscover an empty diff and lose the original receipt.
    await accept?.(files);
    repo.db.set('meta.json', repo.meta);
    // Snapshot readers answer from the tree before this intent until it is
    // applied (readSnapshot); only while this owner applies it.
    if (rows.length && repo.db.tree && !repo.snapshot) materializing.set(repo.root, repo.db.tree);
    try {
      await repo.db.commit();
      await recover(repo);
    } finally { if (rows.length) materializing.delete(repo.root); }
    return files;
  };
  // Native holds live in the same committed session rows as Revert ownership.
  // The sum is monotonic along a fixed lineage; sibling holds do not revoke it.
  const nativeAdmission = async (repo, sessionID) => {
    const holds = [], seen = new Set();
    let revision = 0, reverting = false;
    for (let id = sessionID; id;) {
      if (seen.has(id)) throw changeError('invalid_session_lineage');
      seen.add(id);
      const session = await repo.db.get(key('sessions', id));
      if (!session) break;
      if (session.directory && session.directory !== repo.logicalDirectory) throw changeError('session_directory_mismatch');
      const state = session.nativeAdmission ?? { revision: 0, holds: [] };
      if (!Number.isSafeInteger(state.revision) || state.revision < 0 || !Array.isArray(state.holds)) throw changeError('invalid_change_record');
      revision += state.revision;
      reverting ||= Boolean(session.pending);
      holds.push(...state.holds.map((hold) => ({ ...hold, sessionID: id })));
      id = session.parentID;
    }
    return { revision, held: reverting || holds.length > 0, reverting, holds };
  };
  const assertNativeAdmission = async (repo, sessionID) => {
    const state = await nativeAdmission(repo, sessionID);
    if (state.reverting) throw changeError('session_reverting');
    if (state.held) throw changeError('native_session_held');
    return state;
  };
  const removalHold = (session, intent) => {
    const state = session.nativeAdmission ?? { revision: 0, holds: [] };
    const ownerID = `native-removal:${intent.id}`;
    if (!state.holds.some(hold => hold.ownerID === ownerID)) session.nativeAdmission = {
      ...state, revision: state.revision + 1, holds: [...state.holds, { id: randomUUID(), ownerID, removalID: intent.id }],
    };
  };
  const beginNativeRemoval = input => locked(input.directory, async repo => {
    if (!validID(input.rootSessionID) || !validID(input.ownerID)) throw changeError('invalid_capture_identity', 400);
    const session = await repo.db.get(key('sessions', input.rootSessionID));
    if (!session || session.pending) throw changeError('mutation_history_unavailable');
    for await (const { value } of repo.db.entries('native-removals')) {
      if (value.rootSessionID === input.rootSessionID && value.state !== 'completed') {
        if (value.ownerID !== input.ownerID) throw changeError('native_removal_owner_mismatch');
        return value;
      }
      if (value.state === 'completed') continue;
      // Finish a descendant's decision before an ancestor can add a hold that
      // would prevent that descendant's authorized retry.
      const seen = new Set();
      for (let id = value.rootSessionID; id;) {
        if (id === input.rootSessionID) throw changeError('native_removal_in_progress', 409);
        if (seen.has(id)) throw changeError('invalid_session_lineage');
        seen.add(id);
        id = (await repo.db.get(key('sessions', id)))?.parentID;
      }
    }
    const quietHold=input.quietHold;
    if(quietHold){
      const state=session.nativeAdmission;
      if(session.pending||!state||state.revision!==quietHold.revision||state.holds.length!==1
        ||state.holds[0].id!==quietHold.id||state.holds[0].ownerID!==input.ownerID
        ||state.holds[0].retentionInstanceID!==quietHold.retentionInstanceID)throw changeError('native_retention_hold_changed');
      session.nativeAdmission={...state,revision:state.revision+1,holds:[]};
    }else await assertNativeAdmission(repo,input.rootSessionID);
    const intent = { id: randomUUID(), directory: input.directory, rootSessionID: input.rootSessionID,
      ownerID: input.ownerID, state: 'preparing', ...(quietHold?{quiet:true}:{}), members: [{ id: session.id, parentID: session.parentID ?? null,
        directory: input.directory, generation: session.generation }], removed: [], dispositions: [] };
    removalHold(session, intent); repo.db.set(key('sessions', session.id), session);
    repo.db.set(key('native-removals', intent.id), intent); return intent;
  });
  const nativeRemoval = input => snapshotOrLocked(input.directory, repo => repo.db.get(key('native-removals', input.intentID)));
  const nativeRemovals = input => snapshotOrLocked(input.directory, async repo => {
    const result = [];
    for await (const { value } of repo.db.entries('native-removals')) if (value.state !== 'completed') result.push(value);
    return result;
  });
  // Constructor recovery uses the immutable ref retained by the verified clone.
  // A foreign live intent is never sufficient evidence for taking ownership.
  const recoverNativeRemovalOwnership = input => locked(input.directory, async repo => {
    if (!validID(input.ownerID) || !validID(input.checkpointID) || !/^[a-f0-9]{40,64}$/.test(input.sourceOID ?? '')
      || input.sourceOwnerID !== undefined && !validID(input.sourceOwnerID)) throw changeError('native_removal_inheritance_invalid');
    const ref = `refs/devryan/migration/${input.checkpointID}/state`;
    const oid = (await git(repo.root, ['--git-dir', repo.gitDir, 'rev-parse', '--verify', ref])).toString().trim();
    if (oid !== input.sourceOID) throw changeError('native_removal_inheritance_invalid');
    const inherited = [], released = new Map();
    for await (const { key: intentKey, value: intent } of repo.db.entries('native-removals')) {
      if (intent.state === 'completed' || intent.ownerID === input.ownerID) continue;
      let source;
      try { source = JSON.parse((await git(repo.root, ['--git-dir', repo.gitDir, 'show', `${ref}:${intentKey}`])).toString()); }
      catch { throw changeError('native_removal_inheritance_invalid'); }
      // Relocation changes only directory fields; every terminal decision stays exact.
      if (!source || !Array.isArray(source.members)) throw changeError('native_removal_inheritance_invalid');
      source.directory = input.directory;
      source.members = source.members.map(member => ({ ...member, directory: input.directory }));
      if (JSON.stringify(source) !== JSON.stringify(intent) || !intent.members.length
        || !intent.members.some(member => member.id === intent.rootSessionID)) throw changeError('native_removal_inheritance_invalid');
      // A settled previous controller may have left its own plain admission
      // hold beside the removal hold; its restart would have released it, so
      // adoption releases it too. Any other hold still refuses inheritance.
      const settledOwners = new Set([intent.ownerID, input.sourceOwnerID].filter(Boolean));
      const isRemovalHold = hold => hold.removalID === intent.id && hold.ownerID === `native-removal:${intent.id}`;
      const isSettledHold = hold => settledOwners.has(hold.ownerID) && validID(hold.id)
        && Object.keys(hold).every(name => name === 'id' || name === 'ownerID');
      for (const member of intent.members) {
        const session = released.get(member.id) ?? await repo.db.get(key('sessions', member.id));
        const holds = session?.nativeAdmission?.holds;
        if (!session || session.pending || session.generation !== member.generation
          || (session.parentID ?? null) !== member.parentID || !holds?.some(isRemovalHold)
          || holds.some(hold => !isRemovalHold(hold) && !isSettledHold(hold))) throw changeError('native_removal_inheritance_invalid');
        const kept = holds.filter(hold => !isSettledHold(hold));
        if (kept.length !== holds.length) released.set(member.id, { ...session,
          nativeAdmission: { ...session.nativeAdmission, revision: session.nativeAdmission.revision + 1, holds: kept } });
      }
      inherited.push({ intentKey, intent });
    }
    for (const [sessionID, session] of released) repo.db.set(key('sessions', sessionID), session);
    for (const { intentKey, intent } of inherited) repo.db.set(intentKey, { ...intent, ownerID: input.ownerID });
    return inherited.length;
  });
  const commitNativeRemoval = input => locked(input.directory, async repo => {
    const intent = await repo.db.get(key('native-removals', input.intentID));
    if (!intent || intent.ownerID !== input.ownerID || intent.state !== 'preparing') throw changeError('native_removal_state_conflict');
    if (!Array.isArray(input.members) || !input.members.length || input.members.length > 10000) throw changeError('native_removal_tree_invalid');
    const byID = new Map(input.members.map(member => [member.id, member]));
    if (byID.size !== input.members.length || !byID.has(intent.rootSessionID)) throw changeError('native_removal_tree_invalid');
    const root = await repo.db.get(key('sessions', intent.rootSessionID));
    if (!root || root.generation !== intent.members.find(member => member.id === intent.rootSessionID)?.generation || root.pending) throw changeError('native_removal_generation_changed');
    const members = [], records = [];
    for (const member of input.members) {
      if (!validID(member.id) || member.directory !== input.directory) throw changeError('native_removal_tree_invalid');
      const seen = new Set();
      for (let current = member; current.id !== intent.rootSessionID; current = byID.get(current.parentID)) {
        if (seen.has(current.id) || !byID.has(current.parentID)) throw changeError('native_removal_tree_invalid');
        seen.add(current.id);
      }
      let session = await repo.db.get(key('sessions', member.id));
      const captured = intent.members.find(item => item.id === member.id);
      if (session && (session.pending || (session.parentID ?? null) !== (member.parentID ?? null)
        || captured && captured.generation !== session.generation)) throw changeError('native_removal_tree_changed');
      session ??= { id: member.id, parentID: member.parentID ?? null, generation: 0, pending: null, directory: input.directory };
      records.push(session);
      members.push({ id: member.id, parentID: member.parentID ?? null, directory: input.directory, generation: session.generation });
    }
    // Authorization is checked after all asynchronous ledger reads, inside the
    // existing owner lock, immediately before sealing the terminal decision.
    if (input.prepareOnly !== true) await input.beforeCommit?.();
    for (const session of records) { removalHold(session, intent); repo.db.set(key('sessions', session.id), session); }
    intent.members = members; intent.state = input.prepareOnly === true ? 'preparing' : 'committed'; repo.db.set(key('native-removals', intent.id), intent); return intent;
  });
  const acknowledgeNativeRemoval = input => locked(input.directory, async repo => {
    const intent = await repo.db.get(key('native-removals', input.intentID));
    if (!intent || intent.state !== 'committed' || intent.ownerID !== input.ownerID
      || !intent.members.some(member => member.id === input.sessionID)) throw changeError('native_removal_state_conflict');
    if (!Array.isArray(input.inboxIDs) || !Array.isArray(input.pendingIDs)
      || [...input.inboxIDs, ...input.pendingIDs].some(id => !validID(id))) throw changeError('invalid_capture_identity');
    const disposition = intent.dispositions.find(item => item.sessionID === input.sessionID);
    if (!disposition) throw changeError('native_removal_disposition_missing');
    if (JSON.stringify(disposition.inboxIDs) !== JSON.stringify(input.inboxIDs)
      || JSON.stringify(disposition.pendingIDs) !== JSON.stringify(input.pendingIDs)) throw changeError('native_removal_disposition_changed');
    if (!intent.removed.includes(input.sessionID)) {
      intent.removed.push(input.sessionID);
      const session = await repo.db.get(key('sessions', input.sessionID));
      session.nativeAdmission = { ...session.nativeAdmission, continuations: [] };
      session.nativeRemoved = intent.id;
      repo.db.set(key('sessions', input.sessionID), session);
      repo.db.set(key('native-removals', intent.id), intent);
    }
    return intent;
  });
  const stageNativeRemovalMember = input => locked(input.directory, async repo => {
    const intent = await repo.db.get(key('native-removals', input.intentID));
    if (!intent || intent.state !== 'committed' || intent.ownerID !== input.ownerID
      || !intent.members.some(member => member.id === input.sessionID)) throw changeError('native_removal_state_conflict');
    if (!Array.isArray(input.inboxIDs) || !Array.isArray(input.pendingIDs)
      || [...input.inboxIDs, ...input.pendingIDs].some(id => !validID(id))) throw changeError('invalid_capture_identity');
    const previous = intent.dispositions.find(item => item.sessionID === input.sessionID);
    const next = { sessionID: input.sessionID, inboxIDs: input.inboxIDs, pendingIDs: input.pendingIDs };
    if (previous && JSON.stringify(previous) !== JSON.stringify(next)) throw changeError('native_removal_disposition_changed');
    if (!previous) { intent.dispositions.push(next); repo.db.set(key('native-removals', intent.id), intent); }
    return intent;
  });
  const completeNativeRemoval = input => locked(input.directory, async repo => {
    const intent = await repo.db.get(key('native-removals', input.intentID));
    if (!intent || intent.ownerID !== input.ownerID || intent.removed.length !== intent.members.length) throw changeError('native_removal_incomplete');
    intent.state = 'completed'; repo.db.set(key('native-removals', intent.id), intent); return intent;
  });
  const abandonQuietNativeRemoval=input=>locked(input.directory,async repo=>{
    const intent=await repo.db.get(key('native-removals',input.intentID));
    if(!intent||intent.ownerID!==input.ownerID||!intent.quiet||intent.state!=='preparing'||intent.dispositions.length||intent.removed.length)throw changeError('native_removal_state_conflict');
    for(const member of intent.members){
      const file=key('sessions',member.id),session=await repo.db.get(file),state=session?.nativeAdmission;
      if(!state)continue;
      session.nativeAdmission={...state,revision:state.revision+1,holds:state.holds.filter(hold=>hold.ownerID!==`native-removal:${intent.id}`)};repo.db.set(file,session);
    }
    repo.db.remove(key('native-removals',intent.id));
  });
  const nativeRetentionHolds=input=>snapshotOrLocked(input.directory,async repo=>{
    const result=[];
    for await(const {value:session}of repo.db.entries('sessions'))for(const hold of session.nativeAdmission?.holds??[])if(hold.ownerID===input.ownerID&&hold.retentionInstanceID){
      if(result.length>=512)throw changeError('native_retention_tree_unbounded');result.push({...hold,sessionID:session.id,revision:session.nativeAdmission.revision});
    }
    return result;
  });
  const registerNativeSession = (input) => snapshotOrLocked(input.directory, async (repo) => {
    if (!validID(input.sessionID) || (input.parentID !== undefined && input.parentID !== null && !validID(input.parentID))) throw changeError('invalid_capture_identity', 400);
    const sessionKey = key('sessions', input.sessionID), previous = await repo.db.get(sessionKey);
    if (previous && previous.parentID !== (input.parentID ?? null)) throw changeError('invalid_session_lineage');
    if (previous?.directory && previous.directory !== repo.logicalDirectory) throw changeError('session_directory_mismatch');
    if (input.parentID && !await repo.db.get(key('sessions', input.parentID))) throw changeError('mutation_parent_unavailable');
    if (!previous && input.parentID) await assertNativeAdmission(repo, input.parentID);
    if (!previous) repo.db.set(sessionKey, { id: input.sessionID, parentID: input.parentID ?? null, generation: 0, pending: null, directory: repo.logicalDirectory });
    return nativeAdmission(repo, input.sessionID);
  });
  const nativeAdmissionState = (input) => snapshotOrLocked(input.directory, async (repo) => {
    if (!validID(input.sessionID)) throw changeError('invalid_capture_identity', 400);
    return nativeAdmission(repo, input.sessionID);
  });
  const holdNativeAdmission = (input) => locked(input.directory, async (repo) => {
    if (!validID(input.sessionID) || !validID(input.ownerID)) throw changeError('invalid_capture_identity', 400);
    const sessionKey = key('sessions', input.sessionID), session = await repo.db.get(sessionKey);
    if (!session) throw changeError('mutation_history_unavailable');
    const state = session.nativeAdmission ?? { revision: 0, holds: [] };
    const previous = state.holds.find((hold) => hold.ownerID === input.ownerID);
    if(input.retentionInstanceID&&(!validID(input.retentionInstanceID)||previous&&previous.retentionInstanceID!==input.retentionInstanceID))throw changeError('native_hold_owner_mismatch');
    if (previous && (!session.pending || previous.transactionID === session.pending)) return { ...previous, revision: state.revision };
    const hold = previous ? { ...previous, transactionID: session.pending }
      : { id: randomUUID(), ownerID: input.ownerID, ...(input.retentionInstanceID?{retentionInstanceID:input.retentionInstanceID}:{}), ...(session.pending ? { transactionID: session.pending } : {}) };
    session.nativeAdmission = { ...state, revision: state.revision + 1,
      holds: previous ? state.holds.map((item) => item === previous ? hold : item) : [...state.holds, hold] };
    repo.db.set(sessionKey, session);
    return { ...hold, revision: session.nativeAdmission.revision };
  });
  const releaseNativeAdmission = (input) => locked(input.directory, async (repo) => {
    if (!validID(input.sessionID) || !validID(input.ownerID) || !validID(input.holdID) || !Number.isSafeInteger(input.expectedRevision)) throw changeError('invalid_capture_identity', 400);
    const sessionKey = key('sessions', input.sessionID), session = await repo.db.get(sessionKey), state = session?.nativeAdmission;
    if (!state || state.revision !== input.expectedRevision) throw changeError('native_hold_revision_conflict');
    const hold = state.holds.find((entry) => entry.id === input.holdID && entry.ownerID === input.ownerID);
    if (!hold) throw changeError('native_hold_owner_mismatch');
    session.nativeAdmission = { ...state, revision: state.revision + 1, holds: state.holds.filter((entry) => entry !== hold) };
    repo.db.set(sessionKey, session);
    // Revert pending state is deliberately preserved by this generic release.
    return nativeAdmission(repo, input.sessionID);
  });
  // Called only by the constructing native owner after prior process settlement
  // and bundle verification, while fresh execution admission remains closed.
  const recoverNativeTransientHolds = input => locked(input.directory, async repo => {
    if (typeof input.ownerID !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.ownerID)) throw changeError('invalid_capture_identity', 400);
    const updates = [];
    for await (const { value: session } of repo.db.entries('sessions')) {
      if (session.pending || !session.nativeAdmission) continue;
      const state = session.nativeAdmission;
      const holds = state.holds.filter(hold => !(hold.ownerID === input.ownerID && validID(hold.id)
        && Object.keys(hold).every(name => name === 'id' || name === 'ownerID')));
      if (holds.length === state.holds.length) continue;
      if (updates.length >= 512) throw changeError('native_hold_recovery_unbounded');
      updates.push({ ...session, nativeAdmission: { ...state, revision: state.revision + 1, holds } });
    }
    // Collect before writing: an unbounded or corrupt inventory cannot partly
    // release fences. Revert, retention, removal and foreign holds stay intact.
    for (const session of updates) repo.db.set(key('sessions', session.id), session);
    return updates.length;
  });
  const deferNativeContinuation = (input) => locked(input.directory, async (repo) => {
    if (!validID(input.sessionID) || !validID(input.operation)) throw changeError('invalid_capture_identity', 400);
    const sessionKey = key('sessions', input.sessionID), session = await repo.db.get(sessionKey);
    if (!session) throw changeError('mutation_history_unavailable');
    const state = session.nativeAdmission ?? { revision: 0, holds: [] };
    session.nativeAdmission = { ...state, continuations: [...new Set([...(state.continuations ?? []), input.operation])] };
    repo.db.set(sessionKey, session);
  });
  const nativeContinuations = (input) => snapshotOrLocked(input.directory, async (repo) => {
    const session = await repo.db.get(key('sessions', input.sessionID));
    return [...(session?.nativeAdmission?.continuations ?? [])];
  });
  const nativeDeferredContinuations = (input) => snapshotOrLocked(input.directory, async (repo) => {
    const result = [];
    for await (const { value: session } of repo.db.entries('sessions')) {
      for (const operation of session.nativeAdmission?.continuations ?? []) {
        if (operation.startsWith('shell.complete:') || operation === 'execution.wake') {
          if (result.length >= 4096) throw changeError('native_continuation_recovery_unbounded');
          result.push({ sessionID: session.id, operation });
        }
      }
    }
    return result;
  });
  const nativeShellContinuations = async input => (await nativeDeferredContinuations(input)).filter(row => row.operation.startsWith('shell.complete:'));
  const nativeExecutionContinuations = async input => (await nativeDeferredContinuations(input)).filter(row => row.operation === 'execution.wake').map(row => row.sessionID);
  const nativeTransactionHolds = (input) => snapshotOrLocked(input.directory, async (repo) => {
    const result = [];
    for await (const { value: session } of repo.db.entries('sessions')) {
      for (const hold of session.nativeAdmission?.holds ?? []) {
        if (hold.ownerID !== input.ownerID || !hold.transactionID) continue;
        const tx = await repo.db.get(key('transactions', hold.transactionID));
        if (tx && ['committed', 'cancelled'].includes(tx.state) && tx.members.includes(session.id)) {
          result.push({ transactionID: tx.id, sessions: tx.members });
        }
      }
    }
    return result.filter((entry, index) => result.findIndex((candidate) => candidate.transactionID === entry.transactionID) === index);
  });
  const bindNativeShellJob = (input) => locked(input.directory, async (repo) => {
    if (![input.token, input.jobID, input.sessionID, input.messageID, input.callID].every(validID)
      || typeof input.command !== 'string' || !input.command || input.command.length > 1024 * 1024) throw changeError('invalid_capture_identity', 400);
    const leaseKey = key('leases', input.token), lease = await repo.db.get(leaseKey);
    if (!lease || lease.executionKind !== 'process' || !['ready', 'published'].includes(lease.state)
      || lease.scope.sessionID !== input.sessionID || lease.scope.messageID !== input.messageID || lease.scope.callID !== input.callID) throw changeError('capture_identity_mismatch');
    await assertNativeAdmission(repo, input.sessionID);
    const session = await repo.db.get(key('sessions', input.sessionID));
    if (session.generation !== lease.generation) throw changeError('execution_reverted');
    const binding = { jobID: input.jobID, command: input.command }, pointerKey = key('native-shell-jobs', `${input.sessionID}\0${input.jobID}`);
    const previous = await repo.db.get(pointerKey);
    if (previous && previous.token !== input.token || lease.nativeShellJob
      && (lease.nativeShellJob.jobID !== binding.jobID || lease.nativeShellJob.command !== binding.command)) throw changeError('native_shell_job_conflict');
    lease.nativeShellJob ??= binding;
    repo.db.set(leaseKey, lease); repo.db.set(pointerKey, { token: lease.token });
    return lease;
  });
  const nativeShellJob = (input) => snapshotOrLocked(input.directory, async (repo) => {
    if (![input.sessionID, input.jobID].every(validID)) throw changeError('invalid_capture_identity', 400);
    const pointer = await repo.db.get(key('native-shell-jobs', `${input.sessionID}\0${input.jobID}`));
    const lease = pointer && await repo.db.get(key('leases', pointer.token));
    if (!lease || lease.scope.sessionID !== input.sessionID || lease.nativeShellJob?.jobID !== input.jobID) throw changeError('native_shell_job_unavailable');
    const session = await repo.db.get(key('sessions', input.sessionID));
    if (!session || session.generation !== lease.generation || session.pending) throw changeError('execution_reverted');
    return lease;
  });
  const bindNativeShellNotification = (input) => locked(input.directory, async (repo) => {
    if (![input.sessionID, input.jobID, input.notificationID].every(validID)) throw changeError('invalid_capture_identity', 400);
    const pointer = await repo.db.get(key('native-shell-jobs', `${input.sessionID}\0${input.jobID}`));
    const lease = pointer && await repo.db.get(key('leases', pointer.token));
    if (!lease || lease.scope.sessionID !== input.sessionID || lease.nativeShellJob?.jobID !== input.jobID) throw changeError('native_shell_job_unavailable');
    const previous = lease.nativeShellJob.notificationID;
    if (previous && previous !== input.notificationID) throw changeError('native_shell_job_conflict');
    if(input.itemDelivery!==undefined&&input.itemHash===undefined||input.itemHash!==undefined&&(typeof input.itemHash!=='string'||!/^[a-f0-9]{64}$/.test(input.itemHash)||!['queue','steer'].includes(input.itemDelivery)||lease.nativeShellJob.itemHash&&(lease.nativeShellJob.itemHash!==input.itemHash||lease.nativeShellJob.itemDelivery!==input.itemDelivery)))throw changeError('native_shell_job_conflict');
    lease.nativeShellJob = { ...lease.nativeShellJob, notificationID: input.notificationID,...input.itemHash?{itemHash:input.itemHash,itemDelivery:input.itemDelivery}:{} };
    repo.db.set(key('leases', lease.token), lease);
  });
  const acknowledgeNativeShellCompletion = (input) => locked(input.directory, async (repo) => {
    const pointer = await repo.db.get(key('native-shell-jobs', `${input.sessionID}\0${input.jobID}`));
    const lease = pointer && await repo.db.get(key('leases', pointer.token));
    if (!lease || lease.scope.sessionID !== input.sessionID || lease.nativeShellJob?.notificationID !== input.notificationID
      || !['published', 'cancelled'].includes(lease.state)) throw changeError('native_shell_job_unavailable');
    lease.nativeShellJob = { ...lease.nativeShellJob, deliveredID: input.notificationID };
    repo.db.set(key('leases', lease.token), lease);
  });
  const acknowledgeNativeContinuation = (input) => locked(input.directory, async (repo) => {
    const sessionKey = key('sessions', input.sessionID), session = await repo.db.get(sessionKey);
    if (!session?.nativeAdmission) throw changeError('mutation_history_unavailable');
    const admission = await assertNativeAdmission(repo, input.sessionID);
    if (input.operation === 'execution.wake' && (!Number.isSafeInteger(input.expectedRevision) || admission.revision !== input.expectedRevision)) {
      throw changeError('native_hold_revision_conflict');
    }
    if (input.operation.startsWith('shell.complete:')) {
      if (!Number.isSafeInteger(input.expectedRevision) || admission.revision !== input.expectedRevision) throw changeError('native_hold_revision_conflict');
      const jobID = input.operation.slice('shell.complete:'.length), pointer = await repo.db.get(key('native-shell-jobs', `${input.sessionID}\0${jobID}`));
      const lease = pointer && await repo.db.get(key('leases', pointer.token));
      if (!lease || lease.scope.sessionID !== input.sessionID || !lease.nativeShellJob?.deliveredID
        || lease.generation !== session.generation || !['published', 'cancelled'].includes(lease.state)) throw changeError('native_shell_job_unavailable');
      if (!validID(input.assistantMessageID) || lease.nativeShellJob.deliveredID !== input.userMessageID) throw changeError('native_continuation_started_proof_required');
      lease.nativeShellJob = { ...lease.nativeShellJob, continuedID: input.userMessageID, continuedAssistantID: input.assistantMessageID };
      repo.db.set(key('leases', lease.token), lease);
    }
    session.nativeAdmission = { ...session.nativeAdmission, continuations: (session.nativeAdmission.continuations ?? []).filter((operation) => operation !== input.operation) };
    repo.db.set(sessionKey, session);
  });
  const register = async (repo, input, { provisional = false, proof = false } = {}) => {
    if (!validID(input.sessionID) || !validID(input.userMessageID)) throw changeError('invalid_capture_identity', 400);
    const sessionKey = key('sessions', input.sessionID);
    let session = await repo.db.get(sessionKey);
    if (!session) session = { id: input.sessionID, parentID: input.parentID ?? null, generation: 0, pending: null };
    if (session.directory && session.directory !== repo.logicalDirectory) throw changeError('session_directory_mismatch');
    session.directory = repo.logicalDirectory;
    if (input.parentID && session.parentID && input.parentID !== session.parentID) throw changeError('capture_identity_mismatch');
    session.parentID ??= input.parentID ?? null;
    await assertNativeAdmission(repo, input.sessionID);
    if (session.parentID) await assertNativeAdmission(repo, session.parentID);
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
    if (proof && !prompt) throw changeError('mutation_history_unavailable');
    if (prompt?.reverted) throw changeError('execution_reverted');
    if (prompt && !prompt.provisional && (provisional || proof)) {
      if (prompt.fingerprint !== input.fingerprint || prompt.candidateHash !== input.candidateHash) throw changeError('capture_identity_mismatch');
      return { session, prompt };
    }
    if (prompt?.provisional) {
      if ((input.parentID ?? null) !== prompt.parentID) throw changeError('capture_identity_mismatch');
      if (provisional) {
        if (prompt.fingerprint !== input.fingerprint || prompt.candidateHash !== input.candidateHash) throw changeError('capture_identity_mismatch');
        return { session, prompt };
      }
      if (!proof || prompt.fingerprint !== input.fingerprint || prompt.candidateHash !== input.candidateHash) throw changeError('prompt_boundary_uncommitted');
    }
    if (!prompt || prompt.provisional && proof) {
      if (session.pending) throw changeError('session_reverting');
      // Native providers discard reverted suffixes on the next prompt. Do not
      // offer a file redo whose corresponding conversation can no longer return.
      if (!provisional) for (const rootSessionID of visited) {
        const redoKey = key('last-redos', rootSessionID), redo = await repo.db.get(redoKey);
        const redoTx = redo?.id && await repo.db.get(key('transactions', redo.id));
        if (!prompt?.provisional || !redoTx || redoTx.boundarySequence < prompt.sequence) repo.db.remove(redoKey);
        const lastKey = key('last-reverts', rootSessionID);
        const last = await repo.db.get(lastKey);
        const retained = [];
        for (const transactionID of last?.ids ?? []) {
          const tx = await repo.db.get(key('transactions', transactionID));
          if (tx?.targets.some((target) => target.id === session.id)
            && (!prompt?.provisional || tx.boundarySequence < prompt.sequence)) {
            if (!prompt?.provisional) { repo.db.remove(lastKey); break; }
          } else retained.push(transactionID);
        }
        if (prompt?.provisional && last && retained.length !== last.ids.length) {
          if (retained.length) repo.db.set(lastKey, { ...last, ids: retained }); else repo.db.remove(lastKey);
        }
      }
      prompt = provisional
        ? { sessionID: input.sessionID, messageID: input.userMessageID, sequence: next(repo), origins,
          provisional: true, parentID: session.parentID ?? null, fingerprint: input.fingerprint, candidateHash: input.candidateHash }
        : prompt?.provisional ? { sessionID: prompt.sessionID, messageID: prompt.messageID, sequence: prompt.sequence, origins: prompt.origins,
          fingerprint: prompt.fingerprint, candidateHash: prompt.candidateHash }
          : { sessionID: input.sessionID, messageID: input.userMessageID, sequence: next(repo), origins };
      repo.db.set(promptKey, prompt);
    }
    repo.db.set(sessionKey, session);
    return { session, prompt };
  };
  const registerPrompt = (input) => snapshotOrLocked(input.directory, async (repo) => {
    const { prompt } = await register(repo, input, { proof: input.proof === true });
    return { sequence: prompt.sequence };
  });
  const reservePromptBoundary = (input) => locked(input.directory, async repo => {
    if (!/^[a-f0-9]{64}$/.test(input.fingerprint ?? '') || !/^[a-f0-9]{64}$/.test(input.candidateHash ?? '')) throw changeError('invalid_capture_identity');
    const session = await repo.db.get(key('sessions', input.sessionID));
    if (!session || (session.parentID ?? null) !== (input.parentID ?? null)) throw changeError('invalid_session_lineage');
    const existing = await repo.db.get(key('prompts', `${input.sessionID}\0${input.userMessageID}`));
    if (!existing) {
      let pending = 0;
      for await (const { value } of repo.db.entries('prompts')) if (value.provisional && value.sessionID === input.sessionID && ++pending >= 128) {
        throw changeError('prompt_boundary_capacity');
      }
    }
    const { prompt } = await register(repo, input, { provisional: true });
    return { sequence: prompt.sequence };
  });
  const pendingPromptBoundary = (input) => snapshotOrLocked(input.directory, async repo => {
    if (!repo) return null;
    const prompt = await repo.db.get(key('prompts', `${input.sessionID}\0${input.userMessageID}`));
    return prompt?.provisional ? prompt : null;
  }, { requireExisting: true });
  const assertAdmission = (input) => snapshotOrLocked(input.directory, async (repo) => {
    if (!validID(input.sessionID)) throw changeError('invalid_capture_identity', 400);
    await assertNativeAdmission(repo, input.sessionID);
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
    if(input.publicationPolicy!==undefined&&(!['context-images','interview-document'].includes(input.publicationPolicy)||input.kind==='control'))throw changeError('invalid_publication_policy',400);
    if(input.publicationPolicy==='interview-document'&&(!safeChangePath(input.publicationPath)||!input.publicationPath.endsWith('.md')
      ||input.publicationPath.split('/').some(part=>part.toLowerCase()==='.git')))throw changeError('invalid_publication_policy',400);
    if(input.publicationPolicy!=='interview-document'&&input.publicationPath!==undefined)throw changeError('invalid_publication_policy',400);
    // A read-only process lease (Plan-mode shell) gets no private copy: its
    // confined command runs from the live project under a read-only profile,
    // and its publication is always empty (see prepareView and finishOwned).
    if (input.preparation !== undefined && (input.preparation !== 'read-only' || input.kind !== 'process'
      || input.publicationPolicy !== undefined)) throw changeError('invalid_capture_identity', 400);
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
          || old.publicationPolicy !== input.publicationPolicy
          || old.publicationPath !== input.publicationPath
          || (old.preparation === 'none') !== (input.kind === 'control')
          || (old.preparation === 'read-only') !== (input.preparation === 'read-only')) throw changeError('capture_identity_mismatch');
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
        ...(input.publicationPolicy?{publicationPolicy:input.publicationPolicy}:{}),
        ...(input.publicationPath?{publicationPath:input.publicationPath}:{}),
        ...(input.ownerID ? { ownerID: input.ownerID } : {}),
        ...(control ? { preparation: 'none' } : input.preparation === 'read-only' ? { preparation: 'read-only' } : {}) };
      repo.db.set(key('leases', token), result);
      repo.db.set(key('calls', scopeKey), { token });
      return result;
    });
  };
  // Direct receipts for built-in read, glob, grep and skill (read-only by
  // audit). Admission is a snapshot read with no commit, the
  // tool runs in the control process, and `finishDirect` then records the
  // reservation and its publication in one locked commit, fenced by the
  // admitted generation and by cancellation, idempotent per (session, call).
  // Nothing is recorded before the read: a crash in between leaves the call
  // `uncertain`, exactly as a missing lease does today.
  const admitDirect = (input) => snapshotOrLocked(input.directory, async (repo) => {
    if (!scopeFields.every((field) => validID(input[field]))) throw changeError('invalid_capture_identity', 400);
    const boundary = await repo.db.get(key('prompts', `${input.sessionID}\0${input.userMessageID}`));
    if (boundary?.provisional) throw changeError('prompt_boundary_uncommitted');
    if (boundary?.reverted) throw changeError('execution_reverted');
    await assertNativeAdmission(repo, input.sessionID);
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
  // Open (not yet locked) batches per requested directory. A batch stays open
  // while it queues for the owner lock and closes once the lock is held, so
  // finishes arriving as separate requests during that wait share its commit.
  const directFinishQueues = new Map();
  const finishDirect = (input) => {
    if (!scopeFields.every((field) => validID(input[field])) || !/^[a-f0-9-]{36}$/.test(input.token ?? '')
      || !Number.isSafeInteger(input.generation) || !/^[a-f0-9]{64}$/.test(input.executionFingerprint ?? '')) {
      return Promise.reject(changeError('invalid_capture_identity', 400));
    }
    const captured = structuredClone(input), run = AsyncLocalStorage.snapshot(), meter = executionProgressMeter(), signal = executionSignal();
    return new Promise((resolve, reject) => {
      const open = directFinishQueues.get(captured.directory) ?? [];
      let queued = open.find((batch) => batch.signal === signal && batch.items.length < 64);
      if (!queued) {
        // Every member follows the meter of the call that queues the batch.
        queued = { signal, items: [], holder: meter }; open.push(queued); directFinishQueues.set(captured.directory, open);
        const batch = queued.items, holder = meter;
        const close = () => {
          const rest = (directFinishQueues.get(captured.directory) ?? []).filter((candidate) => candidate !== queued);
          if (rest.length) directFinishQueues.set(captured.directory, rest); else directFinishQueues.delete(captured.directory);
        };
        setImmediate(async () => {
          try {
            const outcomes = await locked(captured.directory, async repo => {
              close();
              const results = [];
              for (const item of batch) {
                const previousMeta = structuredClone(repo.meta);
                try {
                  const value = await item.run(() => repo.db.stage(async () => {
                    checkExecutionAdmission();
                    const value = await stageDirectFinish(repo, item.input);
                    checkExecutionAdmission();
                    return value;
                  }));
                  results.push({ value });
                } catch (error) { Object.assign(repo.meta, previousMeta); results.push({ error }); }
              }
              return results;
            }, { operation: 'finishDirect' });
            // The shared durable commit finishes before any call is acknowledged.
            outcomes.forEach((outcome, index) => outcome.error ? batch[index].reject(outcome.error) : batch[index].resolve(outcome.value));
          } catch (error) { close(); for (const item of batch) item.reject(error); }
          finally { for (const item of batch) if (item.meter && item.meter.following === holder) item.meter.following = undefined; }
        });
      }
      if (meter && queued.holder && meter !== queued.holder) meter.following = queued.holder;
      queued.items.push({ input: captured, run, meter, resolve, reject });
    });
  };
  const stageEffect = async (repo, scope, token, descriptor) => {
    if (!descriptor) return;
    const effect = reviewedToolEffect(descriptor);
    if (!effect) throw changeError('untrusted_tool_effect');
    const callKey = key('calls', `${scope.sessionID}\0${scope.callID}`), pointer = await repo.db.get(callKey);
    if (!pointer || pointer.token !== token) throw changeError('capture_identity_mismatch');
    const effectScope = Object.fromEntries(scopeFields.map(field => [field, scope[field]]));
    if (pointer.effect && JSON.stringify(pointer.effect) !== JSON.stringify(effect)) throw changeError('capture_identity_mismatch');
    repo.db.set(callKey, { ...pointer, effect, effectScope });
  };
  const stageDirectFinish = async (repo, input) => {
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
      await stageEffect(repo, scope, lease.token, input.effect);
      return lease.result;
  };
  // View reuse (see viewReuse). Per lease: the directory stamps recorded as its
  // preparation finished and, once published, the files publication found
  // untouched. Per (ledger, session): parked standby views, newest last.
  const viewRecords = new Map();
  const standbys = new Map();
  const retiring = new Set();
  const sweptStandbys = new Set();
  // Disposable directories are removed off the call path; drain() awaits them.
  const retire = (action) => {
    const work = action().catch((cause) => diagnostic({ phase: 'view_standby', state: 'failed', code: cause?.code ?? 'view_standby_failed' }));
    retiring.add(work); void work.finally(() => retiring.delete(work));
  };
  const retireView = (directory) => retire(() => removeExecutionDirectory(directory));
  const rememberView = (token, record) => {
    viewRecords.delete(token); viewRecords.set(token, record);
    while (viewRecords.size > 256) viewRecords.delete(viewRecords.keys().next().value);
  };
  // Stamps of a view's real directories (never through a link), by relative path.
  const directoryStamps = async (view) => {
    const stamps = new Map();
    for (let level = ['']; level.length;) {
      const next = [];
      for (const relative of level) {
        const entries = await listDirectory(path.join(view, relative));
        const candidates = entries.filter((entry) => entry.name !== '.git' && !entry.isFile() && !entry.isSymbolicLink())
          .map((entry) => relative ? path.posix.join(relative, entry.name) : entry.name);
        const stats = await mapBounded(candidates, (file) => lstatEntry(path.join(view, file)));
        candidates.forEach((file, index) => { if (stats[index].isDirectory()) { stamps.set(file, mutationStatStamp(stats[index])); next.push(file); } });
      }
      level = next;
      await yieldToEventLoop();
    }
    return stamps;
  };
  // The session's own most recent standby, else the most recent one any
  // session of the same project parked: adoption checks every file against
  // this lease's own snapshot, so a view parked by another session is as safe
  // as its own. Parallel calls in one session, and a primary session's first
  // calls, otherwise copied the whole project (7 of 36 preparations, 4-7 s
  // each, in the 2026-10-24 replay). Kill switch: DEVRYAN_VIEW_SHARED_STANDBY=0.
  const takeStandby = (root, sessionID) => {
    let standbyKey = `${root}\0${sessionID}`;
    if (!standbys.get(standbyKey)?.length && process.env.DEVRYAN_VIEW_SHARED_STANDBY !== '0') {
      let newest = null;
      for (const [other, list] of standbys) {
        if (!other.startsWith(`${root}\0`) || !list.length) continue;
        if (!newest || list.at(-1).parkedAt > newest.parkedAt) newest = { key: other, parkedAt: list.at(-1).parkedAt };
      }
      if (newest) standbyKey = newest.key;
    }
    const entries = standbys.get(standbyKey), entry = entries?.pop();
    if (entries && !entries.length) standbys.delete(standbyKey);
    if (entry && Date.now() - entry.parkedAt > STANDBY_MAX_AGE_MS) { retireView(entry.directory); return null; }
    return entry ?? null;
  };
  // Called by cleanup once the lease's processes are proven terminated and its
  // publication committed: one rename instead of removing the whole view.
  const parkView = async (record, lease) => {
    const parent = path.join(record.root, 'view-standby'), directory = path.join(parent, randomUUID());
    await fs.mkdir(parent, { recursive: true, mode: 0o700 });
    await fs.rename(lease.viewDirectory, directory);
    rememberStandby(record.root, record.sessionID, { directory, files: record.files, directories: record.directories });
    return true;
  };
  const rememberStandby = (root, sessionID, standby) => {
    const parent = path.join(root, 'view-standby');
    const standbyKey = `${root}\0${sessionID}`, entries = standbys.get(standbyKey) ?? [];
    standbys.delete(standbyKey);
    entries.push({ ...standby, parkedAt: Date.now() });
    while (entries.length > STANDBY_PER_SESSION) retireView(entries.shift().directory);
    standbys.set(standbyKey, entries);
    let total = 0;
    for (const list of standbys.values()) total += list.length;
    // Least recently parked sessions go first; expired standbys are never adopted.
    for (const [other, list] of standbys) {
      while (list.length && (total > STANDBY_LIMIT || Date.now() - list[0].parkedAt > STANDBY_MAX_AGE_MS)) { retireView(list.shift().directory); total -= 1; }
      if (!list.length) standbys.delete(other);
    }
    // Standbys of an earlier or another process are unknown here: sweep those
    // long past adoption once per ledger and process.
    if (!sweptStandbys.has(root)) {
      sweptStandbys.add(root);
      retire(async () => {
        const known = new Set([...standbys.values()].flat().map((entry) => entry.directory));
        for (const name of await fs.readdir(parent)) {
          const stale = path.join(parent, name), stat = await fs.lstat(stale).catch(ignoreCode('ENOENT'));
          if (stat && !known.has(stale) && Date.now() - stat.ctimeMs > 2 * STANDBY_MAX_AGE_MS) await removeExecutionDirectory(stale);
        }
      });
    }
  };
  // A session's first confined call otherwise copies the whole project into
  // its view (13k files took 1.8–3.2 s of `view_files` per subagent in the
  // 2026-10-24 live QA). The host calls this when it registers a child that
  // may write: the published files are materialized into a standby for that
  // session in the background, outside any lock, and its first preparation
  // adopts it under the usual checks (ledger entry unchanged, exact stamp,
  // directory stamps), so anything that changed meanwhile is copied again.
  // A preparation that starts while this runs waits for it instead of copying
  // the same files twice. Kill switch, read per use: DEVRYAN_CHILD_VIEW_PREWARM=0.
  const prewarms = new Map();
  const prewarmView = (input) => {
    if (!viewReuse() || process.env.DEVRYAN_CHILD_VIEW_PREWARM === '0' || process.env.DEVRYAN_VIEW_FAST_MATERIALIZE === '0'
      || process.env.DEVRYAN_VIEW_CLONE === '0') return Promise.resolve({ skipped: 'disabled' });
    if (!validID(input?.sessionID)) return Promise.reject(changeError('invalid_capture_identity', 400));
    const work = (async () => {
      const { directory } = await resolveRepository(input.directory);
      const root = rootFor(directory), standbyKey = `${root}\0${input.sessionID}`;
      if (prewarms.has(standbyKey) || standbys.get(standbyKey)?.length) return { skipped: 'standby' };
      const pending = (async () => {
        const result = await readSnapshot(input.directory, async (repo) => {
          const live = [...await snapshotPaths(repo)].filter(([, doc]) => !doc.published.deleted);
          const parent = path.join(repo.root, 'view-standby'), view = path.join(parent, randomUUID());
          await fs.mkdir(parent, { recursive: true, mode: 0o700 });
          await fs.mkdir(view, { mode: 0o700 });
          try {
            const materialize = createViewMaterializer(repo, view, { io: (action) => withExecutionIO(repo.root, action) });
            const files = new Map();
            for (let start = 0; start < live.length; start += 64) {
              const chunk = live.slice(start, start + 64);
              // Links and entries the materializer defers are copied at preparation.
              const stats = await mapBounded(chunk, ([file, doc]) => materialize(file, doc.published, permissions(doc.published)));
              chunk.forEach(([file, doc], index) => { if (stats[index]) files.set(file, { entry: doc.published, stamp: mutationStatStamp(stats[index]) }); });
              await yieldToEventLoop();
            }
            return { view, files, directories: await directoryStamps(view) };
          } catch (cause) { retireView(view); throw cause; }
        });
        if (!('value' in result)) return { skipped: result.miss };
        const { view, files, directories } = result.value;
        rememberStandby(root, input.sessionID, { directory: view, files, directories });
        return { prepared: files.size };
      })();
      prewarms.set(standbyKey, pending);
      try { return await pending; } finally { prewarms.delete(standbyKey); }
    })();
    retire(() => work.then(() => {}));
    return work;
  };
  // Moves what a session's standby view still holds exactly as materialized
  // into this lease's fresh, empty view and discards everything else. A file
  // is kept only while its ledger entry is unchanged and its full stamp (inode,
  // size, mode, nanosecond mtime and ctime) still equals the one recorded when
  // it was materialized and publication then found it untouched: any write,
  // chmod, link, attribute change or replacement moves ctime or the inode. A
  // directory is kept as is only while its stamp is unchanged since its
  // preparation finished; any other directory is rebuilt fresh around its
  // verified entries. Links (inputs among them), `.git`, special files and
  // directories holding no expected file are discarded. Returns the kept files.
  const adoptStandbyView = async (standby, view, expected) => {
    const kept = new Set(), directories = new Set();
    for (const file of expected.keys()) {
      for (let parent = path.posix.dirname(file); parent !== '.' && !directories.has(parent); parent = path.posix.dirname(parent)) directories.add(parent);
    }
    const move = async (from, to) => { await mapBounded(await fs.readdir(from), (name) => fs.rename(path.join(from, name), path.join(to, name))); };
    const prune = async (relative, absolute) => {
      const subdirectories = [];
      await mapBounded(await fs.readdir(absolute), async (name) => {
        checkExecutionAdmission();
        const file = relative ? path.posix.join(relative, name) : name, target = path.join(absolute, name);
        const stat = await fs.lstat(target, { bigint: true });
        if (stat.isDirectory()) {
          if (name !== '.git' && directories.has(file)) subdirectories.push({ file, target, stamp: mutationStatStamp(stat) });
          else await removeExecutionDirectory(target);
          return;
        }
        const recorded = standby.files.get(file), entry = expected.get(file);
        if (name !== '.git' && recorded && entry && equal(recorded.entry, entry) && preciseStamp(recorded.stamp)
          && mutationStatStamp(stat) === recorded.stamp
          && (entry.mode === '120000' ? stat.isSymbolicLink() : stat.isFile() && stat.nlink === 1n)) kept.add(file);
        else await fs.unlink(target);
      });
      for (const child of subdirectories) {
        // Compared before pruning, which changes the directory itself.
        const recorded = standby.directories.get(child.file);
        await prune(child.file, child.target);
        if (!preciseStamp(recorded) || recorded !== child.stamp) {
          const fresh = `${child.target}.devryan-${randomUUID()}`;
          await fs.mkdir(fresh);
          await move(child.target, fresh);
          await fs.rmdir(child.target);
          await fs.rename(fresh, child.target);
        }
      }
      await yieldToEventLoop();
    };
    await prune('', standby.directory);
    // The view root is always this lease's own fresh directory.
    await move(standby.directory, view);
    return kept;
  };
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
      // Defined only when this preparation created the view: the fast
      // materializer never writes into a directory it did not create.
      let createdView;
      if (process.platform === 'win32') {
        const root = rootFor(lease.projectDirectory);
        await windowsOwner.ensureDirectory(path.join(root, 'views'));
        await windowsOwner.ensureDirectory(path.dirname(lease.viewDirectory));
        try { await windowsOwner.createDirectory(lease.viewDirectory); createdView = lease.viewDirectory; }
        catch (cause) { if (cause.code !== 'EEXIST') throw cause; await windowsOwner.ensureDirectory(lease.viewDirectory); }
      } else createdView = await fs.mkdir(lease.viewDirectory, { recursive: true, mode: 0o700 });
      // Control and read-only process leases skip reconciliation and the view
      // copy (view_files, view_git, view_inputs): neither publishes a file.
      if (lease.preparation === 'none' || lease.preparation === 'read-only') {
        if (process.platform === 'win32') {
          const relative = path.relative(lease.viewDirectory, lease.workingDirectory);
          if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw changeError('invalid_execution_path');
          let working = lease.viewDirectory;
          for (const part of relative.split(path.sep).filter(Boolean)) {
            working = path.join(working, part); await windowsOwner.ensureDirectory(working);
          }
        } else await fs.mkdir(lease.workingDirectory, { recursive: true, mode: 0o700 });
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
      const root = rootFor(lease.projectDirectory), db = await openChangeStore(root, path.join(root, 'git'), { ...storeOptions, ref: lease.snapshotRef, syncObjects });
      const repo = { root, directory: lease.projectDirectory, db };
      // Operation state only filters eagerly copied base runs; lazy runs are
      // derived at publication, so the full operation scan is skipped.
      const disabled = lease.lazyBaseRuns ? null : await inactive(repo);
      const inputSet = new Set(lease.inputs);
      // Kill switch: DEVRYAN_VIEW_FAST_MATERIALIZE=0 (or DEVRYAN_VIEW_CLONE=0)
      // restores the per-file temporary-file writer.
      const fastView = createdView !== undefined && process.env.DEVRYAN_VIEW_FAST_MATERIALIZE !== '0'
        && process.env.DEVRYAN_VIEW_CLONE !== '0'
        ? createViewMaterializer(repo, lease.viewDirectory, { io: (action) => withExecutionIO(repo.root, action) })
        : null;
      const live = [...await snapshotPaths(repo)].filter(([file, doc]) => !doc.published.deleted && !underInput(file, inputSet));
      // The session's previous view, when one is parked: files it still holds
      // exactly as materialized are moved in instead of copied again.
      // A background prewarm of this session's view becomes its standby.
      if (fastView && viewReuse()) await prewarms.get(`${root}\0${lease.scope.sessionID}`)?.catch(() => {});
      const standby = fastView && viewReuse() ? takeStandby(root, lease.scope.sessionID) : null;
      let adopted = null, copied = 0;
      if (standby) adopted = await executionPhase('view_reuse', async () => {
        try { return await adoptStandbyView(standby, lease.viewDirectory, new Map(live.map(([file, doc]) => [file, doc.published]))); }
        catch (cause) {
          checkExecutionAdmission();
          // Not a failure of the call: set the partial view aside and copy everything.
          executionDiagnostic({ phase: 'view_reuse', state: 'failed', code: cause?.code ?? 'view_reuse_failed' });
          const discarded = path.join(root, 'view-standby', randomUUID());
          await fs.rename(lease.viewDirectory, discarded);
          retireView(discarded);
          await fs.mkdir(lease.viewDirectory, { mode: 0o700 });
          return null;
        } finally { retireView(standby.directory); }
      });
      const base = async function* () {
        for (let start = 0; start < live.length; start += 64) {
          // Copies overlap; ledger rows stay sequential and ordered.
          const identities = await mapBounded(live.slice(start, start + 64), async ([file, doc]) => {
            checkExecutionAdmission();
            let stat = adopted?.has(file) ? await fs.lstat(path.join(lease.viewDirectory, file), { bigint: true }) : null;
            if (stat && !(doc.published.mode === '120000' ? stat.isSymbolicLink() : stat.isFile())) stat = null;
            if (!stat) {
              copied += 1;
              stat = fastView ? await fastView(file, doc.published, permissions(doc.published)) : null;
            }
            if (!stat) {
              await write(repo, file, doc.published, lease.viewDirectory, { durable: false });
              stat = await fs.lstat(path.join(lease.viewDirectory, file), { bigint: true });
            }
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
      await executionPhase('view_files', () => db.setList(`bases/${lease.token}/files`, base()));
      // Units, not time: how many view files were copied and how many adopted.
      executionStep('view_copied', 0, copied);
      executionStep('view_reused', 0, live.length - copied);
      await executionPhase('view_commit', () => db.commit());
      noteLedgerCommit(root);
      await executionPhase('view_git', async () => {
        await git(lease.viewDirectory, ['init', '--quiet']);
        if (lease.vcs) {
          // Git commands can inspect the real revision and staged state without
          // gaining write access to the original metadata or object database.
          const { common, metadata, head } = await projectGitLocation(lease.projectDirectory);
          await fs.mkdir(path.join(lease.viewDirectory, '.git', 'objects', 'info'), { recursive: true });
          await fs.writeFile(path.join(lease.viewDirectory, '.git', 'objects', 'info', 'alternates'), path.join(common, 'objects') + '\n');
          if (head) await pointViewHead(lease.viewDirectory, head);
          try { await fs.copyFile(path.join(metadata, 'index'), path.join(lease.viewDirectory, '.git', 'index')); }
          catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
        }
      });
      await executionPhase('view_inputs', async () => {
        // The execution launcher enforces access to this input: read-only for
        // dependencies, write-through for ignored output folders (see
        // execution-inputs.js). A symlink and a private cwd alone confine nothing.
        for (const file of lease.inputs) {
          checkExecutionAdmission();
          await verifyAncestors(lease.viewDirectory, file);
          const target = path.join(lease.viewDirectory, file), source = path.join(lease.projectDirectory, file);
          await fs.mkdir(path.dirname(target), { recursive: true });
          let linked = source;
          if (moduleOverlay(file) && lease.auxiliaryDirectory) {
            const id = createHash('sha256').update(source).digest('hex').slice(0, 16);
            const overlay = path.join(rootFor(lease.projectDirectory), 'module-overlays', id);
            try {
              await syncModuleOverlay({ source, overlay, caches: path.join(lease.auxiliaryDirectory, 'module-caches', id) });
              linked = overlay;
            } catch (cause) { if (!['ENOENT', 'ENOTDIR'].includes(cause.code)) throw cause; }
          }
          await fs.symlink(linked, target, 'dir');
        }
      });
      await fs.mkdir(lease.workingDirectory, { recursive: true });
      // Before the lease is ready, so no command can have touched the view yet.
      if (viewReuse() && fastView) rememberView(lease.token, { root, sessionID: lease.scope.sessionID,
        directories: await timedExecutionStep('view_record', () => directoryStamps(lease.viewDirectory)) });
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
  // call arriving meanwhile supersedes advisory work at the next checked
  // boundary, then performs its own authoritative observation.
  // Ownership is unchanged: every observation outside a lease stays external.
  const warm = async ({ directory, refresh = false, maxFiles = WARM_MAX_FILES, maxBytes = WARM_MAX_BYTES }) => {
    if (typeof refresh !== 'boolean' || !Number.isSafeInteger(maxFiles) || maxFiles < 1 || maxFiles > WARM_MAX_FILES
      || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > WARM_MAX_BYTES) throw changeError('invalid_warm_request', 400);
    checkExecutionAdmission();
    const { logicalDirectory, directory: projectDirectory, vcs } = await resolveRepository(directory);
    if (!vcs) return { skipped: 'not-git' };
    if (projectDirectory === await fs.realpath(os.homedir()).catch(() => os.homedir())) return { skipped: 'home-directory' };
    try { await fs.access(path.join(rootFor(projectDirectory), 'observed')); if (!refresh) return { skipped: 'already-built' }; }
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
    const result = await observe({ directory: logicalDirectory, projectDirectory, vcs, reservedAt: Date.now() }, { warm: true, refresh, maxFiles, maxBytes });
    if (result.skipped) return { skipped: result.skipped };
    return { built: true, files, elapsedMs: Date.now() - started };
  };
  const begin = async (input) => {
    const lease = await reserve(input);
    if (lease.state === 'preparing' && preparations.has(lease.token)) throw changeError('execution_already_started');
    return prepare(lease);
  };
  const finishOwned = async ({ directory, token, renames = [], effect }) => {
    // Advisory capture; the publication transaction below re-reads the lease under the lock.
    const captured = await snapshotOrLocked(directory, async (repo) => {
      const lease = await repo.db.get(key('leases', token));
      // Absence is only authoritative behind the lock.
      if (!lease && repo.snapshot) throw changeError('snapshot_lease_absent');
      return lease;
    });
    if (!captured) throw changeError('execution_unavailable');
    if (captured.state === 'published') return captured.result;
    if (captured.state !== 'ready') throw changeError('execution_not_ready');
    const base = new Map(), identities = new Map(), files = new Map(), ignoredInputs = [];
    let snapshot = null, snapshotInactive = null, untouched = null;
    // Exactly the runs the view was materialized from: the pinned snapshot's
    // runs filtered by the operations inactive in that same snapshot.
    const baseRuns = async (repo, documentID) => {
      if (!captured.lazyBaseRuns) return runsFor(repo, documentID, `bases/${token}`);
      snapshotInactive ??= await inactive(snapshot);
      return visibleMutationRuns(await runsFor(snapshot, documentID), snapshotInactive);
    };
    if (captured.preparation !== 'none' && captured.preparation !== 'read-only') {
      const root = rootFor(captured.projectDirectory), db = await openChangeStore(root, path.join(root, 'git'),
        { ...storeOptions, ...(captured.snapshotRef ? { ref: captured.snapshotRef } : {}), syncObjects });
      const repo = { root, directory: captured.projectDirectory };
      snapshot = { root, directory: captured.projectDirectory, db };
      await timedExecutionStep('finish_baseline', async () => {
        for await (const file of db.list(`bases/${token}/files`)) { base.set(file.path, file); if (file.identity) identities.set(file.identity, file); }
      });
      // The host has verified native termination before calling finish. Hashing
      // this immutable output does not serialize unrelated project admissions.
      const viewFiles = [];
      // Dependency inputs persisted at preparation are never outputs, even if
      // the agent replaced the read-only link. Leases prepared before inputs
      // were persisted keep the name-only rule.
      const excluded = Array.isArray(captured.inputs) ? new Set(captured.inputs) : null;
      await timedExecutionStep('finish_walk', async () => {
        for await (const file of walkFiles(captured.viewDirectory, { excluded })) if (safeChangePath(file)) viewFiles.push(file);
      });
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
      // Files still exactly as materialized, for the session's next view.
      untouched = viewRecords.has(token) ? new Map() : null;
      let reused = 0, inspected = 0;
      const entries = await timedExecutionStep('finish_inspect', () => mapBounded(viewFiles, async (file) => {
        const row = base.get(file);
        // The walk descends only real directories and every writer has
        // terminated, so the file's own lstat is sufficient here.
        if (reuse && row?.stamp && preciseStamp(row.stamp) && mutationStatStamp(await Promise.resolve(lstatEntry(path.join(captured.viewDirectory, file)))
          .catch((cause) => { if (['ENOENT', 'ENOTDIR'].includes(cause.code)) return null; throw cause; })) === row.stamp) {
          untouched?.set(file, { entry: row.entry, stamp: row.stamp });
          reused += 1;
          return row.entry;
        }
        inspected += 1;
        return inspect(repo, file, captured.viewDirectory);
      }));
      executionStep('finish_files', 0, viewFiles.length);
      executionStep('finish_reused', 0, reused);
      executionStep('finish_inspected', 0, inspected);
      viewFiles.forEach((file, index) => files.set(file, entries[index]));
      for (const file of base.keys()) if (!files.has(file)) files.set(file, null);
    }
    const result = await locked(directory, async (repo) => {
      const lease = await repo.db.get(key('leases', token));
      if (!lease) throw changeError('execution_unavailable');
      if (lease.state === 'published') return lease.result;
      const session = await repo.db.get(key('sessions', lease.scope.sessionID));
      if (session.generation !== lease.generation || session.pending) throw changeError('execution_reverted');
      await assertNativeAdmission(repo, lease.scope.sessionID);
      if (lease.state !== 'ready') throw changeError('execution_not_ready');
      if (lease.preparation === 'none' || lease.preparation === 'read-only') {
        // A read-only lease never publishes, whatever its empty view holds.
        if (lease.executionKind !== (lease.preparation === 'none' ? 'control' : 'process')) throw changeError('execution_not_ready');
        const operation = { id: randomUUID(), sequence: next(repo), scope: lease.scope, parentCallID: lease.parentCallID,
          promptSequence: lease.promptSequence, origins: lease.origins, active: true, origin: 'execution', files: [], baseSequence: lease.baseSequence };
        repo.db.set(key('operations', operation.id), operation);
        lease.state = 'published'; lease.cleanupPending = true; lease.result = { operationID: operation.id, sequence: operation.sequence, files: [] };
        repo.db.set(key('leases', token), lease);
        await stageEffect(repo, lease.scope, token, effect);
        return lease.result;
      }
      if (effect) throw changeError('untrusted_tool_effect');
      const touched = [...new Set([...base.keys(), ...files.keys()])].filter((file) => !equal(base.get(file)?.entry, files.get(file)));
      if(lease.publicationPolicy!==undefined){
        if(!['context-images','interview-document'].includes(lease.publicationPolicy))throw changeError('invalid_publication_policy');
        const relative=path.relative(lease.viewDirectory,lease.workingDirectory);
        if(relative==='..'||relative.startsWith(`..${path.sep}`)||path.isAbsolute(relative))throw changeError('invalid_publication_policy');
        const prefix=relative?relative.split(path.sep).join('/')+'/':'';
        if(lease.publicationPolicy==='interview-document'&&(!safeChangePath(lease.publicationPath)||!lease.publicationPath.endsWith('.md')
          ||lease.publicationPath.split('/').some(part=>part.toLowerCase()==='.git')))throw changeError('invalid_publication_policy');
        const allowed=file=>lease.publicationPolicy==='interview-document'?file===prefix+lease.publicationPath:file.startsWith(prefix+'.opencode/images/')||file===prefix+'.opencode/.gitignore'
          ||file===prefix+'.opencode/.gitignore.oh-my-opencode-slim-legacy';
        // This runs before reconcile or any publication decision. The private
        // worker has terminated; a refused contribution remains unpublished.
        if(touched.some(file=>!allowed(file)||files.get(file)?.mode==='120000')||ignoredInputs.length)throw changeError(lease.publicationPolicy==='interview-document'?'interview_document_output_denied':'context_asset_output_denied');
      }
      executionStep('finish_touched', 0, touched.length);
      await timedExecutionStep('finish_reconcile', () => reconcile(repo, touched));
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
      await timedExecutionStep('finish_materialize', () => materialize(repo, [...changed.values()], (files) => {
        lease.state = 'published'; lease.cleanupPending = true; lease.result = { operationID: operation.id, sequence: operation.sequence, files,
          ...(conflicts.length ? { outcome: 'partial', conflicts: conflicts.map(({ path, source }) => ({ path, ...(source ? { source } : {}) })) } : {}),
          ...(ignoredInputs.length ? { ignoredInputs } : {}) };
        repo.db.set(key('leases', token), lease);
      }));
      return lease.result;
    });
    // Recorded only after publication committed; cleanup parks the view.
    const record = viewRecords.get(token);
    if (record && untouched) record.files = untouched;
    await timedExecutionStep('finish_notify', () => onChange({ directory, ...result }));
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
    const lease = await snapshotOrLocked(input.directory, async (repo) => {
      const lease = await repo.db.get(key('leases', input.token));
      if (!lease || lease.cleaned || !['published', 'cancelled'].includes(lease.state)) {
        // Only a cleanable lease is answered from the snapshot.
        if (repo.snapshot) throw changeError('snapshot_lease_unsettled');
        return null;
      }
      if (lease.executionKind === 'process' && !lease.cancelledBeforeStart) await readSessionExecutionReceipt(lease);
      else if (lease.state === 'published' && lease.executionKind !== 'control') return null;
      return lease;
    });
    if (!lease) return false;
    const record = viewRecords.get(input.token);
    viewRecords.delete(input.token);
    // Only a published process lease, whose termination receipt was verified
    // above and whose view publication fully inspected, is parked for reuse.
    const parked = record?.files && viewReuse() && lease.state === 'published' && lease.executionKind === 'process'
      && lease.preparation === undefined && !lease.cancelledBeforeStart && !lease.rebootRecovery
      && record.root === rootFor(lease.projectDirectory)
      ? await parkView(record, lease).catch((cause) => {
        diagnostic({ phase: 'view_standby', state: 'failed', code: cause?.code ?? 'view_standby_failed' }); return false;
      }) : false;
    // The parent holds termination.json. It is recovery evidence, not scratch.
    if (!parked) await removeExecutionDirectory(lease.viewDirectory);
    await removeExecutionDirectory(path.join(path.dirname(lease.viewDirectory), 'scratch'));
    await removeExecutionSocketDirectory(lease);
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
    if (!prompt || prompt.provisional) throw changeError('mutation_history_unavailable');
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
    if (sessions.find(session => session.id === input.sessionID)?.nativeRemoved) throw changeError('native_session_removed');
    if (input.scope !== 'session') {
      for (let grew = true; grew;) {
        grew = false;
        for (const session of sessions) if (!session.nativeRemoved && members.has(session.parentID) && !members.has(session.id)) { members.add(session.id); grew = true; }
      }
    }
    const selected = [], targets = new Map([[input.sessionID, { id: input.sessionID, targetMessageID: input.messageID }]]);
    const prompts = [];
    for await (const { value } of repo.db.entries('prompts')) if (!value.provisional && members.has(value.sessionID)) prompts.push(value);
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
      if (session.nativeAdmission?.holds?.some(hold => hold.removalID)) throw changeError('native_removal_in_progress');
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
      if (tx.kind === 'files' && tx.proof) {
        const staged = await Promise.all(['operations', 'files', 'runs', 'revisions'].map(prefix => repo.db.staged(prefix)));
        if (staged.some(rows => rows.size)) throw changeError('restore_proof_stale');
        const proofInput = { sessionID: tx.rootSessionID, revision: tx.proofRevision, redo: tx.redo, calls: tx.proofCalls };
        const { operations } = await fileRestoreSelection(repo, proofInput);
        const proof = await fileRestoreProof(repo, proofInput, operations, inputs);
        if (proof.version !== tx.proof.version || proof.digest !== tx.proof.digest) throw changeError('restore_proof_stale');
      }
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
        if (!prompt.provisional && tx.members.includes(prompt.sessionID) && (prompt.origins?.[tx.rootSessionID] ?? prompt.sequence) >= tx.boundarySequence) {
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
    if ((await repo.db.get(key('sessions', input.sessionID)))?.nativeRemoved) throw changeError('native_session_removed');
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
      if (session.nativeRemoved || session.nativeAdmission?.holds?.some(hold => hold.removalID)) throw changeError('native_removal_in_progress');
      session.generation++; session.pending = id; repo.db.set(key('sessions', member), session);
    }
    await repo.db.setList(`transactions/${id}/operations`, operations);
    repo.db.set(key('transactions', id), tx); return tx;
  });
  const fileRestoreSelection = async (repo, input) => {
    if (!validID(input.sessionID) || !validID(input.revision) || !Array.isArray(input.calls)
      || !input.calls.length || input.calls.some((call) => !validID(call.sessionID) || !validID(call.callID) || !validID(call.messageID))) {
      throw changeError('mutation_history_unavailable');
    }
    const members = new Set([input.sessionID]), operations = new Set();
    for (const call of input.calls) {
      const entry = await repo.db.get(key('calls', `${call.sessionID}\0${call.callID}`));
      const lease = entry && await repo.db.get(key('leases', entry.token));
      const cancelled = await repo.db.get(key('cancelled-calls', `${call.sessionID}\0${call.callID}`));
      // No-start receipts have no operation to restore. Missing calls alone
      // never provide this authority, and a published lease remains mandatory.
      if (neverStartedCall({ ...call, directory: repo.logicalDirectory, pointer: entry, lease, cancelled })) continue;
      if (lease?.state !== 'published' || !lease.result?.operationID) throw changeError('mutation_history_unavailable');
      if (call.messageID !== lease.scope.messageID) throw changeError('capture_identity_mismatch');
      let id = call.sessionID;
      const seen = new Set();
      while (id !== input.sessionID) {
        if (!id || seen.has(id)) throw changeError('invalid_session_lineage');
        seen.add(id); members.add(id);
        id = (await repo.db.get(key('sessions', id)))?.parentID;
      }
      operations.add(lease.result.operationID);
    }
    if (!operations.size) throw changeError('mutation_history_unavailable');
    return { members, operations };
  };
  const fileRestoreProof = async (repo, input, operations, inputs = new Set()) => {
    // Any live writable view may publish a later edit based on the bytes being
    // restored. Until it settles, the ledger cannot prove that edit's intent.
    for await (const { value: lease } of repo.db.entries('leases')) {
      if (!['preparing', 'ready'].includes(lease.state) || ['none', 'read-only'].includes(lease.preparation)) continue;
      let id = lease.scope.sessionID;
      const seen = new Set();
      while (id && id !== input.sessionID && !seen.has(id)) {
        seen.add(id); id = (await repo.db.get(key('sessions', id)))?.parentID;
      }
      if (id !== input.sessionID) throw changeError('restore_proof_stale');
    }
    const disabled = await inactive(repo), documents = new Set(), selectedOps = new Map();
    for (const id of operations) {
      const op = await repo.db.get(key('operations', id));
      if (!op || !Array.isArray(op.files)) throw changeError('mutation_history_unavailable');
      if (op.conflicts) for await (const conflict of repo.db.list(op.conflicts)) {
        void conflict; throw changeError('mutation_history_unavailable');
      }
      selectedOps.set(id, op);
      if (input.redo && op.active) disabled.delete(id); else disabled.add(id);
      for (const id of op.files) documents.add(id);
    }
    const selected = [];
    for (const id of documents) {
      const doc = await repo.db.get(key('files', id));
      if (!doc) throw changeError('mutation_history_unavailable');
      selected.push(doc);
    }
    const targets = await materializationTargets(repo, selected, disabled, { preview: true });
    for (const doc of selected) {
      const revisions = await revisionsFor(repo, doc.id), projected = targets.updates.get(key('files', doc.id))?.published;
      if ((equal(doc.published, projected) && doc.published?.path === projected?.path
        && doc.published?.sequence === projected?.sequence) || revisions.some(revision => revision.binary)) continue;
      for (const revision of revisions) {
        if (!revision.owner || operations.has(revision.owner) || disabled.has(revision.owner)) continue;
        const later = await repo.db.get(key('operations', revision.owner));
        if (!later) throw changeError('mutation_history_unavailable');
        for (const selectedOp of selectedOps.values()) {
          if (!selectedOp.files.includes(doc.id)) continue;
          if (!Number.isSafeInteger(later.sequence) || !Number.isSafeInteger(selectedOp.sequence)) throw changeError('mutation_history_unavailable');
          if (later.sequence <= selectedOp.sequence) continue;
          // A later edit based on this owner may have reused its unchanged runs.
          // Their ownership cannot prove which bytes the later edit intended.
          if (!Number.isSafeInteger(later.baseSequence) || later.baseSequence >= selectedOp.sequence) throw changeError('mutation_history_unavailable');
        }
      }
    }
    const current = await activePathsFor(repo, targets.paths);
    const rows = [];
    for (const { path: file, before: actual, after } of targets.rows.sort((a, b) => a.path.localeCompare(b.path))) {
      if (underInput(file, inputs)) throw changeError('restore_proof_stale');
      const published = current.get(file)?.published, before = published?.deleted ? null : published ?? null;
      if (!equal(before, actual)) throw changeError('working_tree_changed');
      rows.push([file, before && [before.hash, before.mode, permissions(before)], after && [after.hash, after.mode, permissions(after)]]);
    }
    const graph = await Promise.all(['operations', 'files', 'runs', 'revisions'].map(prefix => repo.db.committedIdentity(prefix)));
    const calls = input.calls.map(call => [call.sessionID, call.messageID, call.callID]).sort();
    return { version: 1, digest: digest(Buffer.from(JSON.stringify([input.sessionID, input.revision, input.redo === true,
      calls, [...operations].sort(), graph, rows]))) };
  };
  const previewFileRestore = (input) => locked(input.directory, async (repo) => {
    const { operations } = await fileRestoreSelection(repo, input);
    return fileRestoreProof(repo, input, operations);
  }, { requireExisting: true });
  const prepareFileRestore = (input) => locked(input.directory, async (repo) => {
    if (!validID(input.sessionID) || !validID(input.revision) || !Array.isArray(input.calls)
      || !input.calls.length || input.calls.some((call) => !validID(call.sessionID) || !validID(call.callID) || !validID(call.messageID))) {
      throw changeError('mutation_history_unavailable');
    }
    const identity = JSON.stringify([input.sessionID, input.revision, input.redo === true]);
    const receipt = await repo.db.get(key('file-restores', identity));
    const fingerprint = digest(Buffer.from(JSON.stringify(input.calls.map((call) => [call.sessionID, call.messageID, call.callID]).sort())));
    let previous;
    if (receipt) {
      if (receipt.fingerprint !== fingerprint) throw changeError('capture_identity_mismatch');
      previous = await repo.db.get(key('transactions', receipt.id));
      if (!previous) throw changeError('mutation_recovery_failed');
    }
    const { members, operations } = await fileRestoreSelection(repo, input);
    if (input.proof?.version !== 1 || typeof input.proof.digest !== 'string' || !/^[a-f0-9]{64}$/.test(input.proof.digest)
      || Object.keys(input.proof).some(key => !['version', 'digest'].includes(key))) throw changeError('restore_proof_stale');
    // Cached idempotence never substitutes for current exact call identities.
    if (previous && previous.state !== 'cancelled') {
      if (previous.proof && (input.proof?.version !== previous.proof.version || input.proof?.digest !== previous.proof.digest)) {
        throw changeError('restore_proof_stale');
      }
      return previous;
    }
    const proof = await fileRestoreProof(repo, input, operations);
    if (input.proof.version !== proof.version || input.proof.digest !== proof.digest) throw changeError('restore_proof_stale');
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
      if (session.nativeRemoved || session.nativeAdmission?.holds?.some(hold => hold.removalID)) throw changeError('native_removal_in_progress');
      session.generation++; session.pending = id; repo.db.set(key('sessions', member), session);
    }
    const tx = { id, kind: 'files', rootSessionID: input.sessionID, members: [...members], targets: [],
      boundarySequence: 0, redo: input.redo === true, state: 'prepared', phase: 'prepared',
      ...(input.proof ? { proof: input.proof, proofRevision: input.revision, proofCalls: input.calls } : {}) };
    await repo.db.setList(`transactions/${id}/operations`, operations);
    repo.db.set(key('transactions', id), tx);
    repo.db.set(key('file-restores', identity), { id, fingerprint });
    return tx;
  });
  const leaseForCall = (input) => snapshotOrLocked(input.directory, async (repo) => {
    const call = await repo.db.get(key('calls', `${input.sessionID}\0${input.callID}`));
    // Absence is only authoritative behind any queued reservation.
    if (!call && repo.snapshot) throw changeError('snapshot_lease_absent');
    return call?.token ? repo.db.get(key('leases', call.token)) : null;
  });
  // Read only host-owned durable evidence. A tool error or a missing lease is
  // never proof that a command did not execute. Batch one transcript per lock.
  // Negative proof must not observe a guarded CAS awaiting owner recheck or
  // rollback. Share the writer's owner lock, including across processes.
  const executionOutcomes = (input) => locked(input.directory, async (repo) => {
    if (!validID(input.sessionID) || !Array.isArray(input.calls) || input.calls.length > 10_000
      || input.calls.some(call => !validID(call.callID) || !validID(call.messageID) || call.tool !== undefined && typeof call.tool !== 'string')) throw changeError('invalid_capture_identity');
    if (!repo) return input.calls.map(call => ({ sessionID: input.sessionID, messageID: call.messageID, callID: call.callID, outcome: 'uncertain' }));
    const outcomes = [];
    for (const call of input.calls) {
      const scopeKey = `${input.sessionID}\0${call.callID}`;
      const cancelled = await repo.db.get(key('cancelled-calls', scopeKey));
      const pointer = await repo.db.get(key('calls', scopeKey));
      const lease = pointer?.token ? await repo.db.get(key('leases', pointer.token)) : null;
      let outcome = 'uncertain';
      if (lease && lease.directory === repo.logicalDirectory && lease.scope.sessionID === input.sessionID
        && lease.scope.messageID === call.messageID && lease.scope.callID === call.callID) {
        if (lease.state === 'published') outcome = 'finished';
      }
      if (outcome !== 'finished' && neverStartedCall({ ...call, sessionID: input.sessionID,
        directory: repo.logicalDirectory, pointer, lease, cancelled })) outcome = 'never_started';
      const trustedEffect = outcome === 'finished' && pointer?.effect?.version === 1 && pointer.effect.effect === 'read-only'
        && pointer.effectScope?.sessionID === input.sessionID && pointer.effectScope.messageID === call.messageID
        && pointer.effectScope.callID === call.callID && pointer.effect.tool === call.tool ? pointer.effect.effect : undefined;
      const coveredBy = lease?.state === 'published' && lease.directory === repo.logicalDirectory
        && lease.scope.sessionID === input.sessionID && lease.scope.messageID === call.messageID
        && lease.scope.callID !== call.callID && validID(lease.scope.callID) ? lease.scope.callID : undefined;
      outcomes.push({ sessionID: input.sessionID, messageID: call.messageID, callID: call.callID, outcome,
        ...(trustedEffect ? { effect: trustedEffect } : {}), ...(coveredBy ? { coveredBy } : {}) });
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
  // A published lease and its publication rows never change again; the last
  // committed tree answers without queueing behind other ledger work.
  const executionReceipt = (input) => snapshotOrLocked(input.directory, async (repo) => {
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
      createdAt: lease.reservedAt, publicationSequence: lease.result.sequence,
      ...(lease.result?.outcome ? { outcome: lease.result.outcome, conflicts: lease.result.conflicts } : {}) };
  });
  const claimLease = (input) => locked(input.directory, async (repo) => {
    const lease = await repo.db.get(key('leases', input.token));
    if (input.reattach === true) {
      if (input.kind !== 'control' || lease?.state !== 'published' || lease.executionKind !== 'control' || lease.preparation !== 'none') throw changeError('execution_already_started');
      if (await repo.db.get(key('cancelled-calls', `${lease.scope.sessionID}\0${lease.scope.callID}`))) throw changeError('execution_cancelled');
      const session = await repo.db.get(key('sessions', lease.scope.sessionID));
      if (session?.pending || session?.generation !== lease.generation) throw changeError('execution_reverted');
      await assertNativeAdmission(repo, lease.scope.sessionID);
      return lease;
    }
    if (!['control', 'process'].includes(input.kind) || lease?.state !== 'ready' || lease.executionKind) throw changeError('execution_already_started');
    if (lease.preparation === 'none' && input.kind !== 'control') throw changeError('capture_identity_mismatch');
    if (lease.preparation === 'read-only' && input.kind !== 'process') throw changeError('capture_identity_mismatch');
    const session = await repo.db.get(key('sessions', lease.scope.sessionID));
    await assertNativeAdmission(repo, lease.scope.sessionID);
    if (session?.pending || session?.generation !== lease.generation) throw changeError('execution_reverted');
    lease.executionKind = input.kind;
    repo.db.set(key('leases', input.token), lease); return lease;
  });
  const registerChild = (input) => locked(input.directory, async (repo) => {
    if (!validID(input.sessionID) || !validID(input.parentID) || !validID(input.parentCallID)) throw changeError('invalid_capture_identity');
    const parent = await repo.db.get(key('sessions', input.parentID));
    await assertNativeAdmission(repo, input.parentID);
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
    return { captured: Boolean(session), pending, ...(session && !pending ? { generation: session.generation } : {}) };
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
    if (input.stoppedBy !== undefined && input.stoppedBy !== 'operator') throw changeError('invalid_capture_identity', 400);
    lease.state = 'cancelled'; lease.cleanupPending = !lease.cleaned;
    if (input.stoppedBy === 'operator') lease.stoppedBy = 'operator';
    repo.db.set(key('leases', lease.token), lease);
  });
  const cancelUnstartedCall = (input) => locked(input.directory, async (repo) => {
    await input.guard?.assertCurrent();
    if (input.guard) {
      const admission = await nativeAdmission(repo, input.sessionID);
      await input.guard.assertCurrent();
      if (admission.held || admission.revision !== input.guard.admissionRevision) throw changeError('native_permit_revoked');
    }
    if (!validID(input.sessionID) || !validID(input.callID) || !validID(input.messageID)) throw changeError('invalid_capture_identity');
    const scopeKey = `${input.sessionID}\0${input.callID}`, call = await repo.db.get(key('calls', scopeKey));
    await input.guard?.assertCurrent();
    // Constructor-proved negative admission must never rewrite an execution lease.
    if (input.requireAbsent === true) {
      if (call) throw changeError('execution_already_started');
      const previous = await repo.db.get(key('cancelled-calls', scopeKey));
      await input.guard?.assertCurrent();
      if (previous && previous.messageID !== input.messageID) throw changeError('capture_identity_mismatch');
    }
    if (call) {
      const lease = await repo.db.get(key('leases', call.token));
      if (!lease || lease.scope.messageID !== input.messageID || input.token && lease.token !== input.token) throw changeError('capture_identity_mismatch');
      if (lease.state === 'published') throw changeError('execution_already_published');
      if (lease.rebootRecovery) throw changeError('execution_already_started');
      lease.cancelledBeforeStart = true;
      lease.state = 'cancelled'; lease.cleanupPending = !lease.cleaned; repo.db.set(key('leases', lease.token), lease);
    }
    repo.db.set(key('cancelled-calls', scopeKey), { sessionID: input.sessionID, messageID: input.messageID });
  }, { assertCurrent: input.guard?.assertCurrent });
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
      const db = await openChangeStore(root, path.join(root, 'git'), { ...storeOptions, syncObjects });
      const meta = await db.get('meta.json');
      if (meta?.version === 1 && path.isAbsolute(meta.directory ?? '')) directories.push(meta.directory);
    }
    return directories;
  };
  const runtime = { projectDirectories, projectDirectory: (input) => locked(input.directory, (repo) => repo.directory),
    assertAdmission, registerNativeSession, nativeAdmissionState, holdNativeAdmission, releaseNativeAdmission, recoverNativeTransientHolds,
    beginNativeRemoval, recoverNativeRemovalOwnership, abandonQuietNativeRemoval, nativeRetentionHolds, commitNativeRemoval, prepareNativeRemovalMembers: input => commitNativeRemoval({...input,prepareOnly:true}), nativeRemoval, nativeRemovals, stageNativeRemovalMember, acknowledgeNativeRemoval, completeNativeRemoval,
    deferNativeContinuation, nativeContinuations, nativeShellContinuations, nativeExecutionContinuations, nativeTransactionHolds, acknowledgeNativeContinuation,
    bindNativeShellJob, nativeShellJob, bindNativeShellNotification, acknowledgeNativeShellCompletion,
    registerPrompt, reservePromptBoundary, pendingPromptBoundary, registerChild, prewarmView, reserve, prepare, warm, begin, admitDirect, finishDirect, claimLease, finish, cleanupLease, executionReceipt, aliasCalls, prepareRevert, prepareRedo, previewFileRestore, prepareFileRestore, settleRevert, leaseForCall,
    transaction, updateTransaction, pendingTransactions, capturedSessionState, restoreForeign, cancelLease, cancelUnstartedCall, activeLeases, pendingCleanup, executionOutcomes,
    maintainLedger: ({ directory }) => resolveRepository(directory).then(({ directory: project }) => maintainLedger(rootFor(project))),
    drain: () => Promise.allSettled([...preparations.values(), ...settlements.values(), ...queues.values(), ...retiring,
      ...[...maintenanceStates.values()].map((state) => state.running).filter(Boolean)]) };
  // Lock timings name the outermost runtime operation; nested calls keep it.
  for (const [name, method] of Object.entries(runtime)) {
    if (typeof method !== 'function' || name === 'drain') continue;
    runtime[name] = (input, ...rest) => lockOperation.getStore() ? method(input, ...rest)
      : lockOperation.run({ operation: name, sessionID: input?.sessionID }, () => method(input, ...rest));
  }
  return runtime;
}
