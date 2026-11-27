import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { codeEnvTokens, documentEnvTokens, envTokenKnown, validateEnvTokens } from './env-tokens.mjs';

function fixture(t, files) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'devryan-docs-env-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [file, contents] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), contents);
  }
  execFileSync('git', ['init', '-q'], { cwd: root });
  return root;
}

test('extracts whole tokens and prefixes, not embedded ones', () => {
  assert.deepEqual(documentEnvTokens('`DEVRYAN_FIXTURE_A=1` and DEVRYAN_FIXTURE_A again, `DEVRYAN_FIXTURE_*`, VITE_DEVRYAN_FIXTURE_B, __OPENCHAMBER_FIXTURE_C__, OPENCODE_FIXTURE_D.'),
    ['DEVRYAN_FIXTURE_A', 'DEVRYAN_FIXTURE_', 'OPENCODE_FIXTURE_D']);
});

test('reads the corpus from non-Markdown files outside scripts/docs, tests and fixtures, including untracked ones', t => {
  const root = fixture(t, {
    'src/a.js': 'env.DEVRYAN_FIXTURE_READ; `${"VITE_DEVRYAN_FIXTURE_VITE"}`; const p = "DEVRYAN_FIXTURE_PREFIX_" + name;',
    'docs/a.md': 'DEVRYAN_FIXTURE_DOC_ONLY',
    'scripts/docs/known-drift.json': '"DEVRYAN_FIXTURE_BASELINE_ONLY"',
    'scripts/docs/env-tokens.test.mjs': 'DEVRYAN_FIXTURE_VALIDATOR_TEST_ONLY',
    'src/a.test.js': 'process.env.DEVRYAN_FIXTURE_UNIT_TEST_ONLY',
    'src/b.test.ts': 'process.env.DEVRYAN_FIXTURE_TS_TEST_ONLY',
    'tests/e2e/run.mjs': 'process.env.DEVRYAN_FIXTURE_TESTS_TREE_ONLY',
    'packages/x/fixtures/env.json': '"DEVRYAN_FIXTURE_FIXTURE_ONLY"',
    'packages/x/src/tests/helper.js': 'process.env.DEVRYAN_FIXTURE_NESTED_TESTS_DIR',
  });
  // Only the top-level tests/ tree is excluded; a nested `tests` directory is product code's own helper.
  assert.deepEqual([...codeEnvTokens(root)].sort(), ['DEVRYAN_FIXTURE_NESTED_TESTS_DIR', 'DEVRYAN_FIXTURE_PREFIX_', 'DEVRYAN_FIXTURE_READ', 'DEVRYAN_FIXTURE_VITE']);
});

test('a variable named only in a test file is reported as dead', t => {
  const root = fixture(t, {
    'src/a.js': 'process.env.DEVRYAN_FIXTURE_READ',
    'src/a.test.js': 'process.env.DEVRYAN_FIXTURE_SET_BY_TEST = "1"',
    'docs/a.md': '`DEVRYAN_FIXTURE_READ` and `DEVRYAN_FIXTURE_SET_BY_TEST`',
  });
  assert.deepEqual(validateEnvTokens(root, ['docs/a.md']), [{ check: 'env', doc: 'docs/a.md', token: 'DEVRYAN_FIXTURE_SET_BY_TEST' }]);
});

test('accepts exact tokens, used prefixes, legacy aliases of DevRyan names and the explicit allowlists', () => {
  const code = new Set(['DEVRYAN_FIXTURE_READ', 'DEVRYAN_FIXTURE_TUNNEL_MODE', 'OPENCODE_FIXTURE_PORT']);
  const options = {
    allowedPrefixes: new Map([['DEVRYAN_FIXTURE_COMPOSED_', 'composed at runtime']]),
    opencodeOwned: new Map([['OPENCODE_FIXTURE_OWNED', 'read by OpenCode']]),
    testOnly: new Map([['DEVRYAN_FIXTURE_BENCH', 'read by a benchmark test']]),
  };
  const known = (token) => envTokenKnown(token, code, options);
  assert.ok(known('DEVRYAN_FIXTURE_READ'));
  assert.ok(known('DEVRYAN_FIXTURE_TUNNEL_'));
  assert.ok(known('OPENCHAMBER_FIXTURE_READ'));
  assert.ok(known('DEVRYAN_FIXTURE_COMPOSED_ANY'));
  assert.ok(known('DEVRYAN_FIXTURE_COMPOSED_'));
  assert.ok(known('OPENCODE_FIXTURE_OWNED'));
  assert.ok(known('DEVRYAN_FIXTURE_BENCH'));
  assert.ok(!known('DEVRYAN_FIXTURE_REA'));
  assert.ok(!known('DEVRYAN_FIXTURE_GONE'));
  assert.ok(!known('DEVRYAN_FIXTURE_NONE_'));
  assert.ok(!known('OPENCHAMBER_FIXTURE_GONE'));
  assert.ok(!known('OPENCODE_FIXTURE_HOST'));
});

test('reports each dead token once per document', t => {
  const root = fixture(t, {
    'src/a.js': 'process.env.DEVRYAN_FIXTURE_READ',
    'docs/a.md': 'DEVRYAN_FIXTURE_READ DEVRYAN_FIXTURE_DEAD\n```sh\nDEVRYAN_FIXTURE_DEAD=1 run\n```',
  });
  assert.deepEqual(validateEnvTokens(root, ['docs/a.md']), [{ check: 'env', doc: 'docs/a.md', token: 'DEVRYAN_FIXTURE_DEAD' }]);
});
