import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createMigrationRefusalCopy, fixtureSha256 } from './migration-fixture.mjs';

/** Every negative case is a fresh closed copy consumed by the actual compiled importer. */
export async function runCompiledMigrationRefusals({ fixture, run }) {
  const cases = [];
  for (const kind of ['pending-revert', 'remembered-deny', 'unknown-marker']) {
    const copy = await createMigrationRefusalCopy(fixture, kind);
    const root = path.dirname(copy.databasePath);
    const isolatedRoot = path.join(root, 'global'), receiptPath = path.join(root, 'sources/migration.json');
    await fs.mkdir(path.dirname(receiptPath), { recursive: true });
    const before = fixtureSha256(await fs.readFile(copy.databasePath));
    await assert.rejects(run({ protocol: 'devryan-native-migration/1', requestID: `refuse_${kind}`, bundleID: `refuse_${kind}`,
      candidateDatabasePath: copy.databasePath, isolatedRoot, receiptPath, auxiliary: { kind: 'absent' }, projectMap: fixture.projectMap }),
    error => error.code === copy.expectedCode, `Compiled importer did not refuse the exact ${kind} boundary`);
    assert.equal(fixtureSha256(await fs.readFile(copy.databasePath)), before, 'Refused importer changed its candidate');
    await assert.rejects(fs.stat(receiptPath), error => error.code === 'ENOENT', 'Refused importer published a success receipt');
    cases.push({ id: `compiled-migration-refuses-${kind}`, status: 'passed', refusal: copy.expectedCode, source: 'actual-compiled-importer' });
  }
  assert.equal(fixtureSha256(await fs.readFile(fixture.sourceLaunch.opencodeDatabasePath)), fixture.expected.databaseSha256);
  return cases;
}

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
