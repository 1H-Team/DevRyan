import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

export function parseNumstat(raw) {
  const fields = raw.split('\0'), result = {};
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index], first = field.indexOf('\t'), second = field.indexOf('\t', first + 1);
    if (first < 0 || second < 0) continue;
    let name = field.slice(second + 1);
    if (!name) { index++; name = fields[++index]; } // -z rename: old\0new\0
    if (!name) continue;
    const count = (value) => /^\d+$/.test(value) ? Number(value) : 0;
    result[name] = { insertions: count(field.slice(0, first)), deletions: count(field.slice(first + 1, second)) };
  }
  return result;
}

export async function fileStatusVersion(directory, file) {
  const stat = await fs.lstat(path.resolve(directory, file), { bigint: true }).catch((cause) => {
    if (cause.code === 'ENOENT') return null; throw cause;
  });
  return stat ? [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode].join(':') : 'missing';
}

/** Stream untracked names and stop the owned read after the display bound.
 * Always wait for close, including timeout/abort and deliberate truncation. */
export async function boundedUntracked({ binary, directory, env, signal, limit = 2000 }) {
  signal?.throwIfAborted();
  const child = spawn(binary, ['-c', 'core.fsmonitor=false', 'ls-files', '--others', '--exclude-standard', '-z'], {
    cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  const names = []; let tail = '', truncated = false, error;
  const abort = () => child.kill('SIGKILL');
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  child.once('error', (cause) => { error = cause; });
  child.stderr.resume();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (data) => {
    if (truncated) return;
    const fields = (tail + data).split('\0'); tail = fields.pop();
    for (const file of fields) {
      if (names.length >= limit) { truncated = true; abort(); break; }
      names.push(file);
    }
  });
  const code = await new Promise((resolve) => child.once('close', resolve));
  signal?.removeEventListener('abort', abort);
  signal?.throwIfAborted();
  if (error) throw error;
  if (!truncated && code !== 0) throw new Error('Unable to list untracked files');
  return { names, truncated };
}
