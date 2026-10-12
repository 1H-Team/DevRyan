import fs from 'node:fs/promises';
import { parseArgs } from 'node:util';
import path from 'node:path';
import assert from 'node:assert/strict';
import { assertReleaseStartupReceipt } from './qa/release-startup-contract.mjs';
import { hashReleaseFile } from './qa/release-startup-artifacts.mjs';

const { values } = parseArgs({ options: { receipt: { type: 'string' }, version: { type: 'string' },
  'source-commit': { type: 'string' }, 'dmg-sha256': { type: 'string' } }, strict: true });
const receipt = assertReleaseStartupReceipt(JSON.parse(await fs.readFile(values.receipt, 'utf8')), {
  version: values.version, sourceCommit: values['source-commit'], dmgSha256: values['dmg-sha256'],
});
for (const image of receipt.scenarios.flatMap(row => row.screenshots)) {
  assert.equal(await hashReleaseFile(path.join(path.dirname(values.receipt), image.name)), image.sha256, 'Startup screenshot is missing or differs');
}
console.log('Final-DMG startup receipt verified');
