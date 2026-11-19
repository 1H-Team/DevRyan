// The product route census (lib/multi-user/test-route-registry.js,
// enumerateServerRoutes), run in a child process: it imports every registrar,
// whose modules keep timers alive, so it cannot run in a test process. Used by
// the reach and layer-stack checks (reach.mjs) of every harness run, and by the
// second self-test file. The self-test proper never runs it.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { REPOSITORY_ROOT, SERVER_ROOT } from './edge.mjs';
import { onceFinished } from './child-finish.mjs';

const serverModule = (relative) => import(pathToFileURL(path.join(SERVER_ROOT, relative)).href);

async function censusHere({ dataDirectory }) {
  const { enumerateServerRoutes } = await serverModule('lib/multi-user/test-route-registry.js');
  const { createMultiUserRuntime } = await serverModule('lib/multi-user/runtime.js');
  const quiet = { warn() {}, error() {}, info() {}, log() {} };
  const multiUserRuntime = await createMultiUserRuntime({ dataDirectory, fetchImpl: async () => { throw new Error('the census reaches no network'); }, logger: quiet });
  const census = await enumerateServerRoutes({ multiUserRuntime, dataDirectory });
  const plain = (entry) => ({ method: entry.method ?? null, path: entry.path ?? null, order: entry.order, file: entry.file, line: entry.line, viaRouter: Boolean(entry.viaRouter) });
  return { routes: census.routes.map(plain), mounts: census.mounts.map(plain) };
}

/**
 * Runs the census in a child and returns `{ routes, mounts }` without handlers.
 * `dataDirectory` must be a private directory of the run; `timeoutMs` bounds
 * the child (it is killed and the call rejects).
 */
export async function runCensus({ dataDirectory, timeoutMs = 120_000 }) {
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--census', `--data-root=${dataDirectory}`], { cwd: REPOSITORY_ROOT, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const killOnExit = () => { try { child.kill('SIGKILL'); } catch { /* gone */ } };
  process.once('exit', killOnExit);
  const timer = setTimeout(() => { stderr += `\n(the census did not finish within ${timeoutMs} ms and was killed)`; killOnExit(); }, timeoutMs);
  // Settled when the child is gone and its output has been read to the end (child-finish.mjs).
  const code = await new Promise((resolve) => { onceFinished(child, (exitCode, signal) => resolve(exitCode ?? signal)); });
  clearTimeout(timer);
  process.off('exit', killOnExit);
  const line = stdout.split('\n').find((entry) => entry.startsWith('{"census":'));
  if (code !== 0 || !line) throw new Error(`the route census failed (${code}):\n${stderr}`);
  return JSON.parse(line).census;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href && process.argv[2] === '--census') {
  const { isolationRefusal } = await import('./run-scratch.mjs');
  const refusal = isolationRefusal();
  const dataDirectory = /^--data-root=(.+)$/.exec(process.argv[3] ?? '')?.[1];
  if (refusal || !dataDirectory) { process.stderr.write(`${refusal ?? 'usage: census.mjs --census --data-root=<dir>'}\n`); process.exit(64); }
  // The census dies with its parent (stdin closes when the parent dies, whatever the signal).
  process.stdin.on('end', () => process.exit(129)).resume();
  const census = await censusHere({ dataDirectory });
  process.stdout.write(`${JSON.stringify({ census })}\n`);
  // Product modules loaded by the census keep timers; the census is complete.
  process.exit(0);
}
