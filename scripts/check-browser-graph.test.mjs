import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { walkBrowserGraph } from './check-browser-graph.mjs';

const roots = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

function fixture(files) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'devryan-browser-graph-'));
  roots.push(root);
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), typeof content === 'string' ? content : `${JSON.stringify(content)}\n`);
  }
  return root;
}

const packages = {
  'packages/web/package.json': { name: '@openchamber/web', main: './server/index.js' },
  'packages/ui/package.json': { name: '@openchamber/ui', main: 'src/main.tsx' },
  'packages/shared-runtime/package.json': { name: '@openchamber/shared-runtime', main: './index.js',
    exports: { '.': './index.js', './lib/portable.js': './lib/portable.js', './node/safe-archive.js': './lib/safe-archive.js' } },
  'packages/shared-runtime/lib/portable.js': 'export const value = 1;\n',
  'packages/shared-runtime/lib/safe-archive.js': 'export const extract = 1;\n',
  'packages/web/server/private.js': 'export const secret = 1;\n',
};

test('a portable graph through aliases, lazy chunks and workers passes', () => {
  const root = fixture({ ...packages,
    'packages/web/src/main.tsx': "import '@/app';\nimport '@web/shell';\nconst lazy = () => import('@openchamber/ui/lazy');\nnew Worker(new URL('./worker.ts', import.meta.url));\n",
    'packages/web/src/shell.ts': "import React from 'react';\nexport default React;\n",
    'packages/web/src/worker.ts': 'export {};\n',
    'packages/ui/src/app.tsx': "import { value } from '@openchamber/shared-runtime/lib/portable.js';\nexport default value;\n",
    'packages/ui/src/lazy.ts': 'export {};\n',
  });
  const result = walkBrowserGraph({ root, entries: ['packages/web/src/main.tsx'] });
  assert.deepEqual(result.violations, []);
  assert.equal(result.files, 6);
});

test('Node builtins, adm-zip and privileged implementations anywhere in the graph fail', () => {
  const root = fixture({ ...packages,
    'packages/web/src/main.tsx': "import '@/a';\nimport '@/b';\nimport '@/c';\nimport '@/d';\n",
    'packages/ui/src/a.ts': "import fs from 'node:fs';\nimport path from 'path';\n",
    'packages/ui/src/b.ts': "import AdmZip from 'adm-zip';\n",
    'packages/ui/src/c.ts': "export const load = () => import('../../web/server/private.js');\n",
    'packages/ui/src/d.ts': "import { extract } from '@openchamber/shared-runtime/node/safe-archive.js';\n",
  });
  const { violations } = walkBrowserGraph({ root, entries: ['packages/web/src/main.tsx'] });
  assert.deepEqual(violations.map(violation => [violation.importer, violation.target, violation.reason]).sort(), [
    ['packages/ui/src/a.ts', 'node:fs', 'Node builtin'],
    ['packages/ui/src/a.ts', 'path', 'Node builtin'],
    ['packages/ui/src/b.ts', 'adm-zip', 'Node-only package'],
    ['packages/ui/src/c.ts', 'packages/web/server/private.js', 'privileged implementation'],
    ['packages/ui/src/d.ts', 'packages/shared-runtime/lib/safe-archive.js', 'privileged implementation'],
  ]);
});

test('the real web entry points, startup diagnostics and UI test fixtures stay portable', () => {
  const result = walkBrowserGraph();
  assert.deepEqual(result.violations, []);
  assert.ok(result.files > 500, `walked only ${result.files} files`);
});
