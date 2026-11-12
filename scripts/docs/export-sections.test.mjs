import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { exportSections, headingSourceFiles, validateExportSections } from './export-sections.mjs';

function fixture(t, files) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'devryan-docs-exports-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [file, contents] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), contents);
  }
  return root;
}

test('recognizes headings that end with a source file list', () => {
  assert.deepEqual(headingSourceFiles('Public exports (env-runtime.js)'), ['env-runtime.js']);
  assert.deepEqual(headingSourceFiles('Helpers (`install.js`, `scan.js`)'), ['install.js', 'scan.js']);
  assert.deepEqual(headingSourceFiles('Shared (re-exported from ../text/summarization.js)'), ['../text/summarization.js']);
  assert.equal(headingSourceFiles('State (`.slim/worktrees.json`)'), null);
  assert.equal(headingSourceFiles('Public exports'), null);
});

test('collects call-shaped names until the next heading, ignoring code blocks', () => {
  const sections = exportSections('## Public exports (a.js)\n- `one(x)`, `two()` and `notCalled`\n```js\n`fenced(`\n```\n## Other\n- `outside()`');
  assert.deepEqual(sections, [{ files: ['a.js'], names: ['one', 'two'] }]);
});

test('reports names absent from the named files and missing files with names to check', t => {
  const root = fixture(t, {
    'lib/DOCUMENTATION.md': [
      '## Public exports (a.js)', '- `kept()`', '- `removed()`', '- `keptLonger()` is not `kept` twice',
      '### Helpers (`a.js`, `b.js`)', '- `fromB()`',
      '## Public exports (gone.js)', '- `anything()`',
      '## Notes (gone-too.js)', 'No names here.',
    ].join('\n'),
    'lib/a.js': 'export function kept() {}\nexport const keptLongerName = 1;',
    'lib/b.js': 'export const fromB = () => {};',
  });
  assert.deepEqual(validateExportSections(root, ['lib/DOCUMENTATION.md']).map((violation) => violation.token), [
    'a.js: removed',
    'a.js: keptLonger',
    'gone.js: (missing file)',
  ]);
});
