import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';

import { discoverTestFiles, isIsolatedUiTestSource } from './test-runner-utils.mjs';
import { discoverElectronTestFiles } from './test-electron.mjs';
import { discoverScriptTestFiles } from './test-scripts.mjs';
import { discoverVscodeBunTestFiles } from './test-vscode.mjs';
import { buildPlan } from './validate.mjs';

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

  test('discovers repository script tests recursively', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'devryan-script-tests-'));
    try {
      mkdirSync(path.join(root, 'scripts/nested'), { recursive: true });
      mkdirSync(path.join(root, '.opencode/plugins/nested'), { recursive: true });
      writeFileSync(path.join(root, 'scripts/top.test.mjs'), '');
      writeFileSync(path.join(root, 'scripts/nested/release.test.mjs'), '');
      writeFileSync(path.join(root, 'scripts/nested/helper.mjs'), '');
      writeFileSync(path.join(root, '.opencode/plugins/nested/project.test.mjs'), '');

      assert.deepEqual(discoverScriptTestFiles(root), [
        '.opencode/plugins/nested/project.test.mjs',
        'scripts/nested/release.test.mjs',
        'scripts/top.test.mjs',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('discovers Electron tests recursively while excluding packaged output', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'devryan-electron-tests-'));
    try {
      mkdirSync(path.join(root, 'tests/nested'), { recursive: true });
      mkdirSync(path.join(root, 'dist'), { recursive: true });
      writeFileSync(path.join(root, 'startup.test.mjs'), '');
      writeFileSync(path.join(root, 'tests/nested/browser.test.mjs'), '');
      writeFileSync(path.join(root, 'dist/packaged.test.mjs'), '');

      assert.deepEqual(discoverElectronTestFiles(root), [
        'startup.test.mjs',
        'tests/nested/browser.test.mjs',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('release workflow', () => {
  test('includes the Bots runtime package in the full test gate and version script', () => {
    const packageJson = JSON.parse(readFileSync(new URL('package.json', repoRoot), 'utf8'));
    const bumpVersionSource = readFileSync(new URL('scripts/bump-version.mjs', repoRoot), 'utf8');

    assert.match(
      packageJson.scripts['test:full'],
      /bun run --cwd packages\/bots-runtime test/,
    );
    assert.match(bumpVersionSource, /packages\/bots-runtime\/package\.json/);
  });

  test('versions and runs the confined Bot service packages', () => {
    const packageJson = JSON.parse(readFileSync(new URL('package.json', repoRoot), 'utf8'));
    const bumpVersionSource = readFileSync(new URL('scripts/bump-version.mjs', repoRoot), 'utf8');
    for (const packageName of [
      'bot-supervisor', 'bot-engine-proxy', 'bot-egress', 'bot-computer', 'bot-indexer',
    ]) {
      assert.match(
        packageJson.scripts['test:full'],
        new RegExp(`bun run --cwd packages/${packageName} test`),
      );
      assert.match(bumpVersionSource, new RegExp(`packages/${packageName}/package\\.json`));
    }
  });

  test('includes the Cursor runtime package in the full test gate', () => {
    const packageJson = JSON.parse(readFileSync(new URL('package.json', repoRoot), 'utf8'));

    assert.match(
      packageJson.scripts['test:full'],
      /bun run --cwd packages\/cursor-sdk-runtime test/,
    );
  });

  test('includes the managed orchestration runtime package in the full test gate', () => {
    const packageJson = JSON.parse(readFileSync(new URL('package.json', repoRoot), 'utf8'));

    assert.match(
      packageJson.scripts['test:full'],
      /bun run --cwd packages\/orchestration-runtime test/,
    );
  });

  test('includes the Electron package suite in the full test gate', () => {
    const packageJson = JSON.parse(readFileSync(new URL('package.json', repoRoot), 'utf8'));

    assert.match(
      packageJson.scripts['test:full'],
      /bun run --cwd packages\/electron test/,
    );
  });

  test('includes the legacy Tauri package suite in the full test gate', () => {
    const packageJson = JSON.parse(readFileSync(new URL('package.json', repoRoot), 'utf8'));

    assert.match(
      packageJson.scripts['test:full'],
      /bun run --cwd packages\/desktop test/,
    );
  });

  test('deploys and verifies Supabase Auth configuration and pending migrations at the final publish boundary', () => {
    const workflow = readFileSync(new URL('.github/workflows/release.yml', repoRoot), 'utf8');
    const finalizeReleaseJobMatch = workflow.match(/  finalize-release:\n(?<job>[\s\S]*?)(?:\n  [a-zA-Z0-9_-]+:\n|\n$)/);
    assert.ok(finalizeReleaseJobMatch?.groups?.job, 'finalize-release job not found');

    const job = finalizeReleaseJobMatch.groups.job;
    const assetStep = job.indexOf('- name: Verify required release assets before publish');
    const migrationStep = job.indexOf('- name: Deploy and verify Supabase configuration and migrations');
    const releaseStep = job.indexOf('- name: Publish release');

    assert.notEqual(migrationStep, -1, 'database migration release step not found');
    assert.ok(assetStep < migrationStep, 'database migrations must run after release asset verification');
    assert.ok(migrationStep < releaseStep, 'database migrations must run immediately before release publication');
    assert.match(job, /uses: supabase\/setup-cli@v1/);
    assert.match(job, /version: 2\.115\.0/);
    assert.match(job, /if: \$\{\{ github\.event\.inputs\.dry_run != 'true' \}\}/);
    assert.match(job, /SUPABASE_ACCESS_TOKEN: \$\{\{ secrets\.SUPABASE_ACCESS_TOKEN \}\}/);
    assert.match(job, /SUPABASE_DB_PASSWORD: \$\{\{ secrets\.SUPABASE_DB_PASSWORD \}\}/);
    assert.match(job, /SUPABASE_PROJECT_ID: \$\{\{ secrets\.SUPABASE_PROJECT_ID \}\}/);
    assert.match(job, /supabase link --project-ref "\$SUPABASE_PROJECT_ID" --yes/);
    assert.match(job, /node scripts\/sync-supabase-auth-password-policy\.mjs/);
    assert.match(job, /supabase db push --linked --dry-run/);
    assert.match(job, /supabase db push --linked --yes/);
    assert.match(job, /supabase migration list --linked --output-format json/);
    assert.match(job, /supabase db query --linked --agent=no --output json/);
    assert.match(job, /const schemaRows = Array\.isArray\(schema\) \? schema : schema\.rows/);
    assert.match(job, /entry\.local !== entry\.remote/);
    assert.match(job, /actual !== expected/);
    assert.ok(
      job.indexOf('node scripts/sync-supabase-auth-password-policy.mjs')
        > job.indexOf('supabase link --project-ref "$SUPABASE_PROJECT_ID" --yes'),
      'Auth configuration must sync after the hosted project is linked',
    );
    assert.ok(
      job.indexOf('node scripts/sync-supabase-auth-password-policy.mjs')
        < job.indexOf('supabase db push --linked --dry-run'),
      'Auth configuration must sync before database migrations',
    );
    assert.doesNotMatch(
      workflow.match(/  create-release:\n(?<job>[\s\S]*?)(?:\n  [a-zA-Z0-9_-]+:\n|\n$)/)?.groups?.job || '',
      /supabase db push/,
    );
  });

  test('keeps every pre-final GitHub Release upload in draft state', () => {
    const workflow = readFileSync(new URL('.github/workflows/release.yml', repoRoot), 'utf8');
    const finalPublish = workflow.indexOf('- name: Publish release');
    assert.notEqual(finalPublish, -1, 'final release publication step not found');

    const preFinalWorkflow = workflow.slice(0, finalPublish);
    for (const stepName of [
      'Create GitHub Release',
      'Upload npm tarball to release',
      'Upload Bot runtime manifest to release',
      'Upload DMG / ZIP / blockmaps to release',
      'Upload combined latest-mac.yml to release',
    ]) {
      const step = preFinalWorkflow.match(new RegExp(
        `- name: ${stepName.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\n(?<body>[\\s\\S]*?)(?:\\n      - name: |$)`,
      ));
      assert.ok(step?.groups?.body, `${stepName} step not found`);
      assert.match(step.groups.body, /draft: true/, `${stepName} must preserve the draft release`);
    }
  });

  test('installs Electron macOS optional dependencies for runner and package target architectures', () => {
    const workflow = readFileSync(new URL('.github/workflows/release.yml', repoRoot), 'utf8');
    const electronJobMatch = workflow.match(/  build-desktop-electron-macos:\n(?<job>[\s\S]*?)(?:\n  [a-zA-Z0-9_-]+:\n|\n$)/);
    assert.ok(electronJobMatch?.groups?.job, 'build-desktop-electron-macos job not found');

    const installStepMatch = electronJobMatch.groups.job.match(/      - name: Install dependencies\n(?<step>[\s\S]*?)(?:\n      - name: |\n    [a-zA-Z0-9_-]+:|\n$)/);
    assert.ok(installStepMatch?.groups?.step, 'Electron install dependencies step not found');

    assert.match(installStepMatch.groups.step, /bun install --frozen-lockfile --cpu '\*' --os darwin/);
  });

  test('keeps Electron macOS releases permanently unsigned', () => {
    const workflow = readFileSync(new URL('.github/workflows/release.yml', repoRoot), 'utf8');
    const electronJobMatch = workflow.match(/  build-desktop-electron-macos:\n(?<job>[\s\S]*?)(?:\n  [a-zA-Z0-9_-]+:\n|\n$)/);
    assert.ok(electronJobMatch?.groups?.job, 'build-desktop-electron-macos job not found');

    const job = electronJobMatch.groups.job;
    assert.match(job, /CSC_IDENTITY_AUTO_DISCOVERY: 'false'/);
    assert.match(job, /-c\.mac\.identity=null -c\.mac\.notarize=false -c\.dmg\.sign=false/);
    assert.doesNotMatch(job, /--require-developer-id/);
    assert.doesNotMatch(job, /Install Apple Certificate/);
    assert.doesNotMatch(job, /secrets\.APPLE_/);
    assert.doesNotMatch(job, /Verify signature \+ entitlements \+ notarization/);
  });
});

describe('Bots affected validation planning', () => {
  test('runs Bots plus web, Electron, and UI dependents for core changes', () => {
    const plan = buildPlan('affected', [
      'packages/bots-runtime/run-state.js',
    ]);

    assert.deepEqual(plan.commands.map((entry) => entry.label), [
      'typeCheck:electron',
      'typeCheck:ui',
      'typeCheck:web',
      'test:bots',
      'test:electron',
      'test:ui',
      'test:web',
    ]);
  });

  test('still runs the Bots package suite in quick mode', () => {
    const plan = buildPlan('quick', [
      'packages/bots-runtime/policy.js',
    ]);

    assert.deepEqual(plan.commands.map((entry) => entry.label), ['test:bots']);
  });

  test('runs confined service suites and the Electron host for affected changes', () => {
    const plan = buildPlan('affected', [
      'packages/bot-supervisor/src/docker.js',
      'packages/bot-engine-proxy/src/server.js',
      'packages/bot-egress/src/connect-policy.js',
      'packages/bot-computer/src/browser.js',
      'packages/bot-indexer/src/index-store.js',
    ]);

    assert.deepEqual(plan.commands.map((entry) => entry.label), [
      'test:botComputer',
      'test:botEgress',
      'test:botEngineProxy',
      'test:botIndexer',
      'test:botSupervisor',
      'test:electron',
    ]);
  });

  test('keeps each confined service suite in quick mode', () => {
    const plan = buildPlan('quick', [
      'packages/bot-supervisor/src/server.js',
      'packages/bot-engine-proxy/src/server.js',
      'packages/bot-egress/src/server.js',
      'packages/bot-computer/src/server.js',
      'packages/bot-indexer/src/server.js',
    ]);

    assert.deepEqual(plan.commands.map((entry) => entry.label), [
      'test:botComputer',
      'test:botEgress',
      'test:botEngineProxy',
      'test:botIndexer',
      'test:botSupervisor',
    ]);
  });
});
