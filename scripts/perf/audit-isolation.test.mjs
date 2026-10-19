import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { captureAuditConfigManifest, assertAuditConfigUnchanged, assertAuditDependencyLinks, gradeAuditHostLoad, runAuditCommand } from './audit-isolation.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devryan-audit-isolation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('configuration manifest hashes content and names, follows compatibility links and detects mutation', async t => {
  const root = await fixture(t), data = path.join(root, 'devryan');
  await mkdir(data); await writeFile(path.join(data, 'private-provider-name'), 'private-token');
  await symlink('devryan', path.join(root, 'openchamber'));
  const roots = [path.join(root, 'missing'), path.join(root, 'openchamber')];
  const before = await captureAuditConfigManifest(roots);
  assertAuditConfigUnchanged(before, await captureAuditConfigManifest(roots));
  assert.ok(!JSON.stringify(before).includes('private-'));
  await writeFile(path.join(data, 'private-provider-name'), 'changed');
  assert.throws(() => assertAuditConfigUnchanged(before, { ...before, sha256: 'changed' }), /stop affected/);
  assert.notEqual((await captureAuditConfigManifest(roots)).sha256, before.sha256);
});

test('arm dependency links retain local workspace links and reject original-checkout links', async t => {
  const root = await fixture(t), arm = path.join(root, 'arm');
  await mkdir(path.join(arm, 'node_modules'), { recursive: true });
  await mkdir(path.join(arm, 'packages', 'web'), { recursive: true });
  await symlink('../packages/web', path.join(arm, 'node_modules', 'web'));
  await assertAuditDependencyLinks(arm);
  await mkdir(path.join(root, 'original'));
  await symlink('../../original', path.join(arm, 'node_modules', 'escape'));
  await assert.rejects(assertAuditDependencyLinks(arm), /escapes its arm/);
  await rm(path.join(arm, 'node_modules', 'escape'));
  await symlink(path.join(arm, 'packages', 'web'), path.join(arm, 'node_modules', 'absolute'));
  await assert.rejects(assertAuditDependencyLinks(arm), /must be relative/);
});

test('the same frozen contamination limits reject sustained load on either arm', () => {
  const quiet = { logicalCpus: 8, totalOtherCpuPercent: 20, userAppCpuPercent: 0 };
  const high = { ...quiet, intervalOtherCpuPercent: 300 };
  assert.equal(gradeAuditHostLoad([quiet, high, quiet]), 'accepted');
  assert.equal(gradeAuditHostLoad([quiet, high, high]), 'contaminated');
  assert.equal(gradeAuditHostLoad([{ ...quiet, userAppCpuPercent: 60 }, { ...quiet, userAppCpuPercent: 60 }]), 'contaminated');
  assert.equal(gradeAuditHostLoad([quiet]), 'unqualified');
});

test('runtime window checks real-config hashes even after a failed child, without restoration', async t => {
  const root = await fixture(t), home = path.join(root, 'home'), config = path.join(root, 'real-config');
  await mkdir(home); await mkdir(config);
  const environment = { HOME: home, XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'data'),
    XDG_STATE_HOME: path.join(home, 'state'), XDG_CACHE_HOME: path.join(home, 'cache'), TMPDIR: path.join(home, 'tmp') };
  const common = { command: process.execPath, cwd: root, environment,
    evidenceDirectory: path.join(root, 'evidence'), realConfigRoots: [config] };
  const failed = await runAuditCommand({ ...common, label: 'failed-child', args: ['-e', 'process.exit(2)'] });
  assert.equal(failed.exitCode, 2); assert.equal(failed.isolation, 'unchanged');
  const changed = path.join(config, 'new');
  await assert.rejects(runAuditCommand({ ...common, label: 'changed-config',
    args: ['-e', 'require("node:fs").writeFileSync(process.argv[1], "fixture")', changed] }), /stop affected/);
  await assert.rejects(runAuditCommand({ ...common, label: 'unsafe', environment: { ...environment, TMPDIR: root }, args: [] }), /TMPDIR must be private/);
});
