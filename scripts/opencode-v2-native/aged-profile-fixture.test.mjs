import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { AGED_PROFILE_SCENARIOS, AGED_PROFILE_SCENARIO_NAMES, AGED_PROFILE_SOURCE_BUNDLE_ID, agedFindingRows, agedNativeIdentity, agedProfileScenario, writeAgedProfile } from './aged-profile-fixture.mjs';
import { initGitRepository } from '../test-git-template.mjs';
import { createRunRoot, scratchParent } from '../qa/run-root.mjs';
import { openChangeStore, changeKey } from '../../packages/harness-runtime/lib/session-changes-store.js';
import { decodeLedgerSnapshot } from '../../packages/orchestration-runtime/codec.js';

// Signals stay with the runner; an exit hook still removes a run a crash abandons.
const scratch = async (body) => {
  const run = createRunRoot({ parent: scratchParent('qa'), prefix: 'aged-profile-', owner: 'aged-profile-fixture-test', signals: 'exit', env: {}, argv: [] });
  try { await body(run.dir); run.finish('passed'); } catch (error) { run.finish('failed'); throw error; }
};

test('every scenario is selectable by a unique name and declares its incident and outcome', () => {
  assert.equal(new Set(AGED_PROFILE_SCENARIO_NAMES).size, AGED_PROFILE_SCENARIOS.length);
  for (const scenario of AGED_PROFILE_SCENARIOS) {
    assert.match(scenario.name, /^[a-z][a-z-]+$/);
    assert.ok(scenario.incident.length > 10, scenario.name);
    assert.ok(Array.isArray(scenario.outcome.findings) && Array.isArray(scenario.outcome.copyFindings), scenario.name);
    for (const code of [...scenario.outcome.findings, ...scenario.outcome.copyFindings]) assert.match(code, /^bundle_[a-z_]+$/);
    assert.ok(scenario.outcome.strictRefusal === null || /^[a-z_]+$/.test(scenario.outcome.strictRefusal), scenario.name);
    assert.equal(agedProfileScenario(scenario.name), scenario);
  }
  assert.throws(() => agedProfileScenario('no-such-shape'), /Unknown aged-profile scenario/);
});

test('the corpus is written by the product writers and reads back through the product readers', async () => {
  await scratch(async (root) => {
    const directory = path.join(root, 'project'), web = path.join(root, 'web-data');
    await initGitRepository(directory);
    const profile = await writeAgedProfile({ webDataDirectory: web, directory, files: 8 });
    assert.deepEqual(profile.scenarios, AGED_PROFILE_SCENARIO_NAMES);
    const storage = path.join(web, 'harness', 'session-mutations', changeKey(profile.directory));
    const db = await openChangeStore(storage, path.join(storage, 'git'));
    const kinds = new Set();
    for await (const { key } of db.records()) kinds.add(key.split('/')[0]);
    for (const kind of ['meta.json', 'leases', 'calls', 'prompts', 'sessions', 'transactions', 'native-removals', 'native-shell-jobs', 'operations'])
      assert.ok(kinds.has(kind), `ledger lacks ${kind}`);
    // Deleted sessions have completed removals; live ones have OpenCode rows to seed.
    const removals = [];
    for await (const { value } of db.entries('native-removals')) removals.push(value);
    assert.deepEqual(removals.map(row => row.state), removals.map(() => 'completed'));
    assert.deepEqual(removals.map(row => row.rootSessionID).sort(),
      ['ses_aged_cancelled_revert', 'ses_aged_child', 'ses_aged_committed_revert', 'ses_aged_deleted_shell']);
    const identity = agedNativeIdentity(profile);
    assert.ok(removals.every(row => !identity.sessionIDs.includes(row.rootSessionID)));
    assert.deepEqual(identity.archivedSessionIDs, ['ses_aged_archived_shell']);
    assert.deepEqual(profile.native.inbox.map(row => row.sessionID), ['ses_aged_archived_shell']);
    // The task ledger decodes with the orchestration codec.
    const ledger = decodeLedgerSnapshot(JSON.parse(await fs.readFile(path.join(web, 'orchestration', 'ledger.json'), 'utf8')));
    assert.deepEqual(ledger.tasks.map(task => task.status), ['completed', 'completed']);
    // One expected row per record, and the declared codes per scenario add up to them.
    const findings = agedFindingRows(profile.expected.findings);
    assert.equal(new Set(findings).size, findings.length);
    assert.deepEqual(profile.expected.findings.map(row => row.code).sort(), AGED_PROFILE_SCENARIOS.flatMap(scenario => scenario.outcome.findings).sort());
    assert.deepEqual(profile.expected.findings.filter(row => row.key.startsWith('tasks/')).map(row => `${row.code} ${row.key}`).sort(),
      ['bundle_message_reference_lost tasks/dvr_task_aged_1', 'bundle_session_reference_lost tasks/dvr_task_aged_1', 'bundle_session_reference_lost tasks/dvr_task_aged_2']);
    assert.equal(profile.expected.findings.filter(row => row.code === 'bundle_shell_notice_undelivered').length, 2);
    assert.deepEqual(agedFindingRows(profile.expected.copyFindings), ['bundle_inbox_notice_undelivered msg_aged_archived_notice']);
    assert.deepEqual(profile.outcome.strictRefusals, ['bundle_execution_unsettled', 'migration_revert_pending']);
    // Startup recovery targets, written as the gone process left them.
    const [control, claimed] = profile.expected.settledLeases;
    assert.equal((await db.get(control.key)).state, 'ready');
    const lease = await db.get(claimed.key);
    assert.deepEqual([lease.state, lease.executionKind, lease.ownerID], ['ready', 'process', '70000000-0000-4000-8000-0000000000a1']);
    assert.ok(Date.now() - lease.reservedAt > 10 * 60_000);
    await assert.rejects(fs.lstat(path.join(path.dirname(lease.viewDirectory), 'termination.json')), { code: 'ENOENT' });
    assert.equal((await db.get(profile.expected.cancelledReverts[0].key)).state, 'prepared');
    // Derived ledger links, and the Cursor intent stamped by the source bundle.
    assert.ok(profile.expected.derivedLinks.some(link => /module-overlays\/[a-f0-9]{16}\/aged-dependency$/.test(link)));
    const intents = (await fs.readdir(path.join(web, 'harness', 'native-cursor'))).filter(name => name.endsWith('.json'));
    assert.equal(intents.length, 1);
    assert.equal(JSON.parse(await fs.readFile(path.join(web, 'harness', 'native-cursor', intents[0]), 'utf8')).ownerID, AGED_PROFILE_SOURCE_BUNDLE_ID);
  });
});

test('a selection writes only its own shapes', async () => {
  await scratch(async (root) => {
    const directory = path.join(root, 'project'), web = path.join(root, 'web-data');
    await initGitRepository(directory);
    const profile = await writeAgedProfile({ webDataDirectory: web, directory, scenarios: ['orphaned-child-tasks'] });
    assert.deepEqual(profile.scenarios, ['orphaned-child-tasks']);
    await assert.rejects(fs.lstat(path.join(web, 'harness')), { code: 'ENOENT' });
    assert.deepEqual(profile.outcome, { strictRefusals: [] });
    assert.equal(profile.expected.findings.length, 3);
    await assert.rejects(writeAgedProfile({ webDataDirectory: web, directory, scenarios: ['no-such-shape'] }), /Unknown aged-profile scenario/);
  });
});
