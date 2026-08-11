import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { FEATURE_TEST_MATRIX } from './feature-test-matrix.mjs';
import { discoverElectronTestFiles } from './test-electron.mjs';
import { discoverScriptTestFiles } from './test-scripts.mjs';
import { discoverTestFiles } from './test-runner-utils.mjs';
import { discoverUiTestFiles } from './test-ui.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('full test-suite contract', () => {
  test('discovers every repository script test, including release verification', () => {
    const files = discoverScriptTestFiles(repositoryRoot);
    assert.ok(files.includes('scripts/verify-release-assets.test.mjs'));
    assert.ok(files.includes('scripts/test-suite-contract.test.mjs'));
    assert.ok(files.includes('.opencode/agents/design-routing.test.mjs'));
    assert.deepEqual(files, [...files].sort());
  });

  test('discovers Electron tests recursively', () => {
    const files = discoverElectronTestFiles(path.join(repositoryRoot, 'packages/electron'));
    assert.ok(files.includes('startup-splash.test.mjs'));
    assert.ok(files.includes('scripts/rebuild-native.test.mjs'));
    assert.ok(files.includes('tests/browser-cdp-bridge.test.mjs'));
    assert.deepEqual(files, [...files].sort());
  });

  test('includes every test-owning workspace package in the full gate', () => {
    const rootPackage = JSON.parse(readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));
    const fullCommand = rootPackage.scripts['test:full'];
    const packageDirectories = readdirSync(path.join(repositoryRoot, 'packages'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    const testPackages = packageDirectories.filter((name) => {
      const manifestPath = path.join(repositoryRoot, 'packages', name, 'package.json');
      if (!existsSync(manifestPath)) return false;
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      return typeof manifest.scripts?.test === 'string';
    });

    for (const packageName of testPackages) {
      assert.match(
        fullCommand,
        new RegExp(`bun run --cwd packages/${packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} test`),
        `${packageName} is not included in test:full`,
      );
    }
  });

  test('accounts for every deterministic JavaScript and TypeScript test file', () => {
    const ignoredDirectories = new Set([
      '.git',
      '.cache',
      '.worktrees',
      'node_modules',
      'dist',
      'dist-bundle',
      'target',
      'resources',
    ]);
    const allTests = discoverTestFiles(repositoryRoot, repositoryRoot, { ignoredDirectories });
    const fullGateRoots = [
      '.opencode/agents/',
      '.opencode/plugins/',
      'scripts/',
      'packages/cursor-sdk-runtime/',
      'packages/electron/',
      'packages/harness-runtime/',
      'packages/orchestration-runtime/',
      'packages/ui/',
      'packages/vscode/',
      'packages/web/',
    ];
    const uncovered = allTests.filter((file) => !fullGateRoots.some((root) => file.startsWith(root)));
    assert.deepEqual(uncovered, []);

    const scriptTests = new Set(discoverScriptTestFiles(repositoryRoot));
    const electronTests = new Set(
      discoverElectronTestFiles(path.join(repositoryRoot, 'packages/electron'))
        .map((file) => `packages/electron/${file}`),
    );
    const uiTests = new Set(
      discoverUiTestFiles(path.join(repositoryRoot, 'packages/ui'))
        .map((file) => `packages/ui/${file}`),
    );
    for (const file of allTests) {
      if (file.startsWith('.opencode/agents/')) assert.equal(scriptTests.has(file), true, `undiscovered: ${file}`);
      if (file.startsWith('.opencode/plugins/')) assert.equal(scriptTests.has(file), true, `undiscovered: ${file}`);
      if (file.startsWith('scripts/')) assert.equal(scriptTests.has(file), true, `undiscovered: ${file}`);
      if (file.startsWith('packages/electron/')) assert.equal(electronTests.has(file), true, `undiscovered: ${file}`);
      if (file.startsWith('packages/ui/')) assert.equal(uiTests.has(file), true, `undiscovered: ${file}`);
    }
  });

  test('contains no silent skip or todo declarations in deterministic tests', () => {
    const files = discoverTestFiles(repositoryRoot, repositoryRoot, {
      ignoredDirectories: new Set(['.git', '.cache', '.worktrees', 'node_modules', 'dist', 'dist-bundle', 'target', 'resources']),
    }).filter((file) => file !== 'scripts/test-suite-contract.test.mjs');
    const forbidden = new RegExp(String.raw`\b(?:test|it|describe)\.(?:skip|todo)\s*\(|\bskip\s*:`);
    const offenders = files.filter((file) => forbidden.test(readFileSync(path.join(repositoryRoot, file), 'utf8')));
    assert.deepEqual(offenders, []);
  });
});

describe('feature-to-test matrix', () => {
  test('has unique feature ids and live source/test anchors', () => {
    const ids = FEATURE_TEST_MATRIX.map((entry) => entry.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ids.length >= 15);

    for (const entry of FEATURE_TEST_MATRIX) {
      assert.ok(entry.sourcePaths.length > 0, `${entry.id} has no source paths`);
      assert.ok(entry.testPaths.length > 0, `${entry.id} has no test paths`);
      for (const relativePath of [...entry.sourcePaths, ...entry.testPaths]) {
        assert.equal(existsSync(path.join(repositoryRoot, relativePath)), true, `${entry.id}: missing ${relativePath}`);
      }
    }
  });
});
