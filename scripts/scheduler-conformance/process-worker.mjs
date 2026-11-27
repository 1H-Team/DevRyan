// The worker thread of the process candidate (process-candidate.mjs): it owns
// the candidate's child process, so the main thread can block for the child's
// next line (Atomics.wait) while this thread's event loop reads it. Every
// stdout line is posted to the main thread's port, then the shared counter is
// raised and notified; the child's end (its exit code, signal and a bounded
// tail of its stderr) is posted the same way, once its streams have closed.
import { spawn } from 'node:child_process';
import { workerData } from 'node:worker_threads';

const { command, args, port, signal } = workerData;
const STDERR_LIMIT = 64 * 1024;
const wake = () => { Atomics.add(signal, 0, 1); Atomics.notify(signal, 0); };

const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
let pending = '';
let stderr = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  pending += chunk;
  for (let end = pending.indexOf('\n'); end >= 0; end = pending.indexOf('\n')) {
    port.postMessage({ line: pending.slice(0, end) });
    pending = pending.slice(end + 1);
    wake();
  }
});
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-STDERR_LIMIT); });
child.stdin.on('error', () => { /* the child's end is reported by `close` */ });
child.on('error', (error) => { port.postMessage({ closed: { code: null, signal: null, error: String(error?.message ?? error), stderr } }); wake(); });
child.on('close', (code, killedBy) => { port.postMessage({ closed: { code, signal: killedBy, rest: pending.slice(0, 4096), stderr } }); wake(); });
port.on('message', (message) => {
  if (typeof message.write === 'string') child.stdin.write(message.write);
  if (message.end) child.stdin.end();
  if (message.kill && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
});
port.postMessage({ spawned: child.pid ?? null });
wake();
