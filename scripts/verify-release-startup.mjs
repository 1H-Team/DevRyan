import fs from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { assertReleaseStartupReceipt } from './qa/release-startup-contract.mjs';

const { values } = parseArgs({ options: { receipt: { type: 'string' }, version: { type: 'string' },
  'source-commit': { type: 'string' }, 'dmg-sha256': { type: 'string' } }, strict: true });
assertReleaseStartupReceipt(JSON.parse(await fs.readFile(values.receipt, 'utf8')), {
  version: values.version, sourceCommit: values['source-commit'], dmgSha256: values['dmg-sha256'],
});
console.log('Final-DMG startup receipt verified');
