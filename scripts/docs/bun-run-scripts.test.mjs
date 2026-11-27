import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { bunRunCommands, validateBunRunScripts } from './bun-run-scripts.mjs';

function fixture(t, files) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'devryan-docs-bun-run-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [file, contents] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), contents);
  }
  return root;
}

const manifest = (name, scripts) => JSON.stringify({ name, scripts: Object.fromEntries(scripts.map((script) => [script, 'true'])) });

test('parses names, --cwd, --filter and options, and skips placeholders', () => {
  const commands = bunRunCommands([
    'Run `bun run validate`, then `bun run --cwd packages/web test -- --watch`.',
    '```sh\nbun run --filter=@x/ui type-check\nbun --cwd=packages/ui run build\nbun run --silent docs:validate --prune\n```',
    '`bun run <script>` `bun run --cwd packages/<name> test` `bun run ${script}` `bun run`',
  ].join('\n'));
  assert.deepEqual(commands.map(({ name, cwd, filter }) => [name, cwd, filter]), [
    ['validate', null, null],
    ['test', 'packages/web', null],
    ['type-check', null, '@x/ui'],
    ['build', 'packages/ui', null],
    ['docs:validate', null, null],
  ]);
  assert.equal(commands[1].command, 'bun run --cwd packages/web test');
  assert.equal(commands[4].command, 'bun run --silent docs:validate');
});

test('checks each command against the manifest it runs against', t => {
  const root = fixture(t, {
    'package.json': manifest('root', ['validate']),
    'packages/web/package.json': manifest('@x/web', ['test']),
    'packages/ui/package.json': manifest('@x/ui', ['type-check']),
    'packages/ui/src/probe.ts': '',
    'docs/a.md': [
      'bun run validate', 'bun run validate:affected', 'bun run test',
      'bun run --cwd packages/web test', 'bun run --cwd packages/web type-check', 'bun run --cwd packages/gone test',
      'bun run --filter @x/ui type-check', 'bun run --filter ./packages/web type-check', "bun run --filter '*' test",
      'bun run --cwd packages/ui src/probe.ts', 'bun run --cwd packages/ui src/gone.ts', 'bun run scripts/gone.mjs',
    ].join('\n'),
  });
  assert.deepEqual(validateBunRunScripts(root, ['docs/a.md']).map((violation) => violation.token), [
    'bun run validate:affected',
    'bun run test',
    'bun run --cwd packages/web type-check',
    'bun run --cwd packages/gone test',
    'bun run --filter ./packages/web type-check',
    'bun run --cwd packages/ui src/gone.ts',
    'bun run scripts/gone.mjs',
  ]);
});
