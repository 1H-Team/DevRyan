import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runCompiledModelTitle } from './package-model-title-lane.mjs';

const fixture = async (reply, action) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-model-title-gate-')));
  const directory = root;
  let responder, modelCalls = 0, renameCalls = 0, controllerID = 'original';
  const sessions = new Map(), sources = new Map(), enrolled = new Set();
  const provider = { setResponder: async next => { responder = next; } };
  const client = { generation: () => 2, sessions: {
    create: async input => {
      const session = { id: sessions.size ? 'ses_pendingtitle' : 'ses_title', directory, title: input.title };
      sessions.set(session.id, session); return { ...session };
    }, get: async id => ({ ...sessions.get(id) }),
    status: async () => ({}), messages: async id => ({ records: [
      { info: { id: sources.get(id).id, role: 'user' }, parts: [{ type: 'text', text: sources.get(id).text }] },
      { info: { id: 'msg_assistant', role: 'assistant', time: { completed: 1 } }, parts: [{ type: 'text', text: 'Completed' }] },
    ] }),
  }, prompts: { prompt: async (id, input, options) => {
    assert.equal(enrolled.has(id), true, 'Human source must be enrolled before prompt admission');
    assert.equal(options.origin, 'human');
    sources.set(id, { id: input.messageID, text: input.parts[0].text });
    await responder({ body: { messages: [{ role: 'user', content: input.parts[0].text }] } });
  } } };
  const runtimeOwner = {
    checkpointController: () => ({ instanceID: controllerID }),
    resolveHelperSelection: async () => ({ providerID: 'devryan-smoke', modelID: 'smoke-write', selectionRevision: 'compiled-fixture' }),
    generateHelperText: async input => {
      modelCalls++; assert.equal(input.selectionMode, 'configured'); assert.equal(Object.hasOwn(input, 'variant'), false);
      await responder({ body: { messages: [{ role: 'user', content: input.prompt }] } });
      return { text: reply && input.sessionID === 'ses_pendingtitle' ? 'Pending Compiled Session Title' : reply };
    },
    renameGeneratedTitle: async input => {
      renameCalls++;
      const session = sessions.get(input.sessionID);
      assert.equal(input.expectedTitle, session.title); assert.equal(input.sourceMessageID, sources.get(input.sessionID).id);
      session.title = input.title;
    },
  };
  try { await action({ input: { runtimeOwner, client, provider, directory, root, getRuntimeOwner: () => runtimeOwner,
    enrollPrimary: async sessionID => { assert.ok(sessions.has(sessionID)); assert.equal(enrolled.has(sessionID), false); enrolled.add(sessionID); } },
    read: () => ({ title: sessions.get('ses_title')?.title, modelCalls, renameCalls }),
    setTitle: next => { sessions.get('ses_title').title = next; }, restart: () => { controllerID = 'replacement'; } }); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
};

test('shipping title gate rejects derived-only evidence even if a local candidate can persist', () => fixture('', async ({ input }) => {
  await assert.rejects(runCompiledModelTitle(input), /derived-only title cannot qualify shipping/);
}));

test('shipping title gate refuses a missing primary enrollment owner', () => fixture('Durable Compiled Helper Title', async ({ input }) => {
  await assert.rejects(runCompiledModelTitle({ ...input, enrollPrimary: undefined }), /constructor-owned fixture root enrollment/);
}));

test('shipping title gate restores both a persisted title and the exact pending candidate through replacement authority', () => fixture('Durable Compiled Helper Title', async ({ input, read, setTitle, restart }) => {
  const proof = await runCompiledModelTitle(input);
  assert.deepEqual(read(), { title: 'Durable Compiled Helper Title', modelCalls: 2, renameCalls: 1 });
  setTitle('Restart lost this title');
  await assert.rejects(proof.assertRestored(), /restart lost the persisted model title/);
  setTitle('Durable Compiled Helper Title');
  await assert.rejects(proof.assertRestored(), /Pending title requires a replacement controller/);
  restart();
  const evidence = await proof.assertRestored();
  assert.equal(evidence.id, 'compiled-model-title-persist-once-restart-restore');
  assert.equal(evidence.renameCount, 1); assert.equal(evidence.helperRequests, 1);
  assert.equal(evidence.pendingRestoration.helperRequests, 1); assert.equal(evidence.pendingRestoration.renameCount, 1);
  assert.equal(evidence.pendingRestoration.fixtureRefusals, 1); assert.equal(evidence.pendingRestoration.pendingAttemptCount, 1);
  assert.equal(evidence.pendingRestoration.outboxCleared, true);
  assert.notEqual(evidence.pendingRestoration.originalControllerID, evidence.pendingRestoration.replacementControllerID);
  assert.match(evidence.pendingRestoration.sourceHash, /^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(evidence, 'title'), false);
  assert.deepEqual(read(), { title: 'Durable Compiled Helper Title', modelCalls: 2, renameCalls: 2 });
}));

test('pending title qualification refuses a changed durable source identity after replacement', () => fixture('Durable Compiled Helper Title', async ({ input, restart }) => {
  const proof = await runCompiledModelTitle(input);
  const file = path.join(input.root, 'pending-model-title-outbox.json');
  const outbox = JSON.parse(await fs.readFile(file, 'utf8'));
  outbox.jobs[0].sourceMessageID = 'msg_changed';
  await fs.writeFile(file, JSON.stringify(outbox));
  restart();
  await assert.rejects(proof.assertRestored(), /changed the retained pending candidate or its original source/);
}));
