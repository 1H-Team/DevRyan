import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { githubSlug, headingAnchors, headingText, validateHeadingAnchors } from './heading-anchors.mjs';

function fixture(t, files) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'devryan-docs-anchors-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [file, contents] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), contents);
  }
  return root;
}

test('slugs follow GitHub: lower case, punctuation dropped, spaces to hyphens, underscores and unicode kept', () => {
  assert.equal(githubSlug('Data folder migration'), 'data-folder-migration');
  assert.equal(githubSlug('Seams in 2.2.5 → 2.2.6'), 'seams-in-225--226');
  assert.equal(githubSlug('`DEVRYAN_*` names (canonical)'), 'devryan_-names-canonical');
  assert.equal(githubSlug('Café über'), 'café-über');
});

test('collects ATX headings with inline markup, numbers repeats, and skips code blocks', () => {
  const anchors = headingAnchors([
    '# Title', '## Public exports (`env-runtime.js`)', '## [Linked](x.md) *emphasis*', '## Repeat', '### Repeat ##',
    '```md', '## Not a heading', '```', '<a id="custom"></a>', '<!-- ## Commented -->',
  ].join('\n'));
  assert.deepEqual([...anchors].sort(), ['custom', 'linked-emphasis', 'public-exports-env-runtimejs', 'repeat', 'repeat-1', 'title']);
});

test('renders heading text like GitHub: code spans first and verbatim, emphasis markers dropped', () => {
  assert.equal(githubSlug(headingText('`<name>` option')), 'name-option');
  assert.equal(githubSlug(headingText('<span>Tagged</span> `<b>` code')), 'tagged-b-code');
  assert.equal(githubSlug(headingText('_emphasis_ and __strong__ and *star* text')), 'emphasis-and-strong-and-star-text');
  assert.equal(githubSlug(headingText('snake_case and `_code_` stay')), 'snake_case-and-_code_-stay');
  assert.equal(githubSlug(headingText('DEVRYAN_* names')), 'devryan_-names');
  assert.equal(githubSlug(headingText('[`link` _text_](x.md)')), 'link-text');
});

test('recognizes setext headings, but not frontmatter, rules after lists or table rows', () => {
  const anchors = headingAnchors([
    '---', 'title: Page', '---', '',
    'Setext One', '==========', '',
    'Setext `<two>`', '---', '',
    '- list item', '---', '',
    '| a | b |', '---', '',
    'Para line one', 'and two', '===',
  ].join('\n'));
  assert.deepEqual([...anchors].sort(), ['para-line-oneand-two', 'setext-one', 'setext-two']);
});

test('reports in-page and cross-file anchors with no heading, leaving other targets alone', t => {
  const root = fixture(t, {
    'docs/a.md': '# A\n## Here\n[ok](#here) [bad](#gone) [x](b.md#b-section) [y](b.md#nope) [z](../README.md#top) [m](missing.md#x) [c](../code.js#L1) [r](https://e.com/#x)\n`[code](#gone-in-code)`',
    'docs/b.md': '## B section',
    'README.md': '# Read me',
    'code.js': '',
  });
  assert.deepEqual(validateHeadingAnchors(root, ['docs/a.md']), [
    { check: 'anchor', doc: 'docs/a.md', token: '#gone' },
    { check: 'anchor', doc: 'docs/a.md', token: 'b.md#nope' },
    { check: 'anchor', doc: 'docs/a.md', token: '../README.md#top' },
  ]);
});

test('decodes encoded fragments and resolves repository-root links', t => {
  const root = fixture(t, { 'docs/a.md': '[a](/docs/b.md#caf%C3%A9) [b](/docs/b.md#Café)', 'docs/b.md': '## Café' });
  assert.deepEqual(validateHeadingAnchors(root, ['docs/a.md']), [
    { check: 'anchor', doc: 'docs/a.md', token: '/docs/b.md#Café' },
  ]);
});
