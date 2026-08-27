#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDevDataDirectory } from '../../../scripts/dev-data-directory.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../../..');
const electronDir = path.join(repoRoot, 'packages/electron');
const devDataDirectory = resolveDevDataDirectory({
  env: process.env,
  repoRoot,
  scope: 'electron',
});
const baseDevEnvironment = {
  ...process.env,
  OPENCHAMBER_ELECTRON_DEV: '1',
  OPENCHAMBER_DATA_DIR: devDataDirectory,
  OPENCHAMBER_ELECTRON_USER_DATA_DIR: path.join(devDataDirectory, 'electron-user-data'),
};

// On macOS, prefer launching via the built & signed DevRyan.app binary so
// macOS TCC consent (Documents/Desktop/Downloads) persists across dev
// restarts. The packaged app has a stable code-signing identity; raw
// `npx electron` does not, so it re-prompts for protected-folder access.
function resolveDevElectronCommand() {
  if (process.env.OPENCHAMBER_DEV_FORCE_NPX_ELECTRON === '1') {
    return { command: 'npx', args: ['electron', './main.mjs'] };
  }

  if (process.platform === 'darwin') {
    const arches = [process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'mac-arm64', 'mac'];
    for (const arch of arches) {
      const candidate = path.join(
        electronDir,
        'dist',
        arch,
        'DevRyan.app',
        'Contents',
        'MacOS',
        'DevRyan',
      );
      if (existsSync(candidate)) {
        console.log(`[electron:dev] Using built DevRyan.app at ${candidate} (stable TCC identity)`);
        return { command: candidate, args: ['./main.mjs'] };
      }
    }
    console.log(
      '[electron:dev] No built DevRyan.app found; falling back to `npx electron`. '
        + 'Run `npm run package` once to get persistent macOS folder permissions.',
    );
  }

  return { command: 'npx', args: ['electron', './main.mjs'] };
}

function spawnProcess(command, args, options = {}) {
  const { env = {}, ...spawnOptions } = options;
  return spawn(command, args, {
    cwd: repoRoot,
    env: { ...baseDevEnvironment, ...env },
    stdio: 'inherit',
    detached: process.platform !== 'win32',
    ...spawnOptions,
  });
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }

    const onExit = () => {
      clearTimeout(timer);
      resolve();
    };

    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve();
    }, timeoutMs);

    child.once('exit', onExit);
  });
}

function signalChild(child, signal) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  try {
    if (process.platform !== 'win32') {
      process.kill(-child.pid, signal);
      return;
    }
  } catch {
  }

  try {
    child.kill(signal);
  } catch {
  }
}

async function stopChildTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  signalChild(child, 'SIGINT');
  await waitForExit(child, 2500);

  if (child.exitCode === null && child.signalCode === null) {
    signalChild(child, 'SIGTERM');
    await waitForExit(child, 2500);
  }

  if (child.exitCode === null && child.signalCode === null) {
    signalChild(child, 'SIGKILL');
    await waitForExit(child, 1000);
  }
}

async function main() {
  if (process.platform === 'darwin') {
    const result = spawnSync('node', ['./scripts/build-speech-helper.mjs'], {
      cwd: electronDir,
      stdio: 'inherit',
      env: baseDevEnvironment,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`Failed to build macOS speech helper: exit ${result.status}`);
    }
  }

  const devServer = spawnProcess('node', ['./scripts/dev-web-hmr.mjs'], {
    env: {
      OPENCHAMBER_HMR_UI_PORT: '5173',
      OPENCHAMBER_HMR_API_PORT: '3901',
      OPENCHAMBER_DISABLE_PWA_DEV: '1',
    },
  });
  const { command: electronCmd, args: electronArgs } = resolveDevElectronCommand();
  const electron = spawnProcess(electronCmd, electronArgs, { cwd: electronDir });

  let cleaning = false;
  const teardown = async (code) => {
    if (cleaning) {
      return;
    }
    cleaning = true;

    await Promise.all([stopChildTree(electron), stopChildTree(devServer)]);
    process.exit(typeof code === 'number' ? code : 0);
  };

  const onChildExit = (label) => (code, signal) => {
    if (code !== 0 || signal) {
      console.warn(`[electron:dev] ${label} exited with code ${code ?? 'null'} signal ${signal ?? 'none'}.`);
    }
    void teardown(code ?? 1);
  };

  devServer.on('exit', onChildExit('dev server'));
  electron.on('exit', onChildExit('electron'));
  devServer.on('error', (error) => {
    console.error('[electron:dev] failed to start dev server:', error);
    void teardown(1);
  });
  electron.on('error', (error) => {
    console.error('[electron:dev] failed to start electron:', error);
    void teardown(1);
  });

  for (const [signal, exitCode] of Object.entries({ SIGINT: 130, SIGTERM: 143, SIGQUIT: 131, SIGHUP: 129 })) {
    process.on(signal, () => {
      void teardown(exitCode);
    });
  }
}

main().catch((error) => {
  console.error('[electron:dev] unexpected error:', error);
  process.exit(1);
});
