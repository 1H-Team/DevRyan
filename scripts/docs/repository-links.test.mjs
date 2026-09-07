import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { documentReferences, validateRepositoryLinks } from './repository-links.mjs';

function fixture(t, files) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'devryan-docs-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [file, contents] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), contents);
  }
  return root;
}

test('finds linked files, reference definitions and explicit source paths outside code examples', () => {
  assert.deepEqual(documentReferences('[a](guide(a).md#x) [b](<a b.md>)\n[ref]: file.md "title"\n`packages/ui/src/main.tsx`\n```md\n[x](fake.md)\n```\n<!-- [x](ignored.md) -->').map(r => r.target),
    ['packages/ui/src/main.tsx', 'guide(a).md#x', 'a b.md', 'file.md']);
});

test('resolves relative, encoded and root paths, while leaving remote links alone', t => {
  const root = fixture(t, { 'docs/a.md': '[a](../README.md#start) [b](a%20b.md) [c](/README.md) [d](https://example.com) [e](#local)', 'README.md': '', 'docs/a b.md': '' });
  assert.deepEqual(validateRepositoryLinks(root, ['docs/a.md']), { checked: 3, errors: [], warnings: [] });
});

test('reports missing current links and source paths with deterministic file context', t => {
  const root = fixture(t, { 'docs/a.md': '[a](gone.md) `packages/ui/gone.ts`' });
  const result = validateRepositoryLinks(root, ['docs/a.md']);
  assert.equal(result.errors.length, 2);
  assert.ok(result.errors.some(e => e.includes('docs/a.md: missing source: packages/ui/gone.ts')));
});

test('reports historical and generated references without treating them as current passes', t => {
  const root = fixture(t, { 'docs/audits/past.md': '[a](gone.md)', 'README.md': '[built](packages/web/dist/index.html)' });
  const result = validateRepositoryLinks(root, ['docs/audits/past.md', 'README.md']);
  assert.equal(result.errors.length, 0);
  assert.equal(result.warnings.length, 2);
});

test('checks site routes and rejects repository escapes and malformed encoding', t => {
  const root = fixture(t, { 'packages/docs/content/docs/index.mdx': '[a](/guide/) [b](/gone/)', 'README.md': '[escape](../outside.md) [bad](%ZZ.md)' });
  const result = validateRepositoryLinks(root, ['packages/docs/content/docs/index.mdx', 'README.md'], { siteRoutes: new Set(['/guide/']) });
  assert.equal(result.errors.length, 3);
  assert.match(result.errors.join('\n'), /missing documentation route/);
  assert.match(result.errors.join('\n'), /reference leaves repository/);
  assert.match(result.errors.join('\n'), /invalid URL encoding/);
});
