import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { changeError } from './session-changes-git.js';

/** A pipe keeps the native lock attached to this host's lifetime. Losing the
 * keeper permanently invalidates this instance, even if its JS host survives. */
export async function createExecutionHostOwner({ directory, launcher, spawnImpl = spawn,
  startupTimeoutMs = 5000, terminationTimeoutMs = 1000 }) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const id = randomUUID(), file = path.join(directory, `${id}.lock`), controller = new AbortController();
  const child = spawnImpl(launcher, ['--owner-lock', file], { stdio: ['pipe', 'pipe', 'ignore'] });
  let closed = false;
  const reaped = new Promise((resolve) => child.once('close', () => { closed = true; resolve(); }));
  const lost = () => controller.abort(changeError('execution_owner_lost', 503));
  child.once('error', lost); child.once('close', lost);
  child.stdin.on('error', lost);
  const waitForClose = async () => {
    let timer;
    try { await Promise.race([reaped, new Promise((resolve) => { timer = setTimeout(resolve, terminationTimeoutMs); })]); }
    finally { clearTimeout(timer); }
    return closed;
  };
  let closing;
  const close = () => closing ??= (async () => {
    if (closed) return;
    child.stdin.end(); child.kill('SIGTERM');
    if (await waitForClose()) return;
    child.kill('SIGKILL');
    if (!await waitForClose()) throw changeError('execution_owner_termination_unconfirmed', 503);
  })();
  try {
    await new Promise((resolve, reject) => {
      let received = '';
      const finish = (error) => {
        clearTimeout(timer); child.removeListener('close', fail); child.removeListener('error', fail);
        child.stdout.removeListener('data', data);
        if (error) reject(error); else resolve();
      };
      const fail = () => finish(changeError('execution_owner_unavailable', 503));
      const data = (bytes) => {
        received += bytes.toString();
        if (!'owned\n'.startsWith(received)) fail();
        else if (received === 'owned\n') finish();
      };
      const timer = setTimeout(fail, startupTimeoutMs);
      child.once('close', fail); child.once('error', fail); child.stdout.on('data', data);
    });
    controller.signal.throwIfAborted();
  } catch (cause) {
    // Failed initialization is retryable only after authoritative child close.
    // An unreaped keeper leaves a distinct non-retryable failure in the host.
    await close();
    throw cause;
  }
  return { id, signal: controller.signal, close, assert: () => controller.signal.throwIfAborted() };
}

export async function executionHostOwnerLost({ directory, launcher, id }) {
  if (!/^[a-f0-9-]{36}$/.test(id ?? '')) return false;
  return new Promise((resolve, reject) => {
    const child = spawn(launcher, ['--owner-probe', path.join(directory, `${id}.lock`)], { stdio: 'ignore' });
    const timer = setTimeout(() => child.kill(), 5000);
    child.once('error', reject);
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(true);
      else if (code === 73) resolve(false);
      else reject(changeError('execution_owner_unavailable', 503));
    });
  });
}

/** Cache one attempt; initialization failures are retryable only once reaped.
 * A keeper lost after startup invalidates only its own instance: the next
 * caller retires it (drain and authoritative reap) and creates a new owner
 * with a new identity. Leases of the lost owner keep the owner-lost rules; an
 * unconfirmed reap stays a cached, non-retryable failure. */
export function executionOwnerFactory(create, {
  isLost = (value) => Boolean(value?.owner?.signal?.aborted),
  retire = (value) => value?.owner?.close?.(),
} = {}) {
  let current, resolved;
  const start = (task) => {
    const attempt = Promise.resolve().then(task);
    current = attempt; resolved = undefined;
    void attempt.then((value) => { if (current === attempt) resolved = value; }, (cause) => {
      if (current === attempt && cause?.code !== 'execution_owner_termination_unconfirmed') current = undefined;
    });
    return attempt;
  };
  return () => {
    if (current && resolved !== undefined && isLost(resolved)) {
      const lost = resolved;
      return start(async () => { await retire(lost); return create(); });
    }
    return current ?? start(create);
  };
}
