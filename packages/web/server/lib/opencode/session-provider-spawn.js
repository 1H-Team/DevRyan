import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';

const isDirectory = (directory) => {
  try { return statSync(directory).isDirectory(); } catch { return false; }
};

/** Meridian derives the Claude working directory from OpenCode's `<env>`
 * block, which opencode-with-claude scrubs, then falls back to the host
 * process cwd: whichever project launched OpenCode. The bundled
 * devryan-claude-transport plugin therefore sends the requesting instance's
 * directory (URI-encoded `x-devryan-directory`) to the loopback proxy. A named
 * existing absolute directory is authoritative; a named invalid one, or none
 * inside the execution boundary, refuses the request rather than running the
 * transport (and keying its private state) in another project. Without the
 * header outside the boundary, Meridian's own resolution is unchanged. */
export function resolveSessionWorkingDirectory(encoded, {
  boundary = process.env.DEVRYAN_EXECUTION_BOUNDARY === '1',
  exists = isDirectory,
} = {}) {
  if (typeof encoded !== 'string' || !encoded) {
    return boundary
      ? { rejection: 'session_directory_unavailable: DevRyan did not identify the requesting session directory; the Claude transport refused to run in another project.' }
      : {};
  }
  let directory = null;
  try { directory = decodeURIComponent(encoded); } catch { /* Malformed: refused below. */ }
  if (directory && path.isAbsolute(directory) && exists(path.resolve(directory))) {
    const workingDirectory = path.resolve(directory);
    return { resolution: { workingDirectory, claimedWorkingDirectory: workingDirectory, fellBack: false } };
  }
  return { rejection: 'session_directory_unavailable: the requesting session directory is not an existing absolute directory; the Claude transport refused to run in another project.' };
}

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
