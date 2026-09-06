import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { describe, test } from 'node:test';

import { stopChildTree } from './dev-child-utils.mjs';
import { resolveDevDataDirectory } from './dev-data-directory.mjs';
import { shouldRestartDevChild } from './dev-restart-policy.mjs';
import { buildPlan } from './validate.mjs';

function waitForOutput(child, expected) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for child output: ${expected}`));
    }, 2000);

    const onData = (chunk) => {
      output += chunk.toString();
      if (!output.includes(expected)) return;
      cleanup();
      resolve();
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`Child exited before readiness (code=${code ?? 'null'} signal=${signal ?? 'none'})`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout?.off('data', onData);
      child.off('exit', onExit);
    };

    child.stdout?.on('data', onData);
    child.once('exit', onExit);
  });
}

function isProcessGroupRunning(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

describe('shouldRestartDevChild', () => {
  test('restarts when not shutting down', () => {
    assert.equal(shouldRestartDevChild({ shuttingDown: false }), true);
  });

  test('does not restart while shutting down', () => {
    assert.equal(shouldRestartDevChild({ shuttingDown: true }), false);
  });
});

describe('resolveDevDataDirectory', () => {
  test('preserves an explicit data-directory override', () => {
    assert.equal(resolveDevDataDirectory({
      env: { OPENCHAMBER_DATA_DIR: './explicit-dev-data' },
      repoRoot: '/workspace/devryan',
      scope: 'electron',
    }), path.resolve('./explicit-dev-data'));
  });

  test('isolates defaults by checkout and development mode', () => {
    const options = {
      env: {},
      repoRoot: '/workspace/devryan-a',
      scope: 'web-hmr',
      temporaryRoot: '/tmp/devryan-tests',
    };
    const first = resolveDevDataDirectory(options);

    assert.equal(resolveDevDataDirectory(options), first);
    assert.notEqual(resolveDevDataDirectory({
      ...options,
      repoRoot: '/workspace/devryan-b',
    }), first);
    assert.notEqual(resolveDevDataDirectory({
      ...options,
      scope: 'electron',
    }), first);
    assert.equal(path.dirname(path.dirname(path.dirname(first))), '/tmp/devryan-tests');
  });
});

describe('stopChildTree', () => {
  test('waits for a detached process group after its wrapper leader exits', async () => {
    if (process.platform !== 'darwin') {
      assert.equal(typeof stopChildTree, 'function');
      return;
    }
    const workerSource = `
      process.on('SIGINT', () => setTimeout(() => process.exit(0), 300));
      process.stdout.write('ready\\n');
      setInterval(() => undefined, 1000);
    `;
    const wrapperSource = `
      const { spawn } = require('node:child_process');
      const worker = spawn(process.execPath, ['-e', ${JSON.stringify(workerSource)}], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      worker.stdout.once('data', () => process.stdout.write('ready\\n'));
      process.on('SIGINT', () => process.exit(0));
      setInterval(() => undefined, 1000);
    `;
    const wrapper = spawn(process.execPath, ['-e', wrapperSource], {
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    try {
      await waitForOutput(wrapper, 'ready');
      await stopChildTree(wrapper);
      assert.equal(isProcessGroupRunning(wrapper.pid), false);
    } finally {
      if (isProcessGroupRunning(wrapper.pid)) {
        process.kill(-wrapper.pid, 'SIGKILL');
      }
    }
  });
});

describe('affected validation planning', () => {
  test('runs Cursor tests and dependent host validation for Cursor runtime code', () => {
    const plan = buildPlan('affected', [
      'packages/cursor-sdk-runtime/persistent-worker.mjs',
    ]);

    assert.deepEqual(plan.commands.map((entry) => entry.label), [
      'typeCheck:web',
      'test:cursor',
      'test:web',
    ]);
    assert.deepEqual(plan.commands.find((entry) => entry.label === 'test:cursor')?.args, [
      'test',
      'packages/cursor-sdk-runtime',
    ]);
  });

  test('still runs the Cursor package suite in quick mode', () => {
    const plan = buildPlan('quick', [
      'packages/cursor-sdk-runtime/agent-cache.js',
    ]);

    assert.deepEqual(plan.commands.map((entry) => entry.label), ['test:cursor']);
  });

  test('runs the Electron suite for affected shell code', () => {
    const plan = buildPlan('affected', [
      'packages/electron/scripts/native-module-paths.mjs',
    ]);

    assert.deepEqual(plan.commands.map((entry) => entry.label), [
      'lint:electron',
      'typeCheck:electron',
      'test:electron',
    ]);
  });

  test('runs the legacy Tauri suite for Rust compatibility code', () => {
    const affected = buildPlan('affected', [
      'packages/desktop/src-tauri/src/main.rs',
    ]);
    const quick = buildPlan('quick', [
      'packages/desktop/src-tauri/Cargo.toml',
    ]);

    assert.deepEqual(affected.commands.map((entry) => entry.label), [
      'lint:desktop',
      'typeCheck:desktop',
      'test:desktop',
    ]);
    assert.deepEqual(quick.commands.map((entry) => entry.label), [
      'typeCheck:desktop',
      'test:desktop',
    ]);
  });

  test('runs orchestration tests and every dependent runtime for orchestration core changes', () => {
    const plan = buildPlan('affected', [
      'packages/orchestration-runtime/scheduler.js',
    ]);

    assert.deepEqual(plan.commands.map((entry) => entry.label), [
      'typeCheck:ui',
      'typeCheck:web',
      'test:orchestration',
      'test:ui',
      'test:web',
    ]);
  });

  test('still runs the orchestration package suite in quick mode', () => {
    const plan = buildPlan('quick', [
      'packages/orchestration-runtime/contract.js',
    ]);

    assert.deepEqual(plan.commands.map((entry) => entry.label), ['test:orchestration']);
  });
});
