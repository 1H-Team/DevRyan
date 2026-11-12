// The JavaScript reference runtime of the native ledger's differential
// tests: the Node inside Electron, which runs the ledger in the product,
// started as plain Node (ELECTRON_RUN_AS_NODE=1). The binary is the one the
// installed `electron` package names for this platform; only where that
// binary is absent does the reference fall back to the Node running this
// script, and the description printed with the run says which one it is.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import process from 'node:process';

const require = createRequire(import.meta.url);

/** The Electron binary of the installed `electron` package, or null with the reason it is unusable. */
export function electronBinary({ load = (name) => require(name), exists = existsSync } = {}) {
  let binary;
  try {
    // The package's entry point is the platform's binary path (dist/ plus its path.txt).
    binary = load('electron');
  } catch (error) {
    return { binary: null, reason: `the electron package names no binary (${error instanceof Error ? error.message : String(error)})` };
  }
  if (typeof binary !== 'string' || !exists(binary)) return { binary: null, reason: `Electron's binary is absent (${String(binary)})` };
  return { binary, reason: null };
}

let cached;

/**
 * `{ command, env, electron, versions, description }`: how to start the
 * reference, the environment it needs (merge it over the child's), and what
 * it is. Resolved once per process.
 */
export function referenceRuntime() {
  if (cached) return cached;
  const { binary, reason } = electronBinary();
  if (binary) {
    const env = { ELECTRON_RUN_AS_NODE: '1' };
    const probe = spawnSync(binary, ['-e', 'process.stdout.write(JSON.stringify(process.versions))'], { encoding: 'utf8', env: { ...process.env, ...env } });
    if (probe.status === 0) {
      const versions = JSON.parse(probe.stdout);
      cached = Object.freeze({ command: binary, env: Object.freeze(env), electron: true, versions,
        description: `Electron ${versions.electron}'s Node v${versions.node} (libuv ${versions.uv}), ${binary}` });
      return cached;
    }
    return fallback(`Electron's binary did not start as Node (exit ${probe.status ?? probe.signal}): ${probe.stderr.trim()}`);
  }
  return fallback(reason);
}

function fallback(reason) {
  cached = Object.freeze({ command: process.execPath, env: Object.freeze({}), electron: false, versions: process.versions,
    description: `this Node v${process.versions.node} (libuv ${process.versions.uv}), ${process.execPath}, because ${reason}` });
  return cached;
}
