import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fixtureSha256 } from './migration-fixture.mjs';

/** Real importer rerun must use its original source checkpoint and emit the same graph inventory. */
export async function runCompiledMigrationReplay({ request, run }) {
  const first = await run(request);
  const source = fixtureSha256(await fs.readFile(request.receiptPath + '.source.json'));
  const verification = fixtureSha256(await fs.readFile(request.receiptPath + '.verification.json'));
  const second = await run(request);
  assert.deepEqual(second, first, 'Completed importer replay changed its canonical receipt');
  assert.equal(fixtureSha256(await fs.readFile(request.receiptPath + '.source.json')), source);
  assert.equal(fixtureSha256(await fs.readFile(request.receiptPath + '.verification.json')), verification);
  return first;
}
