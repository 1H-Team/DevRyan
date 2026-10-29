import { executionSignal, executionProgress } from './execution-admission.js';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import fs from 'node:fs/promises';

const ownedRunners=new WeakMap();
/** Constructor-only runner for an immutable executable inside an already owned
 * offline job. Requests never supply this handle or its executable/environment. */
export function createOwnedGitRunner({binary,environment,argumentsPrefix=[],assertAllowed}){
 const handle=Object.freeze({});ownedRunners.set(handle,{binary,environment:Object.freeze({...environment}),argumentsPrefix:[...argumentsPrefix],assertAllowed});
 return Object.freeze({
  git:(cwd,args,options)=>git(cwd,args,{...options,ownedRunner:handle}),
  gitTokens:(cwd,args,options)=>gitTokens(cwd,args,{...options,ownedRunner:handle}),
  gitRecords:(cwd,args,rows)=>gitRecords(cwd,args,rows,{ownedRunner:handle}),
 });
}

export const changeError = (code, status = 409) => Object.assign(new Error(code), { code, status });
// The failed Git subcommand and failure class of an error, for diagnostics.
export const gitFailure = (cause) => ({ ...(typeof cause?.command === 'string' ? { command: cause.command } : {}),
  ...(typeof cause?.failure === 'string' ? { failure: cause.failure } : {}) });

// Never inherit a caller's index or object-store overrides. All mutation callers
// supply the private repository explicitly; checkout commands are read-only.
const gitEnvironment = (base, env) => ({ ...base,
  GIT_DIR: undefined, GIT_COMMON_DIR: undefined, GIT_INDEX_FILE: undefined, GIT_WORK_TREE: undefined,
  GIT_OBJECT_DIRECTORY: undefined, GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
  GIT_OPTIONAL_LOCKS: '0', ...env });
// The Git subcommand of an argument list: the first word after global options
// and their values. Only a plain command name is reported, never an argument.
const GLOBAL_OPTIONS_WITH_VALUE = new Set(['--git-dir', '--work-tree', '--namespace', '-C', '-c']);
const gitCommand = (args) => {
  for (let index = 0; index < args.length; index++) {
    if (GLOBAL_OPTIONS_WITH_VALUE.has(args[index])) { index++; continue; }
    if (args[index].startsWith('-')) continue;
    return /^[a-z][a-z-]{0,31}$/.test(args[index]) ? args[index] : 'unknown';
  }
  return 'unknown';
};
const LOCK_FAILURE = /\.lock'?: File exists|Unable to create '[^']*\.lock'|cannot lock ref|unable to lock/i;
const CORRUPT_FAILURE = /bad object|missing (blob|tree|commit|object)|is corrupt|corrupt (loose )?object|unable to read [0-9a-f]{7,}|object file .* is empty|bad packed object|packfile .* (cannot|does not)|inflate: data stream error|did not receive expected object/i;
// A bounded failure class for diagnostics. Stderr is matched, never reported.
const failureClass = ({ timedOut, diskFull, notRepository, stderr, code, signal }) => timedOut ? 'timeout'
  : diskFull ? 'no_space' : notRepository ? 'not_git' : LOCK_FAILURE.test(stderr) ? 'lock'
    : CORRUPT_FAILURE.test(stderr) ? 'corrupt' : signal ? 'signal'
      : Number.isSafeInteger(code) && code >= 0 && code < 256 ? `exit_${code}` : 'exit_unknown';
const start = (cwd, args, { env, input, timeoutMs = 30_000, stdout = 'pipe', acceptExitCodes = [],ownedRunner } = {}) => {
  const signal = executionSignal();
  signal?.throwIfAborted();
  const owned=ownedRunner?ownedRunners.get(ownedRunner):undefined;
  if(ownedRunner&&!owned)throw changeError('owned_git_runner_invalid',503);
  owned?.assertAllowed?.(cwd,args,{env});
  const child = spawn(owned?.binary??'git', [...(owned?.argumentsPrefix??[]),...args], { cwd, env: gitEnvironment(owned?.environment??process.env, env),
    stdio: ['pipe', stdout, 'pipe'] });
  const abort = () => child.kill('SIGKILL');
  signal?.addEventListener('abort', abort, { once: true });
  let timedOut = false;
  let diskFull = false;
  let notRepository = false;
  let stderrTail = '';
  let stderrHead = '';
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
  // Classify only; never include file contents, Git configuration or paths in errors.
  child.stderr.on('data', (chunk) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-1024);
    // `fatal:` lines usually come first; keep them for classification too.
    if (stderrHead.length < 1024) stderrHead = (stderrHead + chunk.toString()).slice(0, 1024);
    if (/No space left on device|Disk quota exceeded/i.test(stderrTail)) diskFull = true;
    if (/not a git repository/i.test(stderrTail)) notRepository = true;
  });
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, exitSignal) => {
      // Which command failed and how, as bounded identifiers only.
      const failed = (errorCode, status) => Object.assign(changeError(errorCode, status), { command: gitCommand(owned ? [...owned.argumentsPrefix, ...args] : args),
        failure: failureClass({ timedOut, diskFull, notRepository, stderr: `${stderrHead}\n${stderrTail}`, code, signal: exitSignal }) });
      if (signal?.aborted) reject(signal.reason);
      else if (timedOut) reject(failed('capture_timeout', 503));
      else if (diskFull) reject(failed('storage_unavailable', 503));
      // Some commands report an answer by status, e.g. check-ignore's 1 for "none ignored".
      else if (code !== 0 && !acceptExitCodes.includes(code) && notRepository) reject(failed('capture_not_git', 409));
      else if (code !== 0 && !acceptExitCodes.includes(code)) reject(failed('capture_git_failed', 503));
      else { executionProgress(); resolve(); }
    });
  }).finally(() => { clearTimeout(timer); signal?.removeEventListener('abort', abort); });
  // Attach immediately, including while consumers are reading stdout.
  void done.catch(() => {});
  const writing = pipeline(typeof input === 'string' || Buffer.isBuffer(input)
    ? Readable.from([input]) : input ?? Readable.from([]), child.stdin).catch((error) => {
    if (error.code !== 'EPIPE' && error.code !== 'ERR_STREAM_PREMATURE_CLOSE') throw error;
  });
  void writing.catch(() => child.kill('SIGKILL'));
  return { child, done, writing };
};

export async function git(cwd, args, options = {}) {
  const process = start(cwd, args, options);
  const chunks = [];
  let bytes = 0;
  try {
    for await (const chunk of process.child.stdout) {
      bytes += chunk.length;
      if (bytes > (options.limit ?? 1024 * 1024)) throw changeError('change_record_too_large', 503);
      chunks.push(chunk);
    }
    await process.writing;
    await process.done;
    return Buffer.concat(chunks);
  } finally {
    process.child.kill('SIGKILL');
    await Promise.allSettled([process.done, process.writing]);
  }
}

export async function* gitTokens(cwd, args, options = {}) {
  const process = start(cwd, args, options);
  let tail = Buffer.alloc(0);
  const delimiter = options.delimiter ?? 0;
  try {
    for await (const chunk of process.child.stdout) {
      const data = tail.length ? Buffer.concat([tail, chunk]) : chunk;
      let offset = 0;
      for (let end; (end = data.indexOf(delimiter, offset)) !== -1;) {
        yield data.subarray(offset, end).toString();
        offset = end + 1;
      }
      tail = Buffer.from(data.subarray(offset));
      if (tail.length > 1024 * 1024) throw changeError('invalid_change_record', 503);
    }
    if (tail.length) yield tail.toString();
    await process.writing;
    await process.done;
  } finally {
    process.child.kill('SIGKILL');
    await Promise.allSettled([process.done, process.writing]);
  }
}

export async function gitToFile(cwd, args, file, options = {}) {
  // Let the kernel carry blob/patch bytes directly from Git to the file. A
  // JS pipeline would allocate a new Buffer for every chunk of a large blob.
  const handle = await fs.open(file, 'wx', options.mode ?? 0o600);
  let process;
  try {
    process = start(cwd, args, { ...options, stdout: handle.fd });
    await process.writing;
    await process.done;
    await handle.sync();
  } finally {
    if (process) {
      process.child.kill('SIGKILL');
      await Promise.allSettled([process.done, process.writing]);
    }
    await handle.close();
  }
}

// Read small metadata blobs in one Git process. Each input and output batch is
// bounded; history length never determines the size of a stdout buffer.
export async function* gitRecords(cwd, args, rows,options={}) {
  let batch = [], bytes = 0;
  const read = async (entries) => {
    const data = await git(cwd, [...args, 'cat-file', '--batch'], {...options,
      input: entries.map((entry) => entry.oid).join('\n') + '\n', limit: 8 * 1024 * 1024 + 16 * 1024,
    });
    let offset = 0;
    return entries.map((entry) => {
      const end = data.indexOf(10, offset);
      const header = data.subarray(offset, end).toString().split(' ');
      const size = Number(header[2]);
      if (end < 0 || header[1] !== 'blob' || !Number.isSafeInteger(size) || size < 0 || end + 1 + size >= data.length) throw changeError('invalid_change_record', 503);
      offset = end + 1 + size + 1;
      return { key: entry.key, oid: entry.oid, value: JSON.parse(data.subarray(end + 1, offset - 1).toString()) };
    });
  };
  for await (const row of rows) {
    if (!Number.isSafeInteger(row.size) || row.size < 0 || row.size > 512 * 1024) throw changeError('invalid_change_record', 503);
    // The byte bound caps each read; the count bound only limits spawns.
    if (batch.length && (batch.length >= 4096 || bytes + row.size > 4 * 1024 * 1024)) {
      yield* await read(batch); batch = []; bytes = 0;
    }
    batch.push(row); bytes += row.size;
  }
  if (batch.length) yield* await read(batch);
}

// Long-lived `cat-file --batch` (contents) or `--batch-check` (identity) per
// Git directory: a ledger transaction reads tens of small objects, and one
// process per read cost 5-50 ms each. Requests are answered in order; a dead
// or stuck process fails every pending read and the next read starts a new
// one. An idle reader exits on its own and never keeps the host alive. Packs
// written later are found because Git rescans them on a miss. Windows keeps
// one process per read: an open pack there would block repack's deletion.
const READER_IDLE_MS = 15_000;
const READER_TIMEOUT_MS = 30_000;
const readers = new Map();
const openReader = (cwd, args, check) => {
  const key = JSON.stringify([cwd, args, check]);
  const existing = readers.get(key);
  if (existing && !existing.closed) return existing;
  const child = spawn('git', [...args, 'cat-file', check ? '--batch-check' : '--batch'], { cwd, env: gitEnvironment(process.env),
    stdio: ['pipe', 'pipe', 'ignore'] });
  const reader = { child, pending: [], buffer: Buffer.alloc(0), closed: false, idle: null, watchdog: null };
  readers.set(key, reader);
  const close = (error) => {
    if (reader.closed) return;
    reader.closed = true;
    if (readers.get(key) === reader) readers.delete(key);
    clearTimeout(reader.idle); clearInterval(reader.watchdog);
    child.kill('SIGKILL');
    for (const request of reader.pending.splice(0)) request.reject(error ?? changeError('capture_git_failed', 503));
  };
  reader.close = close;
  const settle = () => {
    for (;;) {
      const request = reader.pending[0];
      if (!request) { if (reader.buffer.length) close(changeError('invalid_change_record', 503)); return; }
      const end = reader.buffer.indexOf(10);
      if (end < 0) return;
      const header = reader.buffer.subarray(0, end).toString();
      if (header.endsWith(' missing') || header.endsWith(' ambiguous')) {
        reader.buffer = reader.buffer.subarray(end + 1); reader.pending.shift(); request.resolve(null); continue;
      }
      const [oid, type, sizeText] = header.split(' '), size = Number(sizeText);
      if (!oid || !type || !Number.isSafeInteger(size) || size < 0) { close(changeError('invalid_change_record', 503)); return; }
      if (check) { reader.buffer = reader.buffer.subarray(end + 1); reader.pending.shift(); request.resolve({ oid, type, size }); continue; }
      if (reader.buffer.length < end + 1 + size + 1) return;
      const data = Buffer.from(reader.buffer.subarray(end + 1, end + 1 + size));
      reader.buffer = reader.buffer.subarray(end + 1 + size + 1); reader.pending.shift();
      request.resolve({ oid, type, size, data });
    }
  };
  child.stdout.on('data', (chunk) => { reader.buffer = reader.buffer.length ? Buffer.concat([reader.buffer, chunk]) : chunk; settle(); });
  child.on('error', () => close());
  child.on('close', () => close());
  child.stdin.on('error', () => close());
  reader.watchdog = setInterval(() => {
    if (reader.pending.length && Date.now() - reader.pending[0].started > READER_TIMEOUT_MS) close(changeError('capture_timeout', 503));
  }, 1_000);
  reader.watchdog.unref?.();
  // Only a pending read keeps the event loop alive. Toggle on change only:
  // Bun counts a repeated ref() and then never lets the process exit.
  let held = true;
  reader.hold = (next) => {
    if (next === held) return;
    held = next;
    for (const handle of [child, child.stdin, child.stdout]) next ? handle.ref?.() : handle.unref?.();
  };
  return reader;
};
// One object by name (`<oid>` or `<tree>:<path>`), or null when absent.
// `check` answers only { oid, type, size }.
// `idleMs` (tests) shortens how long an idle reader lives.
export function readGitObject(cwd, args, name, { check = false, idleMs = READER_IDLE_MS } = {}) {
  executionSignal()?.throwIfAborted();
  if (typeof name !== 'string' || !name || /[\n\r\0]/.test(name)) return Promise.reject(changeError('invalid_change_record'));
  const reader = openReader(cwd, args, check);
  clearTimeout(reader.idle);
  reader.hold(true);
  return new Promise((resolve, reject) => {
    reader.pending.push({ started: Date.now(), resolve, reject });
    reader.child.stdin.write(`${name}\n`);
  }).finally(() => {
    if (reader.closed || reader.pending.length) return;
    reader.hold(false);
    // Reads settling together each get here: replace, never orphan, the timer.
    clearTimeout(reader.idle);
    reader.idle = setTimeout(() => { if (!reader.pending.length) reader.close(); }, idleMs);
    reader.idle.unref?.();
  });
}
export const persistentGitReaders = () => process.platform !== 'win32' && process.env.DEVRYAN_LEDGER_PERSISTENT_READER !== '0';
