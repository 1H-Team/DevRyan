import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { prepareSourceImageAccounts } from './package-image-oauth-process.mjs';
import { credentialMutationFingerprint } from '../../packages/web/server/lib/opencode/runtime-host/native-credential-mutation-owner.js';
import { createV2MessageId } from '../../packages/web/server/lib/opencode/v2/admission.js';
import { assertWriterOutcome, toolTurn } from './assertions.mjs';
import { assertNativeCancellationSettled, waitFor } from './process-lanes.mjs';
import { readSessionExecutionReceipt } from '../../packages/harness-runtime/lib/session-execution.js';

const imageEndpoint = 'https://chatgpt.com/backend-api/codex/responses';
const refreshEndpoint = 'https://auth.openai.com/oauth/token';
let activeCapture;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const imagePNG = () => {
  const crc = bytes => { let value = 0xffffffff; for (const byte of bytes) {
    value ^= byte; for (let i = 0; i < 8; i++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  } return (value ^ 0xffffffff) >>> 0; };
  const chunk = (name, bytes) => {
    const body = Buffer.concat([Buffer.from(name), bytes]), output = Buffer.alloc(bytes.length + 12);
    output.writeUInt32BE(bytes.length); body.copy(output, 4); output.writeUInt32BE(crc(body), output.length - 4); return output;
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(8); header.writeUInt32BE(8, 4); header[8] = 8; header[9] = 6;
  const pixels = Buffer.alloc(8 * 33, 255); for (let y = 0; y < 8; y++) pixels[y * 33] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
};

/** Synthetic OAuth is acquired in a separate source-SDK child against the
 * quiesced owned database. The compiled controller never gets an endpoint override.
 * The existing Node transports capture this finite fetch at each controller start. */
export function createCompiledImageLane({ root, getOwnedOrigins }) {
  assert.ok(path.isAbsolute(root)); assert.equal(typeof getOwnedOrigins, 'function');
  const originalFetch = globalThis.fetch, png = imagePNG(), records = [], streams = new Set();
  const access = new Map(['A', 'B'].map(account => [account, `owned-image-access-${account}`]));
  let prepared, capturing = false, closed = false, expected, refreshes = 0, cancelled = 0;
  const arm = (input, account, { references = [], hold = false } = {}) => {
    assert.equal(expected, undefined, 'Previous physical image attempt remains unconsumed');
    expected = { input, account, references, hold, entered: Promise.withResolvers() }; return expected.entered.promise;
  };
  const transport = async (url, init) => {
    assert.equal(closed, false, 'Fixture transport used after close');
    const target = String(url);
    if (target === refreshEndpoint) {
      assert.ok(prepared); assert.equal(init?.method, 'POST'); assert.equal(init.redirect, 'error');
      const body = new URLSearchParams(init.body);
      assert.equal(body.get('grant_type'), 'refresh_token'); assert.equal(body.get('refresh_token'), 'owned-image-refresh-B');
      assert.ok(body.get('client_id')); assert.deepEqual([...body.keys()].sort(), ['client_id', 'grant_type', 'refresh_token']);
      assert.equal(++refreshes, 1, 'Synthetic account refresh repeated');
      access.set('B', 'owned-image-access-B-refreshed'); records.push({ phase: 'refresh', account: 'B' });
      return Response.json({ access_token: access.get('B'), refresh_token: 'owned-image-refresh-B-rotated', expires_in: 3600 });
    }
    if (target === imageEndpoint) {
      assert.ok(expected, 'Unexpected or repeated physical image attempt'); const plan = expected; expected = undefined;
      assert.equal(init?.method, 'POST'); assert.equal(init.redirect, 'error'); init.signal.throwIfAborted();
      const headers = new Headers(init.headers);
      assert.equal(headers.get('Authorization'), `Bearer ${access.get(plan.account)}`);
      assert.equal(headers.get('ChatGPT-Account-Id'), `owned-image-account-${plan.account}`);
      const body = JSON.parse(init.body);
      assert.equal(body.model, 'gpt-6-astra'); assert.deepEqual(body.reasoning, { effort: 'medium' });
      assert.equal(body.stream, true); assert.equal(body.store, false); assert.deepEqual(body.tool_choice, { type: 'image_generation' });
      assert.deepEqual(body.tools, [{ type: 'image_generation', output_format: 'png', quality: plan.input.quality,
        ...(plan.input.size ? { size: plan.input.size } : {}) }]);
      assert.deepEqual(body.input, [{ role: 'user', content: [{ type: 'input_text', text: plan.input.prompt },
        ...plan.references.map(image_url => ({ type: 'input_image', image_url }))] }]);
      records.push({ phase: 'image', account: plan.account, references: plan.references.length, held: plan.hold });
      plan.entered.resolve();
      if (!plan.hold) return new Response(`data: ${JSON.stringify({ type: 'response.output_item.done', item: {
        type: 'image_generation_call', result: png.toString('base64') } })}\n\ndata: [DONE]\n\n`,
      { headers: { 'Content-Type': 'text/event-stream' } });
      return new Response(new ReadableStream({ start(controller) {
        const state = { done: false, abort: () => { if (!state.done) { state.done = true; streams.delete(state); cancelled++; controller.error(init.signal.reason); } } };
        streams.add(state); init.signal.addEventListener('abort', state.abort, { once: true });
        state.remove = () => { if (!state.done) { state.done = true; cancelled++; } streams.delete(state); init.signal.removeEventListener('abort', state.abort); };
        if (init.signal.aborted) state.abort();
      }, cancel() { for (const state of [...streams]) state.remove(); } }), { headers: { 'Content-Type': 'text/event-stream' } });
    }
    const parsed = new URL(target), origins = getOwnedOrigins();
    assert.ok(parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
      && origins.includes(parsed.origin), 'Image fixture denied non-owned transport');
    return originalFetch(url, init);
  };
  const metadata = (owner, directory) => {
    const configuration = owner.getConfigurationSnapshot().locations.find(row => row.directory === directory)?.configuration;
    assert.ok(configuration);
    return owner.credentialMetadata({ kind: 'openai', directory, integrationID: 'openai',
      configurationDigest: credentialMutationFingerprint(configuration.providers?.openai ?? {}),
      operation: 'openai.integration', method: 'GET', path: '/api/integration/openai' });
  };
  const lane = {
    prepare: async ({ databasePath, directory }) => {
      assert.equal(prepared, undefined); assert.equal(closed, false);
      prepared = await prepareSourceImageAccounts({ root, databasePath, directory }); return prepared;
    },
    withCapturedTransport: async action => {
      assert.ok(prepared); assert.equal(closed, false); assert.equal(capturing, false); assert.equal(activeCapture, undefined);
      capturing = true; activeCapture = transport; globalThis.fetch = transport;
      try { return await action(); }
      finally {
        const unchanged = globalThis.fetch === transport; globalThis.fetch = originalFetch;
        capturing = false; activeCapture = undefined; assert.equal(unchanged, true, 'Captured transport scope was replaced');
      }
    },
    captureRestarts: owner => {
      assert.equal(typeof owner.start, 'function');
      const start = owner.start.bind(owner);
      owner.start = () => lane.withCapturedTransport(start);
    },
    run: async ({ invoke, client, directory, executionHost, managed, runtimeOwner, databasePath, environment, observations, provider }) => {
      assert.ok(prepared); assert.equal(capturing, false); assert.equal(globalThis.fetch, originalFetch);
      const [accountA, accountB] = prepared.proof.accounts;
      const before = await metadata(runtimeOwner, directory);
      const selectedB = before.find(row => row.id === accountB.credentialID);
      assert.ok(selectedB?.active && selectedB.valueType === 'oauth' && selectedB.methodID === 'chatgpt-headless');
      const session = await client.sessions.create({ title: 'Compiled owned image fixture', agent: 'orchestrator',
        model: { providerID: 'devryan-smoke', modelID: 'smoke-write' } }, { directory });
      await managed.admitPrimary(session.id);
      const input = { prompt: 'A tiny isolated local fixture raster.', out: 'compiled-image.png', quality: 'high', size: '1024x1024' };
      arm(input, 'B');
      const first = await invoke({ id: 'compiled-image-refresh-B', tool: 'gpt_imagegen', input }, { sessionID: session.id });
      await assertWriterOutcome({ runtime: executionHost.runtime, directory, sessionID: session.id, callID: first.callID, observations, succeeded: true });
      assert.equal(refreshes, 1); assert.equal(expected, undefined);
      const file = path.join(directory, input.out); assert.deepEqual(await fs.readFile(file), png);
      assert.equal(first.state.metadata.out, file); assert.equal(first.state.metadata.versioned, false);
      assert.ok(first.state.output.includes(file)); assert.ok(!first.state.output.includes('/worktree'));
      const updatedB = (await metadata(runtimeOwner, directory)).find(row => row.id === accountB.credentialID);
      assert.ok(updatedB?.active); assert.notEqual(updatedB.expectedFingerprint, selectedB.expectedFingerprint,
        'Actual native refresh did not persist its changed credential record');
      const account = (await metadata(runtimeOwner, directory)).find(row => row.id === accountA.credentialID);
      assert.ok(account && account.valueType === 'oauth' && account.methodID === 'chatgpt-headless');
      const configuration = runtimeOwner.getConfigurationSnapshot().locations.find(row => row.directory === directory).configuration;
      await runtimeOwner.credentialOperation({ kind: 'openai', directory, integrationID: 'openai',
        configurationDigest: credentialMutationFingerprint(configuration.providers?.openai ?? {}),
        operation: 'openai.credential.activate', method: 'POST', path: `/api/credential/${account.id}/activate`,
        valueType: 'oauth', methodID: account.methodID, credentialID: account.id, expectedFingerprint: account.expectedFingerprint,
        requestedFingerprint: credentialMutationFingerprint({ id: account.id }) }, { operation: 'activate', id: account.id });
      assert.equal((await metadata(runtimeOwner, directory)).find(row => row.active)?.id, accountA.credentialID);
      const reference = 'data:image/png;base64,' + png.toString('base64');
      const nextInput = { ...input, prompt: 'Use image one as the exact local fixture reference.', images: [input.out] };
      arm(nextInput, 'A', { references: [reference] });
      const second = await invoke({ id: 'compiled-image-switch-A', tool: 'gpt_imagegen', input: nextInput }, { sessionID: session.id });
      await assertWriterOutcome({ runtime: executionHost.runtime, directory, sessionID: session.id, callID: second.callID, observations, succeeded: true });
      const secondFile = path.join(directory, 'compiled-image-v2.png');
      assert.deepEqual(await fs.readFile(file), png); assert.deepEqual(await fs.readFile(secondFile), png);
      assert.equal(second.state.metadata.out, secondFile); assert.equal(second.state.metadata.versioned, true);
      const cancelInput = { ...input, out: 'compiled-image-cancelled.png', prompt: 'Hold this isolated fixture image for cancellation.' };
      const held = arm(cancelInput, 'A', { hold: true });
      const turn = toolTurn('gpt_imagegen', cancelInput, 'compiled-image-cancel'); await provider.setResponder(turn.responder);
      await client.prompts.prompt(session.id, { messageID: createV2MessageId(), agent: 'orchestrator', variant: 'default',
        model: { providerID: 'devryan-smoke', modelID: 'smoke-write' }, parts: [{ type: 'text', text: turn.marker }] },
      { directory, origin: 'native_acceptance', timeoutMs: 30_000 });
      let timer;
      try { await Promise.race([held, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(Error('Compiled image never reached its held physical attempt')), 30_000); })]); }
      finally { clearTimeout(timer); }
      await executionHost.executions.cancelAndWait({ directory, sessions: [session.id] });
      await waitFor(async () => cancelled, count => count === 1, 'Compiled image transport did not observe owned cancellation');
      await assertNativeCancellationSettled({ databasePath, environment, sessionID: session.id, callID: turn.callID, observations });
      const lease = await executionHost.runtime.leaseForCall({ directory, sessionID: session.id, callID: turn.callID });
      assert.equal(lease.state, 'cancelled'); const receipt = await readSessionExecutionReceipt(lease);
      assert.ok(receipt.terminated && receipt.confined && receipt.cancelled);
      await assert.rejects(fs.stat(path.join(directory, cancelInput.out)), error => error.code === 'ENOENT');
      assert.deepEqual(await executionHost.runtime.activeLeases({ directory, sessions: [session.id] }), []);
      assert.deepEqual(records, [{ phase: 'refresh', account: 'B' }, { phase: 'image', account: 'B', references: 0, held: false },
        { phase: 'image', account: 'A', references: 1, held: false }, { phase: 'image', account: 'A', references: 0, held: true }]);
      return [{ id: 'compiled-image-native-refresh-account-switch-publication', status: 'passed', sessionID: session.id,
        credentialIDs: [accountA.credentialID, accountB.credentialID], sourceOAuthCreation: true, compiledOAuthCreation: false,
        sourceProofPath: prepared.proofPath, sourceInputHashes: prepared.inputHashes, refreshes,
        callIDs: [first.callID, second.callID], files: [input.out, path.basename(secondFile)], sha256: sha(png) },
      { id: 'compiled-image-owned-cancellation-no-publication', status: 'passed', sessionID: session.id,
        callID: turn.callID, receipt, cancelled, nativeClaimReleased: true }];
    },
    close: async () => { assert.equal(capturing, false); assert.equal(streams.size, 0); assert.equal(expected, undefined); closed = true; },
  };
  return lane;
}
