import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { assertNativeCancellationSettled } from './process-lanes.mjs';

const runFile = promisify(execFile);
test('native cancellation query binds exact assistant call and its later idle', async () => {
  const root = await fs.mkdtemp(path.resolve('.cache/v2-validation/tmp/cancel-native-query-'));
  const databasePath = path.join(root, 'native.db');
  try {
    const data = JSON.stringify({ time: { completed: 1000 }, error: { type: 'aborted' },
      content: [{ type: 'tool', id: 'native_cancel-write-transform', state: { error: { type: 'aborted' } } }] });
    await runFile('/usr/bin/sqlite3', [databasePath, `
      CREATE TABLE session_v2(id TEXT,idle_outcome TEXT,time_suspended INTEGER,resume_attempts INTEGER);
      CREATE TABLE session_message(id TEXT,session_id TEXT,type TEXT,seq INTEGER,data TEXT);
      INSERT INTO session_v2 VALUES('ses_fixture','interrupted',NULL,0);
      INSERT INTO session_message VALUES('msg_old','ses_fixture','idle',9,'{"outcome":"succeeded"}');
      INSERT INTO session_message VALUES('msg_exact','ses_fixture','assistant',10,'${data}');
      INSERT INTO session_message VALUES('msg_idle','ses_fixture','idle',11,'{"outcome":"interrupted"}');`]);
    const observations = [];
    const result = await assertNativeCancellationSettled({ databasePath, environment: process.env,
      sessionID: 'ses_fixture', callID: 'native_cancel-write-transform', observations });
    assert.equal(result.assistantID, 'msg_exact'); assert.equal(result.idleID, 'msg_idle');
    assert.equal(observations[0].phase, 'native_cancellation_settled');
    await assert.rejects(assertNativeCancellationSettled({ databasePath, environment: process.env,
      sessionID: "ses_fixture';DROP TABLE session_v2;", callID: 'native_cancel-write-transform', observations }));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
