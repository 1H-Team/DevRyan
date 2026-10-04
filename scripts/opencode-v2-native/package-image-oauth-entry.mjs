// Source OAuth preparation only; executable SDK imports happen under isolated launch globals.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
const repository = path.resolve(import.meta.dirname, '../..');
try {
  assert.equal(process.argv.length, 4);
  const [requestPath, proofPath] = process.argv.slice(2);
  for (const file of [requestPath, proofPath]) assert.ok(path.isAbsolute(file) && file.startsWith(repository + path.sep));
  assert.equal(await fs.realpath(requestPath), requestPath);
  const handle = await fs.open(requestPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let request;
  try {
    const stat = await handle.stat(); assert.ok(stat.isFile() && stat.size <= 16384 && (stat.mode & 0o077) === 0);
    const bytes = await handle.readFile(); assert.equal(bytes.length, stat.size); request = JSON.parse(bytes);
  } finally { await handle.close(); }
  assert.deepEqual(Object.keys(request).sort(), ['databasePath', 'directory', 'expiresIn', 'profileRoot']);
  assert.equal(path.dirname(requestPath), request.profileRoot);
  assert.equal(path.dirname(proofPath), request.profileRoot);
  const { prepareSourceOpenAiFixture } = await import('./package-image-source-oauth.mjs');
  const proof = await prepareSourceOpenAiFixture(request);
  await fs.writeFile(proofPath, JSON.stringify(proof) + '\n', { flag: 'wx', mode: 0o600 });
} catch {
  // Do not echo credential values, requests or nested SDK errors through this one-shot boundary.
  process.stderr.write('source_image_oauth_preparation_failed\n');
  process.exitCode = 1;
}
