import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { runNativeMigrationProcess } from '../../packages/web/server/lib/opencode/runtime-host/native-migration-process.js';
import { repositoryRoot } from './artifacts.mjs';
import { createQaHostLaunchEnvironment } from '../qa/launch-environment.mjs';

const temporaryRoot = path.join(repositoryRoot, '.cache/v2-validation/tmp');
await fs.mkdir(temporaryRoot, { recursive: true });

const fixture = async (mode, run) => {
  const root = await fs.mkdtemp(path.join(temporaryRoot, 'native-migration-process-'));
  await fs.writeFile(path.join(root, 'package.json'), '{"type":"commonjs"}\n');
  const binary = path.join(root, 'DevRyan-migration-protocol-fixture');
  await fs.writeFile(binary, `#!/usr/bin/env node
const fs=require('node:fs'),crypto=require('node:crypto');
fs.writeFileSync('owned-pid',String(process.pid));
if(process.argv[2]!=='--migrate'||process.argv[3]!=='--native-instance'||!/^[-a-f0-9]{36}$/.test(process.argv[4]))process.exit(7);
let input='';process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{
const request=JSON.parse(input),mode=${JSON.stringify(mode)};
if(mode==='timeout'){setInterval(()=>{},100);return;}
if(mode==='overflow'){process.stdout.write('x'.repeat(65537));setInterval(()=>{},100);return;}
if(mode==='nonzero'){process.exit(8);return;}
if(mode==='refused'){process.stdout.write(JSON.stringify({protocol:'devryan-native-migration/1',ok:false,error:{code:'migration_revert_pending',status:409}})+'\\n');process.exitCode=1;return;}
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
for(const suffix of ['.source.json','.verification.json'])fs.writeFileSync(request.receiptPath+suffix,'{}\\n');
const receipt={protocol:'devryan-native-migration/1',requestID:request.requestID,bundleID:mode==='mismatch'?'wrong':request.bundleID,databasePath:request.candidateDatabasePath,status:'completed',nativeVersion:'2.0.20',marker:'completed',sourceInventorySha256:hash('{}\\n'),verificationSha256:hash('{}\\n')};
const bytes=JSON.stringify(receipt,Object.keys(receipt).sort())+'\\n';fs.writeFileSync(request.receiptPath,bytes);
process.stdout.write(JSON.stringify({protocol:receipt.protocol,ok:true,receipt,receiptPath:request.receiptPath,sha256:hash(bytes)})+'\\n');
setTimeout(()=>process.exit(0),100);
});
`, { mode: 0o700 });
  if (mode === 'timeout') await fs.writeFile(binary, '#!/bin/sh\necho $$ > owned-pid\n/bin/sleep 60 &\necho $! > descendant-pid\nwait\n', { mode: 0o700 });
  const request = { protocol: 'devryan-native-migration/1', requestID: 'owned-request', bundleID: 'candidate',
    candidateDatabasePath: path.join(root, 'candidate.db'), isolatedRoot: path.join(root, 'global'), receiptPath: path.join(root, 'receipt.json'),
    auxiliary: { kind: 'absent' }, projectMap: [] };
  const environment = createQaHostLaunchEnvironment({ HOME: root, TMPDIR: root });
  try { await run({ root, cwd: root, binary, request, environment }); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
};

test('offline migration success waits for scope exit and verifies semantically bound persisted inventory hashes', async () => {
  await fixture('success', async options => {
    const start = Date.now(); const receipt = await runNativeMigrationProcess(options);
    assert.equal(receipt.bundleID, 'candidate'); assert.ok(Date.now() - start >= 100);
    const pid = Number(await fs.readFile(path.join(options.root, 'owned-pid'), 'utf8'));
    assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
  });
});

test('offline migration rejects nonzero exit and a receipt for another bundle', async () => {
  for (const [mode, code] of [['nonzero', 'native_migration_exit_unconfirmed'], ['mismatch', 'native_migration_receipt_mismatch'], ['refused', 'migration_revert_pending']]) {
    await fixture(mode, options => assert.rejects(runNativeMigrationProcess(options), error => error.code === code));
  }
});

test('offline importer timeout and output overflow terminate only the owned child before rejecting', async () => {
  for (const [mode, code] of [['timeout', 'native_migration_timeout'], ['overflow', 'native_migration_output_bound']]) {
    await fixture(mode, async options => {
      await assert.rejects(runNativeMigrationProcess({ ...options, timeoutMs: mode === 'timeout' ? 500 : 3000 }), error => error.code === code);
      const pid = Number(await fs.readFile(path.join(options.root, 'owned-pid'), 'utf8'));
      assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
      if (mode === 'timeout') {
        const descendant = Number(await fs.readFile(path.join(options.root, 'descendant-pid'), 'utf8'));
        assert.throws(() => process.kill(descendant, 0), error => error.code === 'ESRCH');
      }
    });
  }
});
