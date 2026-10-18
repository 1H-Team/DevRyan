import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyExceptions, checkImportBoundaries, findViolations, loadPackages, readExceptions, resolveSpecifier } from './check-import-boundaries.mjs';

const roots = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

function fixture(files) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'devryan-import-boundaries-'));
  roots.push(root);
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), typeof content === 'string' ? content : `${JSON.stringify(content)}\n`);
  }
  return root;
}

const base = {
  'packages/web/package.json': { name: '@openchamber/web', main: './server/index.js' },
  'packages/web/server/index.js': 'export const host = 1;\n',
  'packages/web/server/private.js': 'export const secret = 1;\n',
  'packages/shared/package.json': { name: '@openchamber/shared', main: './index.js',
    exports: { '.': './index.js', './lib/portable.js': { types: './lib/portable.d.ts', default: './lib/portable.js' } } },
  'packages/shared/index.js': 'export * from "./lib/portable.js";\n',
  'packages/shared/lib/portable.js': 'export const value = 1;\n',
  'packages/shared/lib/node-only.js': 'import fs from "node:fs"; export const read = fs.readFileSync;\n',
  'packages/library/package.json': { name: '@openchamber/library', main: './index.js' },
  'packages/library/index.js': 'export const x = 1;\n',
  'packages/library/lib/deep.js': 'export const y = 1;\n',
  'packages/electron/package.json': { name: '@openchamber/electron' },
};

test('static, re-export, require and literal dynamic imports of private application files fail', () => {
  const root = fixture({ ...base,
    'packages/electron/static.mjs': "import { secret } from '@openchamber/web/server/private.js';\n",
    'packages/electron/reexport.mjs': "export { secret } from '../web/server/private.js';\n",
    'packages/electron/require.cjs': "const { secret } = require('../web/server/private');\n",
    'packages/electron/dynamic.mjs': "export const load = () => import('@openchamber/web/server/private.js');\n",
    'packages/electron/allowed.mjs': "import { host } from '@openchamber/web';\nimport { host as again } from '../web/server/index.js';\n",
  });
  const files = ['static.mjs', 'reexport.mjs', 'require.cjs', 'dynamic.mjs', 'allowed.mjs'].map(file => `packages/electron/${file}`);
  const violations = findViolations({ root, files });
  assert.deepEqual(violations.map(violation => [violation.importer, violation.target, violation.rule]), files.slice(0, 4).map(importer =>
    [importer, 'packages/web/server/private.js', 'private-application-import']));
});

test('declared exports bind both package-name and relative imports; packages without exports stay open', () => {
  const root = fixture({ ...base,
    'packages/electron/a.mjs': [
      "import { value } from '@openchamber/shared/lib/portable.js';",
      "import { read } from '@openchamber/shared/lib/node-only.js';",
      "import { read as again } from '../shared/lib/node-only.js';",
      "import { y } from '@openchamber/library/lib/deep.js';",
      "import { y as deep } from '../library/lib/deep.js';",
    ].join('\n'),
  });
  const violations = findViolations({ root, files: ['packages/electron/a.mjs'] });
  assert.deepEqual(violations.map(violation => [violation.specifier, violation.rule]), [
    ['@openchamber/shared/lib/node-only.js', 'unexported-subpath'],
    ['../shared/lib/node-only.js', 'unexported-subpath'],
  ]);
  const packages = loadPackages(root);
  assert.equal(resolveSpecifier({ root, packages, importer: 'packages/electron/a.mjs', specifier: '@openchamber/shared' }).target, 'packages/shared/index.js');
  assert.equal(resolveSpecifier({ root, packages, importer: 'packages/electron/a.mjs', specifier: 'react' }), null);
});

test('exceptions are exact pairs with a stage, and unused ones fail as stale', () => {
  const exceptionFile = exceptions => ({ 'scripts/import-boundaries.json': { schemaVersion: 1, description: 'fixture', exceptions } });
  const files = { ...base, 'packages/electron/a.mjs': "import '../web/server/private.js';\n", 'packages/electron/b.mjs': 'export {};\n' };
  const listed = { importer: 'packages/electron/a.mjs', target: 'packages/web/server/private.js', stage: '4a' };
  const passing = checkImportBoundaries({ root: fixture({ ...files, ...exceptionFile([listed]) }), files: ['packages/electron/a.mjs', 'packages/electron/b.mjs'] });
  assert.deepEqual([passing.unexpected, passing.stale], [[], []]);
  const unlisted = checkImportBoundaries({ root: fixture({ ...files, ...exceptionFile([]) }), files: ['packages/electron/a.mjs'] });
  assert.equal(unlisted.unexpected.length, 1);
  const stale = { importer: 'packages/electron/b.mjs', target: 'packages/web/server/private.js', stage: '5' };
  const staleResult = checkImportBoundaries({ root: fixture({ ...files, ...exceptionFile([listed, stale]) }), files: ['packages/electron/a.mjs', 'packages/electron/b.mjs'] });
  assert.deepEqual(staleResult.stale, [stale]);
  const scoped = checkImportBoundaries({ root: fixture({ ...files, ...exceptionFile([listed, stale]) }), files: ['packages/electron/a.mjs'] });
  assert.deepEqual(scoped.stale, [], 'changed-file runs only judge exceptions of checked importers');
  const deleted = checkImportBoundaries({ root: fixture({ ...files, ...exceptionFile([listed, { ...stale, importer: 'packages/electron/gone.mjs' }]) }),
    files: ['packages/electron/a.mjs', 'packages/electron/gone.mjs'] });
  assert.equal(deleted.stale.length, 1, 'an exception for a deleted importer is stale');
  assert.deepEqual(applyExceptions([], [listed], null).stale, [listed], 'a full run judges every exception');
  for (const invalid of [[{ ...listed, stage: 'later' }], [listed, listed], [{ importer: listed.importer, target: listed.target }]]) {
    assert.throws(() => readExceptions(fixture(exceptionFile(invalid))), /exception/);
  }
});

test('the repository has no unlisted private imports and no stale exceptions', () => {
  const result = checkImportBoundaries();
  assert.deepEqual(result.unexpected, []);
  assert.deepEqual(result.stale, []);
});
