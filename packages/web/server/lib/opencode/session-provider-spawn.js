import { spawn } from 'node:child_process';

/** Claude remains a model transport in Meridian passthrough mode. All client
 * tools execute through OpenCode's attributed dispatcher. This extra boundary
 * also prevents SDK hooks or an unexpected built-in call mutating the project. */
export function spawnConfinedProvider(options) {
  const worker = process.env.DEVRYAN_PROVIDER_WORKER;
  const launcher = process.env.DEVRYAN_EXECUTION_LAUNCHER;
  const storage = process.env.DEVRYAN_PROVIDER_STORAGE;
  if (!worker || !launcher || !storage) throw new Error('mutation_runtime_unsupported: provider confinement artifacts are unavailable');
  const child = spawn(process.execPath, [worker], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    env: { ...options.env, DEVRYAN_EXECUTION_LAUNCHER: launcher, DEVRYAN_PROVIDER_STORAGE: storage,
      DEVRYAN_PROVIDER_COMMAND: JSON.stringify({ command: options.command, args: options.args, directory: options.cwd }),
      // A compiled Bun host must behave as Node for this standalone worker.
      ...(process.versions.bun ? { BUN_BE_BUN: '1' } : {}) } });
  const cancel = () => child.kill('SIGTERM');
  options.signal?.addEventListener('abort', cancel, { once: true });
  child.once('close', () => options.signal?.removeEventListener('abort', cancel));
  if (options.signal?.aborted) cancel();
  return child;
}
