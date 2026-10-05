import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collectJournalPaths, readRecordsFromPaths } from '../journal.mjs';
import { createFixtureJournal } from './fixture-journal.mjs';

const temporary = async () => fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-fixture-journal-')));
const readAll = async directory => {
  const records = [];
  for await (const record of readRecordsFromPaths(await collectJournalPaths(directory))) records.push(record);
  return records;
};

test('fixture journal tees every production source mapping into the real durable web journal and seals it on drain', async () => {
  const root = await temporary();
  try {
    const webDataDirectory = path.join(root, 'web-data');
    const journal = await createFixtureJournal({ webDataDirectory, label: 'fixture-main-1' });
    assert.equal(journal.journalDirectory, path.join(webDataDirectory, 'harness', 'journal'));
    assert.equal(journal.ownerDiagnostic({ type: 'lifecycle', event: 'native_observation_gap', sessionID: 'ses_owner',
      payload: { stage: 'controller', code: 'native_observation_unavailable' } }), true);
    assert.equal(journal.clientDiagnostic({ phase: 'request', code: 'fixture' }), true);
    assert.equal(journal.sessionExecution({ event: 'session_execution', sessionID: 'ses_exec', phase: 'finish', state: 'completed' }), true);
    assert.equal(journal.primaryRecoveryIncident({ event: 'primary_recovery_fixture', sessionID: 'ses_primary', messageID: 'msg_1' }), true);
    await journal.flush();
    const open = (await collectJournalPaths(journal.journalDirectory)).filter(file => file.endsWith('.open'));
    assert.ok(open.length > 0, 'A flushed but undrained journal keeps its active chunks open');
    journal.beginDrain();
    await journal.drain();
    assert.equal(journal.ownerDiagnostic({ type: 'lifecycle', event: 'late_close_diagnostic' }), false);
    assert.deepEqual(journal.summary(), { label: 'fixture-main-1', journalDirectory: journal.journalDirectory,
      accepted: { 'fixture-main-1': 4 }, rejectedBeforeDrain: 0, rejectedAfterDrain: 1, drained: true });
    const paths = await collectJournalPaths(journal.journalDirectory);
    assert.ok(paths.length > 0); assert.equal(paths.some(file => file.endsWith('.open')), false);
    const records = await readAll(journal.journalDirectory);
    assert.equal(records.length, 4);
    assert.ok(records.every(row => row.runtime === 'fixture-main-1' && row.type === 'lifecycle'));
    const byEvent = Object.fromEntries(records.map(row => [row.event, row]));
    assert.deepEqual(Object.keys(byEvent).sort(), ['native_observation_gap', 'opencode_client', 'primary_recovery_fixture', 'session_execution']);
    assert.equal(byEvent.session_execution.sessionID, 'ses_exec');
    assert.equal(byEvent.primary_recovery_fixture.sessionID, 'ses_primary');
    assert.deepEqual(byEvent.opencode_client.payload, { phase: 'request', code: 'fixture' });
    await journal.drain();
    assert.equal(journal.summary().drained, true, 'Drain is idempotent');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('fixture journal counts an entry-supplied runtime under the label it is written with and refuses unsafe labels', async () => {
  const root = await temporary();
  try {
    const webDataDirectory = path.join(root, 'web-data');
    const journal = await createFixtureJournal({ webDataDirectory, label: 'fixture-lc-2' });
    journal.ownerDiagnostic({ type: 'lifecycle', event: 'own_runtime', runtime: 'controller' });
    journal.ownerDiagnostic({ type: 'lifecycle', event: 'fixture_runtime' });
    await journal.drain();
    assert.deepEqual(journal.summary().accepted, { controller: 1, 'fixture-lc-2': 1 });
    assert.deepEqual((await readAll(journal.journalDirectory)).map(row => row.runtime).sort(), ['controller', 'fixture-lc-2']);
    for (const label of ['web', 'fixture-', 'fixture-UPPER', `fixture-${'a'.repeat(23)}`]) {
      await assert.rejects(createFixtureJournal({ webDataDirectory, label }));
    }
    await assert.rejects(createFixtureJournal({ webDataDirectory: 'relative/web-data', label: 'fixture-x' }));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
