import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createDiagnosticSanitizer } from '../../packages/harness-runtime/lib/sanitizer.js';
import { archiveQaNativeHostLog } from './native-profile-factory-diagnostic.mjs';

test('failed host startup logs retain bounded private sanitized evidence', async () => {
  const root = await fs.mkdtemp(path.resolve('.cache/qa-native-host-log-'));
  const secret = 'synthetic-diagnostic-only-secret';
  const sanitizer = createDiagnosticSanitizer({ homeDir: root, knownSecrets: [secret] });
  try {
    const result = await archiveQaNativeHostLog({ getLog: () => `Error: startup failed at ${root}/fixture; ${secret}\n` }, root, sanitizer);
    const log = await fs.readFile(path.join(root, result.file), 'utf8');
    assert.match(log, /startup failed/);
    assert.equal(log.includes(root), false);
    assert.equal(log.includes(secret), false);
    assert.equal(result.sha256, crypto.createHash('sha256').update(log).digest('hex'));
    if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(root, result.file))).mode & 0o777, 0o600);
    const bounded = await archiveQaNativeHostLog({ getLog: () => 'startup failed\n'.repeat(10000) }, root, sanitizer);
    assert.equal(bounded.truncated, true);
    assert.equal(bounded.bytes, 64 * 1024);
    assert.equal((await fs.stat(path.join(root, bounded.file))).size, bounded.bytes);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
