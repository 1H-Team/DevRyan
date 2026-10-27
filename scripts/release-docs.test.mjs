import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// A published release, its assets and its devryan-release/ ledger tag are final
// (AGENTS.md, docs/RELEASE_PIPELINE.md). No doc may instruct deleting, editing or
// re-uploading them; a clause that names such a step only to forbid it is fine.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DESTRUCTIVE = [
  /\bgh release (?:delete|delete-asset|upload|edit)\b/i,
  /\bgh api\b[^\n]*(?:-X|--method)\s*(?:DELETE|PATCH)\b[^\n]*\/releases/i,
  /\bgit push\b[^\n]*(?:--delete|\s:refs\/tags\/)/i,
  /\bgit tag (?:-d|--delete)\b/i,
  /\bdelet(?:e|es|ing)\b[^.;]{0,30}\b(?:releases?|tags?)\b(?!\s+(?:token|lock|owner))/i,
  /\bremov(?:e|es|ing)\b[^.;]{0,20}\bassets? from\b[^.;]{0,30}\b(?:releases?|tags?)\b/i,
  /\bre-?upload(?:s|ed|ing)?\b/i,
  /\bre-?publish(?:es|ed|ing)?\b[^.;]{0,40}\b(?:releases?|manifest|assets?|versions?)\b/i,
];
const PROHIBITION = /\b(?:never|do not|don't|must not|refuses?|refused|cannot|not allowed|forbid(?:s|den)?)\b/i;

/**
 * Clauses of a Markdown file (sentences split at `;` and `:`) with the first
 * line of their paragraph, so "delete the tag; do not remove assets" is two clauses.
 */
function clauses(text) {
  const out = [];
  let line = 1;
  for (const block of text.split(/\n\s*\n/)) {
    const flat = block.replace(/\s*\n\s*/g, ' ');
    for (const sentence of flat.split(/(?<=[.!?])\s+(?=[A-Z`*[(])/)) {
      for (const clause of sentence.split(/[;:]\s+/)) out.push({ line, clause });
    }
    line += block.split('\n').length + 1;
  }
  return out;
}

export function releaseDeletionInstructions(file, text) {
  return clauses(text).filter(({ clause }) => DESTRUCTIVE.some(pattern => pattern.test(clause)) && !PROHIBITION.test(clause))
    .map(({ line, clause }) => `${file}:${line}: ${clause.slice(0, 200)}`);
}

const docs = () => execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '*.md'], { cwd: root, encoding: 'utf8' }).split('\n')
  // The changelog records history; reviewed inputs and dependencies are not ours.
  .filter(file => file && file !== 'CHANGELOG.md' && !file.includes('node_modules/') && !file.startsWith('packages/web/runtime/reviewed-inputs/'));

test('no doc instructs deleting, editing or re-uploading a release, its assets or its ledger tag', () => {
  const files = docs();
  assert.ok(files.includes('docs/RELEASE_PIPELINE.md') && files.includes('AGENTS.md') && files.includes('docs/TAURI_TO_ELECTRON_CUTOVER.md'));
  const violations = files.flatMap(file => { try { return releaseDeletionInstructions(file, readFileSync(path.join(root, file), 'utf8')); } catch { return []; } });
  assert.deepEqual(violations, [], `Published releases are final; rewrite these as roll-forward steps:\n${violations.join('\n')}`);
});

test('the rule flags destructive release steps and accepts prohibitions of them', () => {
  // The cutover record's wording before 2026-10-24.
  const flagged = [
    'If any step fails, delete the test tag and release; do not remove assets from a\nreal tag until the rollback below.',
    'If the transition update bricks installs: delete the transition payload and its\nTauri manifest from the release (keep the DMGs so manual download works),\nre-publish the previous version\'s manifest so Tauri updaters see "up to date".',
    'Run `gh release delete v2.1.5 --yes` and tag again.',
    'Then `gh release upload v2.1.5 DevRyan-2.1.5-arm64.dmg --clobber`.',
    'Clean up with `git push origin :refs/tags/devryan-release/v2.1.5`.',
    'Re-upload the DMG to the release.',
    'Run `gh api -X DELETE repos/1H-Team/DevRyan/releases/1`.',
  ];
  for (const text of flagged) assert.ok(releaseDeletionInstructions('fixture.md', text).length >= 1, text);
  const accepted = [
    'Never delete, re-upload or edit a published release or its `devryan-release/` ledger tag.',
    'Never run `gh release delete`, upload or edit assets by hand, or delete a `devryan-release/` tag: a published version is final.',
    'Because it outlives the release object, deleting and re-creating a published release (the v2.1.5 case) is refused.',
    'A published release is final: its assets and its `devryan-release/` ledger tag are never deleted, edited or replaced.',
    'Do not move the tag for a flaky test.',
    'The release job removes any other draft of the version.',
    'Locks are deleted only when the release token still matches.',
  ];
  for (const text of accepted) assert.deepEqual(releaseDeletionInstructions('fixture.md', text), [], text);
});
