import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { createQaChangeProofScript } from './fixture-session-change-proof.mjs';

test('isolated UI fixture fences origin, session, directory, revision, proof and direction', async () => {
  const origin = 'http://127.0.0.1:32100', forwarded = [];
  const context = vm.createContext({ URL, Request, Response, location: { origin, href: `${origin}/` },
    fetch: async (...args) => { forwarded.push(args); return Response.json({ forwarded: true }); } });
  const summary = { revision: '1'.repeat(64), coverage: 'complete', fileCount: 1 };
  vm.runInContext(createQaChangeProofScript({ origin, sessionID: 'ses_owned', directory: '/qa', summary }), context);
  const path = '/api/devryan/session/ses_owned/changes?directory=%2Fqa';
  const first = await (await context.fetch(path)).json();
  assert.equal(first.restoreProof.digest, 'a'.repeat(64));
  const post = (action, body) => context.fetch(`/api/devryan/session/ses_owned/changes/${action}?directory=%2Fqa`, { method: 'POST', body: JSON.stringify(body) });
  assert.equal((await post('undo', { revision: first.revision })).status, 409);
  assert.equal((await post('undo', { revision: first.revision, restoreProof: first.restoreProof })).status, 200);
  const second = await (await context.fetch(path)).json();
  assert.equal(second.undone, true); assert.notEqual(second.revision, first.revision); assert.notEqual(second.restoreProof.digest, first.restoreProof.digest);
  assert.equal((await post('redo', { revision: first.revision, restoreProof: first.restoreProof })).status, 409);
  assert.equal((await post('redo', { revision: second.revision, restoreProof: second.restoreProof })).status, 200);
  await assert.rejects(context.fetch(path.replace('%2Fqa', '%2Fforeign')), /scope mismatch/);
  await context.fetch('/api/devryan/session/ses_foreign/changes?directory=%2Fqa'); assert.equal(forwarded.length, 1);
  context.__devryanQaChangeProof.restore(); await context.fetch(path); assert.equal(forwarded.length, 2);
  assert.throws(() => createQaChangeProofScript({ origin: 'https://example.com', sessionID: 'ses_owned', directory: '/qa', summary }), /false|Assertion/);
});

test('fixture rejects a stale token once and accepts only the refreshed proof', async () => {
  const origin = 'http://127.0.0.1:32100';
  const context = vm.createContext({ URL, Request, Response, location: { origin, href: `${origin}/` }, fetch: async () => Response.json({}) });
  vm.runInContext(createQaChangeProofScript({ origin, sessionID: 'ses_owned', directory: '/qa', summary: { revision: '1'.repeat(64) } }), context);
  const path = '/api/devryan/session/ses_owned/changes?directory=%2Fqa';
  const initial = await (await context.fetch(path)).json(); context.__devryanQaChangeProof.staleNext = true;
  const post = body => context.fetch('/api/devryan/session/ses_owned/changes/undo?directory=%2Fqa', { method: 'POST', body: JSON.stringify(body) });
  assert.equal((await post({ revision: initial.revision, restoreProof: initial.restoreProof })).status, 409);
  const refreshed = await (await context.fetch(path)).json();
  assert.notEqual(refreshed.revision, initial.revision); assert.notEqual(refreshed.restoreProof.digest, initial.restoreProof.digest);
  assert.equal((await post({ revision: initial.revision, restoreProof: initial.restoreProof })).status, 409);
  assert.equal((await post({ revision: refreshed.revision, restoreProof: refreshed.restoreProof })).status, 200);
});
