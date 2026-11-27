#!/usr/bin/env node
// The JavaScript arm of the native ledger's content object store
// differential test: the product's own object store and durability modules
// (packages/harness-runtime/lib), driven by one request per line, one answer
// line each, on Node's real loop. Its Rust twin is `ledger-native-probe
// objects` (ledger-native/src/object_program.rs); both print values the same
// way (`show`).
//
//   {op: 'objects', steps: […], abort?}   steps in one execution context
//   {op: 'env', set: {NAME: value | null}}
//
// `bytesFor` lives inside the ledger runtime's factory, so the arm runs the
// product's own text of it (and of `digest`), cut out of session-mutations.js
// at start; it fails to start when that text is not found.
import { createHash } from 'node:crypto';
import { chmodSync, constants, lstatSync, readFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { copyMutationObject, createViewMaterializer, inspectMutationFile, mutationFileStamp, mutationStatStamp, requireMutationSpace, resetVerifiedMutationObjects }
  from '../../packages/harness-runtime/lib/session-mutation-files.js';
import { markObjectDirectoryPending, syncPendingObjectDirectory } from '../../packages/harness-runtime/lib/object-durability.js';
import { runInRemoteExecutionContext } from '../../packages/harness-runtime/lib/execution-admission.js';
import { changeError } from '../../packages/harness-runtime/lib/session-changes-git.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const errorWith = (code, message) => Object.assign(new Error(message), { code });

/** The product's `bytesFor`, from its own source text. */
function productBytesFor() {
  const source = readFileSync(path.join(here, '..', '..', 'packages', 'harness-runtime', 'lib', 'session-mutations.js'), 'utf8');
  const digest = /\nconst digest = (\(bytes\) => createHash\('sha256'\)\.update\(bytes\)\.digest\('hex'\));\n/.exec(source)?.[1];
  const bytesFor = /\n {2}const bytesFor = (async \(repo, hash\) => \{\n[\s\S]*?\n {2}\});\n/.exec(source)?.[1];
  if (!digest || !bytesFor) throw new Error('bytesFor or digest not found in session-mutations.js');
  // eslint-disable-next-line no-new-func -- the product's own text, run as written
  return new Function('fs', 'path', 'changeError', 'createHash', `const digest = ${digest};\nreturn ${bytesFor};`)(fsp, path, changeError, createHash);
}
const bytesFor = productBytesFor();

// The sync shim (every platform): while a `syncShim` step has it on, the
// object directory's handle (`fs.open(<root>/objects, 'r')`), each content
// object temporary's (`fs.open(<objects>/.pending-*, 'wx', 0o600)`) and each
// copy temporary's (`<target>.devryan-*`, `wx`) log their open, sync and
// close (a content temporary its link too), and the faults given
// (`<op>:objects`, `<op>:pending`, `<op>:copy`) fail them with EIO after the
// real call, as the Rust arm's seams do.
const realOpen = fsp.open;
let syncShim = null;
// The change hook (`changeAt` steps): at the `nth` time an observed file's
// handle (`fs.open(file, O_RDONLY | O_NOFOLLOW)`) is opened, reads, reads its
// end or is closed (`at`: `open`, `read`, `eof`, `close`), the file's mode is
// changed (its group execute bit flipped), as the Rust arm's seam does; every
// event of an observed handle is logged (`changeLog`).
let change = null;
const OBSERVED = constants.O_RDONLY | constants.O_NOFOLLOW;
const changed = (event, file) => {
  if (!change) return;
  change.log.push(`${event} ${file}`);
  if (change.file !== String(file) || change.at !== event || ++change.seen !== change.nth) return;
  chmodSync(String(file), (lstatSync(String(file)).mode & 0o7777) ^ 0o010);
};
const injected = (op) => Object.assign(new Error(`EIO: i/o error, ${op === 'sync' ? 'fsync' : 'close'}`), { errno: -5, code: 'EIO', syscall: op === 'sync' ? 'fsync' : 'close' });
function patchedOpen(file, flags, mode) {
  const opened = realOpen.call(fsp, file, flags, mode);
  if (change && flags === OBSERVED) {
    return opened.then((handle) => {
      const [read, close] = [handle.read.bind(handle), handle.close.bind(handle)];
      handle.read = (...args) => read(...args).then((result) => { changed(result.bytesRead ? 'read' : 'eof', file); return result; });
      handle.close = () => close().then(() => { changed('close', file); });
      changed('open', file);
      return handle;
    });
  }
  const shim = syncShim;
  const name = path.basename(String(file));
  const kind = flags === 'r' && name === 'objects' ? 'objects' : flags === 'wx' && name.startsWith('.pending-') ? 'pending' : flags === 'wx' && name.includes('.devryan-') ? 'copy' : null;
  if (!shim || !kind) return opened;
  return opened.then((handle) => {
    shim.log.push(`open ${file}`);
    const fault = (op) => { const at = shim.faults.indexOf(`${op}:${kind}`); if (at < 0) return false; shim.faults.splice(at, 1); return true; };
    const [sync, close] = [handle.sync.bind(handle), handle.close.bind(handle)];
    handle.sync = () => sync().then(() => { const failed = fault('sync'); shim.log.push(`sync ${file} ${failed ? 'EIO' : 'ok'}`); if (failed) throw injected('sync'); });
    handle.close = () => close().then(() => { const failed = fault('close'); shim.log.push(`close ${file} ${failed ? 'EIO' : 'ok'}`); if (failed) throw injected('close'); });
    return handle;
  });
}
// The shim's link log: a content object temporary's link, `ok` or its code.
const realLink = fsp.link;
function patchedLink(from, to) {
  const shim = syncShim;
  const linked = realLink.call(fsp, from, to);
  if (!shim || !path.basename(String(from)).startsWith('.pending-')) return linked;
  return linked.then(() => { shim.log.push(`link ${from} ok`); }, (cause) => { shim.log.push(`link ${from} ${cause.code}`); throw cause; });
}
/** `fs.open` and `fs.link` are the product's own unless a hook is on. */
const hooked = () => { fsp.open = syncShim || change ? patchedOpen : realOpen; fsp.link = syncShim ? patchedLink : realLink; };

/** A value as both arms print it. */
export function show(value) {
  if (value === undefined) return { $undefined: true };
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return { $num: 'NaN' };
    if (!Number.isFinite(value)) return { $num: value > 0 ? 'Infinity' : '-Infinity' };
    if (Object.is(value, -0)) return { $num: '-0' };
    return value;
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return { $bytes: Buffer.from(value).toString('base64') };
  if (value instanceof Error) {
    const out = { name: value.name, message: value.message };
    for (const key of ['code', 'status', 'command', 'failure', 'errno', 'syscall', 'committed', 'rollbackFailed']) if (value[key] !== undefined) out[key] = show(value[key]);
    return { $error: out };
  }
  if (Array.isArray(value)) return value.map(show);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, show(entry)]));
  return value;
}
const outcome = (settled) => (settled.status === 'fulfilled' ? { ok: show(settled.value) } : { error: show(settled.reason) });

const setEnv = (set) => {
  for (const [key, value] of Object.entries(set ?? {})) {
    if (value === null) delete process.env[key]; else process.env[key] = String(value);
  }
};

const materializers = new Map();
const repoOf = (spec) => ({ root: spec.root, directory: spec.directory });

// A typed call's promise as the Rust arm hands it on (one `then`), so the
// arms' settle orders (`settleOrder`) count the same jobs.
const shown = (promise) => promise.then((value) => value);

/** One step: its value (a promise for an async call) or what it throws at once. */
function step(controller, spec) {
  switch (spec.s) {
    case 'inspect': return shown(inspectMutationFile(repoOf(spec), spec.file, spec.directory, { preview: Boolean(spec.preview) }));
    case 'stamp': return shown(mutationFileStamp(spec.directory, spec.file));
    case 'space': return shown(requireMutationSpace(spec.directory, spec.bytes));
    case 'materializer': materializers.set(spec.as, createViewMaterializer(repoOf(spec), spec.view)); return undefined;
    case 'materialize': {
      const made = materializers.get(spec.m);
      if (!made) throw errorWith('no_materializer', String(spec.m));
      return made(spec.file, spec.entry, spec.mode).then((stat) => (stat ? { stamp: mutationStatStamp(stat) } : null));
    }
    case 'copy': return shown(copyMutationObject(repoOf(spec), spec.entry, spec.target, spec.mode, { durable: spec.durable !== false }));
    case 'bytes': return shown(bytesFor(repoOf(spec), spec.hash));
    // A chain of `n` jobs, and the order the steps given settle in (each
    // started at once): where no I/O intervenes, that order is the arms' jobs.
    case 'ticks': { let chain = Promise.resolve(); for (let index = 0; index < spec.n; index += 1) chain = chain.then(() => undefined); return chain; }
    case 'settleOrder': {
      const order = [];
      const started = spec.steps.map((inner, index) => {
        let promise;
        try { promise = Promise.resolve(step(controller, inner)); } catch (error) { promise = Promise.reject(error); }
        return promise.then(() => { order.push(index); }, () => { order.push(index); });
      });
      return Promise.all(started).then(() => order);
    }
    case 'sync': return syncPendingObjectDirectory(spec.root);
    case 'markPending': markObjectDirectoryPending(spec.directory); return undefined;
    case 'reset': resetVerifiedMutationObjects(); return undefined;
    case 'env': setEnv(spec.set); return undefined;
    case 'abort': controller.abort(errorWith('call_aborted', 'aborted by the scenario')); return undefined;
    case 'syncShim':
      syncShim = spec.off ? null : { faults: [...(spec.faults ?? [])], log: [] };
      hooked();
      return undefined;
    case 'changeAt':
      change = spec.off ? null : { file: spec.file, at: spec.at, nth: spec.nth, seen: 0, log: [] };
      hooked();
      return undefined;
    case 'syncLog': return syncShim ? [...syncShim.log] : null;
    case 'changeLog': return change ? [...change.log] : null;
    case 'concurrent': {
      const started = spec.steps.map((inner) => { try { return Promise.resolve(step(controller, inner)); } catch (error) { return Promise.reject(error); } });
      return Promise.allSettled(started).then((outcomes) => outcomes.map(outcome));
    }
    default: throw errorWith('unknown_step', spec.s);
  }
}

async function handle(request) {
  const controller = new AbortController();
  if (request.abort === 'before') controller.abort(errorWith('call_aborted', 'aborted before the call'));
  const action = async () => {
    const outcomes = [];
    for (const item of request.steps) {
      try { outcomes.push({ ok: show(await step(controller, item)) }); }
      catch (error) { outcomes.push({ error: show(error) }); }
    }
    return outcomes;
  };
  const settled = await runInRemoteExecutionContext({ cancellable: true }, action, { signal: controller.signal });
  return settled.failed ? { error: show(settled.failure) } : { ok: show(settled.result) };
}

// Lines split on '\n' only (readline would split on U+2028 and U+2029 too).
let pending = '';
let queue = Promise.resolve();
const serve = (line) => {
  if (!line) return;
  queue = queue.then(async () => {
    let request;
    try { request = JSON.parse(line); } catch { process.stdout.write(`${JSON.stringify({ corrupt: true })}\n`); return; }
    if (request.op === 'env') { setEnv(request.set); process.stdout.write(`${JSON.stringify({ ok: true })}\n`); return; }
    const answer = await handle(request);
    process.stdout.write(`${JSON.stringify(answer)}\n`);
  });
};
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  pending += chunk;
  let at;
  while ((at = pending.indexOf('\n')) !== -1) { serve(pending.slice(0, at)); pending = pending.slice(at + 1); }
});
process.stdin.on('end', () => { void queue.then(() => process.exit(0)); });
