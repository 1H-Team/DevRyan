import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { prepareSourceImageAccounts, assertSourceImageOAuthProof } from './package-image-oauth-process.mjs';

test('owned source OAuth connects two native accounts through real grants and survives scope close/reopen', { timeout: 45000 }, async () => {
  const repository = path.resolve(import.meta.dirname, '../..');
  const root = await fs.mkdtemp(path.join(repository, '.cache/v2-validation/source-image-test-'));
  try {
    const directory = path.join(root, 'project'), databasePath = path.join(root, 'native.sqlite');
    await fs.mkdir(directory); await fs.writeFile(databasePath, '');
    const result = await prepareSourceImageAccounts({ root, databasePath, directory });
    assert.equal(result.sourceOAuthCreation, true); assert.equal(result.compiledOAuthCreation, false);
    assert.deepEqual(result.proof.reopened, result.proof.accounts[1]);
    assert.ok(result.proof.accounts[1].expires < Date.now() + 60000, 'B must require native refresh at the compiled physical attempt');
    assert.equal(JSON.stringify(result.proof).includes('owned-image-access'), false);
    assert.equal(JSON.stringify(result.proof).includes('owned-image-refresh'), false);
    assert.throws(() => assertSourceImageOAuthProof({ ...result.proof, compiledOAuthCreation: true }));
    assert.throws(() => assertSourceImageOAuthProof({ ...result.proof, access: 'forged' }));
    assert.throws(() => assertSourceImageOAuthProof({ ...result.proof, reopened: result.proof.accounts[0] }));
    assert.equal(result.cleanup.trackingClosed, true);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
