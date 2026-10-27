import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { compiledClaudeReply, readCompiledClaudeLeases } from './compiled-claude-execution.mjs';

test('compiled Claude fixture final packets terminate but cancellation fixture stays active', () => {
  const complete = compiledClaudeReply({ model: 'fixture', stream: true });
  assert.equal(complete.type, 'text/event-stream');
  const events = complete.body.split('\n\n').filter(Boolean).map(frame => JSON.parse(frame.split('\ndata: ')[1]));
  assert.equal(events.at(-1).type, 'message_stop');
  assert.ok(events.some(event => event.type === 'content_block_delta' && event.delta.text === 'DevRyan compiled Claude final.'));
  const held = compiledClaudeReply({ model: 'fixture', stream: true }, { held: true });
  assert.equal(held.body.includes('message_stop'), false);
  assert.equal(held.body.includes('message_delta'), false);
  assert.equal(JSON.parse(compiledClaudeReply({ model: 'fixture' }).body).stop_reason, 'end_turn');
});

test('compiled lease reader retains armed active writer records and refuses invalid lifecycle data', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-compiled-claude-lease-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const directory = path.join(home, '.cache/meridian'); await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, 'session-gc.json');
  const lease = { token: 'fixture', executor: { pid: 123 }, executorRecoverable: false };
  await fs.writeFile(file, JSON.stringify({ version: 2, resources: { resource: { activeLeases: { fixture: lease } }, idle: {} } }));
  assert.deepEqual(await readCompiledClaudeLeases(home), [lease]);
  await fs.writeFile(file, JSON.stringify({ version: 1, resources: {} }));
  await assert.rejects(readCompiledClaudeLeases(home));
});
