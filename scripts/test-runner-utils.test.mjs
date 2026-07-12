import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';

import { discoverTestFiles, isIsolatedUiTestSource } from './test-runner-utils.mjs';
import { discoverVscodeBunTestFiles } from './test-vscode.mjs';

const repoRoot = new URL('..', import.meta.url);

describe('isIsolatedUiTestSource', () => {
  test('isolates source that mutates global window through supported patterns', () => {
    assert.equal(isIsolatedUiTestSource('globalThis.window = {}'), true);
    assert.equal(isIsolatedUiTestSource('globalWithWindow.window = previousWindow'), true);
    assert.equal(isIsolatedUiTestSource('(globalThis as Record<string, unknown>).window = w'), true);
    assert.equal(isIsolatedUiTestSource("Object.defineProperty(globalThis, 'window', { value: {} })"), true);
  });

  test('isolates module mocks and global sessionStorage mutations', () => {
    assert.equal(isIsolatedUiTestSource("mock.module('@/lib/opencode/client', () => ({}))"), true);
    assert.equal(isIsolatedUiTestSource('globalThis.sessionStorage = storage'), true);
    assert.equal(isIsolatedUiTestSource('Object.defineProperty(globalThis, "sessionStorage", { value: storage })'), true);
  });

  test('does not isolate plain window reads', () => {
    assert.equal(isIsolatedUiTestSource('globalThis.window.addEventListener("x", listener)'), false);
  });
});

describe('test file discovery', () => {
  test('discovers nested test files relative to the package root', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'devryan-tests-'));
    try {
      mkdirSync(path.join(root, 'tests/nested'), { recursive: true });
      writeFileSync(path.join(root, 'tests/example.test.ts'), '');
      writeFileSync(path.join(root, 'tests/nested/another.test.ts'), '');
      writeFileSync(path.join(root, 'tests/nested/helper.ts'), '');

      assert.deepEqual(discoverTestFiles(path.join(root, 'tests'), root), [
        'tests/example.test.ts',
        'tests/nested/another.test.ts',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('discovers all VS Code Bun tests instead of one hardcoded quota file', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'devryan-vscode-tests-'));
    try {
      mkdirSync(path.join(root, 'tests/quota'), { recursive: true });
      writeFileSync(path.join(root, 'tests/quotaProviders.test.ts'), '');
      writeFileSync(path.join(root, 'tests/quota/additional.test.ts'), '');

      assert.deepEqual(discoverVscodeBunTestFiles(root), [
        'tests/quota/additional.test.ts',
        'tests/quotaProviders.test.ts',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('release workflow', () => {
  test('includes the Cursor runtime package in the full test gate', () => {
    const packageJson = JSON.parse(readFileSync(new URL('package.json', repoRoot), 'utf8'));

    assert.match(
      packageJson.scripts['test:full'],
      /bun test packages\/cursor-sdk-runtime/,
    );
  });

  test('includes the managed orchestration runtime package in the full test gate', () => {
    const packageJson = JSON.parse(readFileSync(new URL('package.json', repoRoot), 'utf8'));

    assert.match(
      packageJson.scripts['test:full'],
      /bun test packages\/orchestration-runtime/,
    );
  });

  test('includes the Electron package suite in the full test gate', () => {
    const packageJson = JSON.parse(readFileSync(new URL('package.json', repoRoot), 'utf8'));

    assert.match(
      packageJson.scripts['test:full'],
      /bun run --cwd packages\/electron test/,
    );
  });

  test('installs Electron macOS optional dependencies for runner and package target architectures', () => {
    const workflow = readFileSync(new URL('.github/workflows/release.yml', repoRoot), 'utf8');
    const electronJobMatch = workflow.match(/  build-desktop-electron-macos:\n(?<job>[\s\S]*?)(?:\n  [a-zA-Z0-9_-]+:\n|\n$)/);
    assert.ok(electronJobMatch?.groups?.job, 'build-desktop-electron-macos job not found');

    const installStepMatch = electronJobMatch.groups.job.match(/      - name: Install dependencies\n(?<step>[\s\S]*?)(?:\n      - name: |\n    [a-zA-Z0-9_-]+:|\n$)/);
    assert.ok(installStepMatch?.groups?.step, 'Electron install dependencies step not found');

    assert.match(installStepMatch.groups.step, /bun install --frozen-lockfile --cpu '\*' --os darwin/);
  });
});
