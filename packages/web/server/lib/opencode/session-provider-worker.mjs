import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { startReadOnlySessionExecution } from '@openchamber/harness-runtime/lib/session-execution.js';

const input = JSON.parse(process.env.DEVRYAN_PROVIDER_COMMAND || '{}');
delete process.env.DEVRYAN_PROVIDER_COMMAND;
if (typeof input.command !== 'string' || !Array.isArray(input.args) || input.args.some((arg) => typeof arg !== 'string')) {
  throw new Error('Invalid provider execution input');
}
const controller = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => controller.abort());
const storage = process.env.DEVRYAN_PROVIDER_STORAGE;
const account = process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME || '', '.claude');
const state = path.join(storage, 'state', createHash('sha256').update(JSON.stringify([account, input.directory])).digest('hex'));
await fs.mkdir(state, { recursive: true, mode: 0o700 });
// The transport keeps its own transcripts and refresh state. The original
// credential file is a read-only input and is never logged or copied here.
const credentials = path.join(state, '.credentials.json');
try { await fs.symlink(path.join(account, '.credentials.json'), credentials); }
catch (cause) { if (cause.code !== 'EEXIST') throw cause; }
const handle = await startReadOnlySessionExecution({ launcher: process.env.DEVRYAN_EXECUTION_LAUNCHER, storage,
  auxiliaryDirectory: state, logicalDirectory: input.directory, command: input.command, args: input.args, signal: controller.signal, interactive: true,
  env: { ...process.env, CLAUDE_CONFIG_DIR: state, DEVRYAN_EXECUTION_WORKER: '1' } });
process.stdin.pipe(handle.child.stdin); handle.child.stdout.pipe(process.stdout); handle.child.stderr.pipe(process.stderr);
handle.child.stdin.on('error', () => {});
const receipt = await handle.result;
process.stdin.unpipe(); process.stdin.destroy();
process.exitCode = receipt.exitCode;
