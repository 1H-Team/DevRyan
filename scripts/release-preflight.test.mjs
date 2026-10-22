import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { preflight } from './release-preflight.mjs';

test('local preflight reports every check and fails on any of them', async () => {
  const shipped = JSON.parse(readFileSync(new URL('./fixtures/shipped-updater/shipped.json', import.meta.url), 'utf8'));
  const run = (failing) => async (command, args) => {
    if (command === failing) throw new Error(`${command} failed`);
    if (command === 'git' && args[0] === 'rev-parse' && args[1].includes(':')) {
      const [tag, file] = args[1].split(':');
      return { stdout: `${shipped[tag][file]}\n` };
    }
    return { stdout: 'a'.repeat(40) };
  };
  const lines = [];
  const output = await preflight({ environment: {}, run: run(null), log: line => lines.push(line), localOnly: true });
  assert.equal(output.version, JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
  assert.deepEqual(lines.map(line => line.split(':')[0]), ['[preflight] pass version files and bun.lock', '[preflight] pass CHANGELOG section', '[preflight] pass frozen lockfile', '[preflight] pass shipped discovery fixtures']);
  await assert.rejects(preflight({ environment: {}, run: run('bun'), log: () => {}, localOnly: true }), /Release preflight failed: frozen lockfile/);
});
