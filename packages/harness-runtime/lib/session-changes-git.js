import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import fs from 'node:fs/promises';

export const changeError = (code, status = 409) => Object.assign(new Error(code), { code, status });

// Never inherit a caller's index or object-store overrides. All mutation callers
// supply the private repository explicitly; checkout commands are read-only.
const start = (cwd, args, { env, input, timeoutMs = 30_000, stdout = 'pipe' } = {}) => {
  const child = spawn('git', args, { cwd, env: { ...process.env,
    GIT_DIR: undefined, GIT_COMMON_DIR: undefined, GIT_INDEX_FILE: undefined, GIT_WORK_TREE: undefined,
    GIT_OBJECT_DIRECTORY: undefined, GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
    GIT_OPTIONAL_LOCKS: '0', ...env }, stdio: ['pipe', stdout, 'pipe'] });
  let timedOut = false;
  let diskFull = false;
  let stderrTail = '';
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
  // Classify only; never include file contents, Git configuration or paths in errors.
  child.stderr.on('data', (chunk) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-1024);
    if (/No space left on device|Disk quota exceeded/i.test(stderrTail)) diskFull = true;
  });
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      if (timedOut) reject(changeError('capture_timeout', 503));
      else if (diskFull) reject(changeError('storage_unavailable', 503));
      else if (code !== 0) reject(changeError('capture_git_failed', 503));
      else resolve();
    });
  }).finally(() => clearTimeout(timer));
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
export async function* gitRecords(cwd, args, rows) {
  let batch = [], bytes = 0;
  const read = async (entries) => {
    const data = await git(cwd, [...args, 'cat-file', '--batch'], {
      input: entries.map((entry) => entry.oid).join('\n') + '\n', limit: 8 * 1024 * 1024 + 16 * 1024,
    });
    let offset = 0;
    return entries.map((entry) => {
      const end = data.indexOf(10, offset);
      const header = data.subarray(offset, end).toString().split(' ');
      const size = Number(header[2]);
      if (end < 0 || header[1] !== 'blob' || !Number.isSafeInteger(size) || size < 0 || end + 1 + size >= data.length) throw changeError('invalid_change_record', 503);
      offset = end + 1 + size + 1;
      return { key: entry.key, value: JSON.parse(data.subarray(end + 1, offset - 1).toString()) };
    });
  };
  for await (const row of rows) {
    if (!Number.isSafeInteger(row.size) || row.size < 0 || row.size > 512 * 1024) throw changeError('invalid_change_record', 503);
    if (batch.length && (batch.length >= 256 || bytes + row.size > 4 * 1024 * 1024)) {
      yield* await read(batch); batch = []; bytes = 0;
    }
    batch.push(row); bytes += row.size;
  }
  if (batch.length) yield* await read(batch);
}
