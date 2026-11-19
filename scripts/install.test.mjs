import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('./install.sh', import.meta.url));

test('install.sh points to the DMG release page, fails, and installs nothing', () => {
  const commands = readFileSync(script, 'utf8').split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n');
  assert.doesNotMatch(commands, /\b(?:npm|pnpm|yarn|bun)\b[^\n]*\b(?:install|add)\b/);
  assert.doesNotMatch(commands, /@devryan\/web|registry\.npmjs\.org/);
  // An empty PATH proves the script needs, and therefore runs, no package manager.
  const result = spawnSync('/bin/sh', [script], { encoding: 'utf8', env: { PATH: '' }, timeout: 10000 });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /DMG/);
  assert.match(result.stderr, /https:\/\/github\.com\/1H-Team\/DevRyan\/releases\/latest/);
});
