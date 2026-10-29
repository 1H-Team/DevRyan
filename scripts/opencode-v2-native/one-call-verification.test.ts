import { expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { ONE_CALL_PAGE, runOneCallVerification } from './one-call-verification.mjs';

const repository = path.resolve(import.meta.dirname, '../..');
const launcher = path.join(repository, 'packages/web/runtime/darwin-arm64/DevRyan-execution-darwin-arm64');
const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

// A delegated task cannot keep a background server (native_shell_background_unavailable);
// its supported replacement is this one foreground call (one-call-verification.mjs).
test.skipIf(process.platform !== 'darwin')('one foreground call serves, checks, keeps byte-exact evidence and leaves nothing listening', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-one-call-')));
  try {
    const run = await runOneCallVerification({ launcher, root, node: process.execPath });
    expect({ receipt: run.receipt, stdout: run.stdout.trim(), stderr: run.stderr }).toMatchObject({
      receipt: { terminated: true, confined: true, cancelled: false, exitCode: 0 }, stdout: 'checked', stderr: '' });
    // Read where file tools read it, the project's own folder, byte for byte.
    expect(run.artifactDirectory).toBe(path.join(run.directory, '.artifacts', 'devryan', 'ses_oneCall', 'call_oneCall'));
    const evidence = path.join(run.directory, '.artifacts', 'devryan', 'ses_oneCall', 'call_oneCall');
    expect(sha256(await fs.readFile(path.join(evidence, 'page.html')))).toBe(sha256(ONE_CALL_PAGE));
    // Nothing the call started is still listening.
    const port = Number((await fs.readFile(path.join(evidence, 'port.txt'), 'utf8')).trim());
    expect(port).toBeGreaterThan(0);
    expect(spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).stdout.trim()).toBe('');
    // The evidence stays out of the ledger: nothing is published.
    expect(run.published).toEqual([]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}, 60_000);
