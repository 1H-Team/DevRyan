import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseStartupRecoveryUiArgs, runStartupRecoveryUi } from './startup-recovery-ui.mjs';
import { prepareOwnedQaDirectory } from './owned-output.mjs';

test('local recovery diagnostic requires explicit absolute owned artifact inputs', () => {
  const args = ['--package-evidence', '/fixture/package.json', '--artifact-root', '/fixture/native', '--receipt', '/fixture/proof.json'];
  assert.equal(parseStartupRecoveryUiArgs(args).receiptPath, '/fixture/proof.json');
  for (const bad of [[], args.slice(0, -2), [...args, '--boot-id', 'fake'], args.map(value => value.startsWith('/') ? value.slice(1) : value),
    args.map(value => value === '/fixture/proof.json' ? '/fixture/../proof.json' : value)])
    assert.throws(() => parseStartupRecoveryUiArgs(bad));
});

test('QA output creation rejects traversal and symlink parents before creating escaped files', async () => {
  const family = fileURLToPath(new URL('../../.cache/qa-output-tests', import.meta.url));
  fs.mkdirSync(family, { recursive: true });
  const root = fs.mkdtempSync(path.join(family, 'trial-'));
  const owned = path.join(root, 'owned'), other = path.join(root, 'other');
  try {
    fs.mkdirSync(owned); fs.mkdirSync(other);
    await prepareOwnedQaDirectory(path.join(owned, 'evidence/nested'), owned);
    assert.ok(fs.statSync(path.join(owned, 'evidence/nested')).isDirectory());
    await assert.rejects(prepareOwnedQaDirectory(owned + '/../other/new', owned));
    fs.symlinkSync(other, path.join(owned, 'link'));
    await assert.rejects(prepareOwnedQaDirectory(path.join(owned, 'link/new'), owned), /symlink/);
    assert.equal(fs.existsSync(path.join(other, 'new')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('local diagnostic cannot count itself as reboot qualification or bypass the release runner guard', async () => {
  if (!globalThis.Bun) await assert.rejects(runStartupRecoveryUi({}), /requires Bun on Darwin ARM64/);
  const source = fs.readFileSync(new URL('./startup-recovery-ui.mjs', import.meta.url), 'utf8');
  assert.match(source, /qualification: 'development-only'/);
  assert.match(source, /retryAction: 'not-invoked'/);
  assert.match(source, /actualReboot: 'not-run'/);
  assert.doesNotMatch(source, /launchReleaseStartup\(|seedReleaseUnsettledProcess\(|shutdown|\/sbin\/reboot/);
});
