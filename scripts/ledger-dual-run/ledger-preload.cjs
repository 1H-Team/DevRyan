// Crash points, a lock audit and deterministic identifiers for the ledger
// dual-run harness, from outside
// the product: loaded with `--require` into the process (and so every worker
// thread) that runs the ledger, it wraps the Node calls the ledger's durable
// protocol is made of.
//
// LEDGER_DUAL_RUN_CRASH='{"point":"<name>","nth":1,"action":"kill"|"exit-thread"|"throw"|"hold","marker":"<file>","armFile":"<file>"}'
//   stops the ledger at the Nth occurrence of a point, once (a marker file
//   that already exists disarms it, so a restarted ledger runs normally).
//   kill: SIGKILL of the whole process (a crash of the app or of a ledger
//   process). exit-thread: process.exit inside the ledger's worker thread only,
//   so the host process lives on (file 26 §8.1). throw: an uncaught error in
//   that thread (thrown from the next microtask, so no caller catches it; an
//   operation already started, such as the link of a `before` point, still
//   completes). hold: the ledger's thread
//   blocks forever where it is (a stuck holder; the harness kills it later).
//   Before acting, the point and its count are written to `marker`. With
//   `armFile`, the count starts once that file exists (the harness creates it
//   just before the call the point targets).
// LEDGER_DUAL_RUN_AUDIT='<file>'
//   appends one JSON line per point reached: {point, n, pid, thread, lock}
//   where `lock` says, for update-ref and owner.lock events, whether the
//   ledger's owner.lock existed and named this process.
// LEDGER_DUAL_RUN_IDS='<seed>'
//   crypto.randomUUID in the ledger's thread returns the identifier protocol's
//   value (dual-run-ids.cjs, docs/TESTING.md "Identifiers and time"): the nth
//   draw at a named site during one seam call is a fixed function of seed,
//   call, site and n. This preload names the JavaScript draw sites by the
//   source text around them (ID_SITES), not by position; a draw no entry names
//   is logged to LEDGER_DUAL_RUN_ID_LOG, which the harness requires empty.
//
// Points ("before" stops before the call runs, "after" once it returned):
//   content-object-link:before|after  link of objects/.pending-* to its digest name
//   git-object-link:after             link of a git loose object tmp_obj_* into place
//   update-ref:before|after           a `git update-ref` child (the ledger ref CAS)
//   owner-lock:before|after           link of <ledger>/owner.lock (after: also its wx create)
//   owner-lock-release:after          unlink of <ledger>/owner.lock
//   metadata-index-removed:after      rm/unlink of state.metadata-index
//   project-write:before|after        rename of a <target>.devryan-* temporary onto its target
//   directory-sync:before             FileHandle.sync of a directory handle (object durability)
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const { syncBuiltinESMExports } = require('node:module');
const { isMainThread, threadId } = require('node:worker_threads');

const crash = process.env.LEDGER_DUAL_RUN_CRASH ? JSON.parse(process.env.LEDGER_DUAL_RUN_CRASH) : null;
const audit = process.env.LEDGER_DUAL_RUN_AUDIT || null;
const idSeed = process.env.LEDGER_DUAL_RUN_IDS || null;
// The seam call whose work is running: every `call` message is dispatched
// inside this scope (the worker's parentPort listeners are wrapped below; the
// stdio process dispatches through globalThis.__ledgerDualRunCallScope).
const { AsyncLocalStorage } = require('node:async_hooks');
const callScope = new AsyncLocalStorage();
const currentCall = () => callScope.getStore();
if ((process.env.LEDGER_DUAL_RUN_CRASH || process.env.LEDGER_DUAL_RUN_AUDIT || idSeed) && ledgerThreadCheck()) {
  const scope = (message, dispatch) => (message?.type === 'call' && typeof message.id === 'number' ? callScope.run(message.id, dispatch) : dispatch());
  globalThis.__ledgerDualRunCallScope = scope;
  const { parentPort } = require('node:worker_threads');
  if (parentPort) {
    for (const name of ['on', 'addListener']) {
      const original = parentPort[name].bind(parentPort);
      parentPort[name] = (event, listener) => original(event, event === 'message' ? (message) => scope(message, () => listener(message)) : listener);
    }
  }
}
function ledgerThreadCheck() { return !require('node:worker_threads').isMainThread || process.env.LEDGER_DUAL_RUN_LEDGER_PROCESS === '1'; }
// In a host process that runs the ledger on a worker thread, only that thread arms.
const ledgerThread = !isMainThread || process.env.LEDGER_DUAL_RUN_LEDGER_PROCESS === '1';
if (idSeed && ledgerThread) {
  const crypto = require('node:crypto');
  const { siteOf, protocolUUID } = require('./dual-run-ids.cjs');
  const sources = new Map(), counters = new Map();
  const lines = (file) => {
    if (!sources.has(file)) { try { sources.set(file, fs.readFileSync(file, 'utf8').split('\n')); } catch { sources.set(file, []); } }
    return sources.get(file);
  };
  const unlisted = process.env.LEDGER_DUAL_RUN_ID_LOG || null;
  const site = () => {
    for (const frame of new Error().stack.split('\n').slice(2)) {
      const match = /\(?(?:file:\/\/)?(\/[^():]+):(\d+):(\d+)\)?$/.exec(frame.trim());
      if (!match || match[1] === __filename) continue;
      const [, file, line] = match;
      const text = lines(file).slice(Number(line) - 1, Number(line) + 1).join('\n');
      const named = siteOf(path.basename(file), text);
      if (named) return named;
      if (unlisted) { try { fs.appendFileSync(unlisted, `${JSON.stringify({ file: path.basename(file), line: Number(line), text: text.split('\n')[0].trim().slice(0, 160) })}\n`); } catch { /* reported by its absence */ } }
      return `unlisted:${path.basename(file)}:${line}`;
    }
    return 'unlisted:unknown';
  };
  crypto.randomUUID = function protocolRandomUUID() {
    // Per seam call, so concurrent calls draw their own identifiers whatever
    // order they run in; work outside any call (background) shares one sequence.
    const call = currentCall() ?? 'background', name = site();
    const kind = `${call}:${name}`;
    const n = (counters.get(kind) ?? 0) + 1;
    counters.set(kind, n);
    // Optional census of every draw (site, call, n): what the protocol's per-site order rules are measured from.
    if (process.env.LEDGER_DUAL_RUN_ID_CENSUS) { try { fs.appendFileSync(process.env.LEDGER_DUAL_RUN_ID_CENSUS, `${name}\t${call}\t${n}\n`); } catch { /* census only */ } }
    return protocolUUID(idSeed, call, name, n);
  };
  syncBuiltinESMExports();
}
if ((crash || audit) && ledgerThread) {
  const counts = new Map(), armed = new Map();
  const lockState = (root) => {
    try { const owner = JSON.parse(fs.readFileSync(path.join(root, 'owner.lock'), 'utf8')); return owner.pid === process.pid ? 'held' : `other:${owner.pid}`; }
    catch (error) { return error.code === 'ENOENT' ? 'absent' : 'unreadable'; }
  };
  const event = (point, root, ref) => {
    const n = (counts.get(point) ?? 0) + 1;
    counts.set(point, n);
    if (audit) {
      try { fs.appendFileSync(audit, `${JSON.stringify({ point, n, pid: process.pid, thread: threadId, call: currentCall() ?? null, ...(root ? { lock: lockState(root) } : {}), ...(ref ? { ref } : {}) })}\n`); } catch { /* advisory */ }
    }
    if (!crash || point !== crash.point || fs.existsSync(crash.marker)) return;
    // With an arm file, only occurrences after the target call started count.
    if (crash.armFile) {
      if (!fs.existsSync(crash.armFile)) return;
      armed.set(point, (armed.get(point) ?? 0) + 1);
      if (armed.get(point) !== (crash.nth ?? 1)) return;
    } else if (n !== (crash.nth ?? 1)) return;
    fs.writeFileSync(crash.marker, `${JSON.stringify({ point, n, pid: process.pid, thread: threadId })}\n`);
    if (crash.action === 'exit-thread') process.exit(1);
    if (crash.action === 'throw') { queueMicrotask(() => { throw new Error('ledger_dual_run_crash'); }); return; }
    if (crash.action === 'hold') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    process.kill(process.pid, 'SIGKILL');
  };
  const promises = fs.promises;
  const wrap = (object, name, around) => { const original = object[name]; object[name] = around(original); };
  wrap(promises, 'link', (original) => async function link(source, target) {
    const from = String(source), to = String(target);
    if (from.includes('/objects/.pending-')) event('content-object-link:before');
    if (to.endsWith('/owner.lock')) event('owner-lock:before', path.dirname(to));
    const result = await original.call(this, source, target);
    if (to.endsWith('/owner.lock')) event('owner-lock:after', path.dirname(to));
    if (from.includes('/objects/.pending-')) event('content-object-link:after');
    if (/\/tmp_obj_[0-9a-f-]+$/.test(from)) event('git-object-link:after');
    return result;
  });
  wrap(promises, 'rename', (original) => async function rename(source, target) {
    const temporary = /\.devryan-[0-9a-f-]{36}$/.test(String(source));
    if (temporary) event('project-write:before');
    const result = await original.call(this, source, target);
    if (temporary) event('project-write:after');
    return result;
  });
  for (const name of ['rm', 'unlink']) {
    wrap(promises, name, (original) => async function remove(target, ...rest) {
      const result = await original.call(this, target, ...rest);
      const file = String(target);
      if (file.endsWith('/state.metadata-index')) event('metadata-index-removed:after');
      if (file.endsWith('/owner.lock')) event('owner-lock-release:after', path.dirname(file));
      return result;
    });
  }
  // The ledger's release is synchronous on some paths.
  for (const name of ['rmSync', 'unlinkSync']) {
    wrap(fs, name, (original) => function removeSync(target, ...rest) {
      const result = original.call(this, target, ...rest);
      if (String(target).endsWith('/owner.lock')) event('owner-lock-release:after', path.dirname(String(target)));
      return result;
    });
  }
  // FileHandle's prototype is only reachable through a handle: the first open patches it.
  const directoryHandles = new WeakSet();
  let syncPatched = false;
  wrap(promises, 'open', (original) => async function open(target, ...rest) {
    const handle = await original.call(this, target, ...rest);
    if (!syncPatched) {
      syncPatched = true;
      wrap(Object.getPrototypeOf(handle), 'sync', (sync) => function patchedSync(...args) {
        if (directoryHandles.has(this)) event('directory-sync:before');
        return sync.apply(this, args);
      });
    }
    try { if (fs.statSync(target).isDirectory()) directoryHandles.add(handle); } catch { /* gone already */ }
    return handle;
  });
  wrap(promises, 'writeFile', (original) => async function writeFile(target, data, options) {
    const result = await original.call(this, target, data, options);
    if (String(target).endsWith('/owner.lock') && typeof options === 'object' && options?.flag === 'wx') event('owner-lock:after', path.dirname(String(target)));
    return result;
  });
  wrap(childProcess, 'spawn', (original) => function spawn(command, args, ...rest) {
    const list = Array.isArray(args) ? args : [];
    const updateRef = /(^|\/)git$/.test(String(command)) && list.includes('update-ref');
    const gitDir = updateRef ? list[list.indexOf('--git-dir') + 1] : null;
    const root = gitDir && list.includes('--git-dir') ? path.dirname(gitDir) : null;
    const ref = updateRef ? list.slice(list.indexOf('update-ref') + 1).find((arg) => !arg.startsWith('-')) : null;
    if (updateRef) event('update-ref:before', root, ref);
    const child = original.call(this, command, args, ...rest);
    if (updateRef) child.once('exit', (code) => { if (code === 0) event('update-ref:after', root, ref); });
    return child;
  });
  syncBuiltinESMExports();
}
