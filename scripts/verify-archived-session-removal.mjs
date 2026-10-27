import path from 'node:path';
import { parseArgs } from 'node:util';
import { runNativePackageAcceptance } from './verify-opencode-v2-package.mjs';

const { values } = parseArgs({ options: {
  'artifact-root': { type: 'string' },
  'keep-artifacts': { type: 'boolean' },
} });
const result = await runNativePackageAcceptance({ archivedRemovalOnly: true,
  ...(values['artifact-root'] ? { artifactRoot: path.resolve(values['artifact-root']) } : {}),
});
process.stdout.write(JSON.stringify({ status: result.status, qualification: result.qualification,
  cases: result.cases, error: result.error, cleanupFailures: result.cleanupFailures }) + '\n');
if (result.status !== 'archived-removal-passed') process.exitCode = 1;
