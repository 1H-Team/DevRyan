import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DevRyanDocumentReaderPlugin, __test as documentTest } from './devryan-document-reader.mjs';
import { DevRyanToolInputGuardPlugin } from './devryan-tool-input-guard.mjs';
import { __test, DevRyanHarnessContextPlugin } from './devryan-harness-context.mjs';
import { DevRyanSkillContextPlugin } from './devryan-skill-context.mjs';
import { resolveHarnessPolicies } from '@openchamber/orchestration-runtime';

const { projectObservations, pluginInventory } = __test();
const body = '<skill_content>Unique instructions 世界 \\"\n'.repeat(80) + '</skill_content>';
const skill = (id, output = body, name = 'Fixture') => ({ info: { id, role: 'assistant', sessionID: 'ses_root', providerID: 'openai' },
  parts: [{ type: 'tool', tool: 'skill', callID: `call_${id}`, state: { status: 'completed', input: { name }, output,
    metadata: { name, dir: '/fixture' }, time: { start: 1, end: 2 } } }] });
const managedBody = (status = 'failed') => JSON.stringify({ task: { taskId: 'dvr_task_a', rootSessionId: 'ses_root', status },
  resultEnvelope: { envelopeId: 'env_a' }, resultHeader: { schemaVersion: 1, taskId: 'dvr_task_a', envelopeId: 'env_a', outcome: { status },
    criticalFailures: ['Keep this failure. '.repeat(80)] } });
const managed = (id, output = managedBody()) => {
  const m = skill(id, output); m.parts[0].tool = 'devryan_task'; m.parts[0].state.input = { action: 'wait', taskId: 'dvr_task_a' };
  m.parts[0].state.metadata = {}; return m;
};
const user = (providerID = 'openai', modelID = 'fixture') => ({ info: { id: 'msg_user', sessionID: 'ses_root', role: 'user', model: { providerID, modelID } }, parts: [] });
const text = () => ({ info: { id: 'msg_text', role: 'assistant', sessionID: 'ses_root' }, parts: [{ type: 'text', text: 'Intervening work' }] });
const outputs = messages => messages.flatMap(m => m.parts.filter(p => p.type === 'tool').map(p => p.state.output));
const config = () => ({ plugin: [new URL('./devryan-harness-context.mjs', import.meta.url).href] });
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const disposals = [];
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); vi.unstubAllEnvs(); });
const setup = async (handle, policies = { duplicateOutputs: true, contextProjection: true }) => {
  vi.stubEnv('DEVRYAN_ORCHESTRATION_URL', 'http://127.0.0.1:12345/rpc');
  vi.stubEnv('DEVRYAN_ORCHESTRATION_TOKEN', 'synthetic-fixture');
  const calls = []; let now = 1;
  const plugin = await DevRyanHarnessContextPlugin({ directory: '/fixture', now: () => now, fetchImpl: async (_url, init) => {
    const request = JSON.parse(init.body); calls.push(request);
    const result = handle ? await handle(request) : request.method === 'harness_capabilities' ? { policies }
      : request.method === 'harness_duplicate_qualification' ? { qualified: true, ...request.params, ...request.params.inventory, profileId: 'fixture' }
        : { available: false };
    return Response.json({ ok: true, result });
  } });
  disposals.push(plugin.dispose); await plugin.config(config()); await flush();
  return { plugin, calls, tick: value => { now += value; }, transform: async (messages = [user(), skill('a'), skill('b')]) => {
    const out = { messages }; await plugin['experimental.chat.messages.transform']({}, out); return out;
  } };
};

describe('conservative duplicate projection', () => {
  it('keeps the first repeated synthetic instruction and references later identical copies', () => {
    const preface = 'Plan mode instruction. '.repeat(100);
    const planUser = (id, extra = []) => ({ info: { id, role: 'user', sessionID: 'ses_root' },
      parts: [{ type: 'text', synthetic: true, text: preface }, { type: 'text', text: `request ${id}` }, ...extra] });
    const first = planUser('u1'), second = planUser('u2'), third = planUser('u3');
    const request = [first, text(), second, third];
    const stats = projectObservations(request);
    expect(stats).toMatchObject({ appliedReductions: 2 });
    expect(request[0]).toBe(first);
    expect(request[0].parts[0].text).toBe(preface);
    for (const message of [request[2], request[3]]) {
      expect(message.parts[0].text).toContain('<devryan_instruction_reuse>');
      expect(message.parts[1].text).toMatch(/^request u/);
    }
    // Canonical records are untouched; a compaction boundary restarts the anchor.
    expect(second.parts[0].text).toBe(preface);
    const compacted = [first, { info: { id: 'c', role: 'assistant', sessionID: 'ses_root', summary: true }, parts: [] }, planUser('u4')];
    projectObservations(compacted);
    expect(compacted[2].parts[0].text).toBe(preface);
  });


  it.each([skill, managed])('mutates the consumed array, clones only changed records and preserves calls/canonical history', factory => {
    const canonical = [factory('a'), factory('b'), text(), factory('c'), factory('d')];
    const copy = structuredClone(canonical), request = [...canonical];
    expect(projectObservations(request)).toMatchObject({ appliedReductions: 2, plannedReductions: 2 });
    expect(canonical).toEqual(copy);
    expect(request[0]).toBe(canonical[0]); expect(request[2]).toBe(canonical[2]); expect(request[3]).toBe(canonical[3]);
    expect(request[1]).not.toBe(canonical[1]); expect(request[1].parts[0].state).not.toBe(canonical[1].parts[0].state);
    expect(request[1].parts[0].callID).toBe('call_b'); expect(request[1].parts[0].state.time).toBe(canonical[1].parts[0].state.time);
    expect(outputs(request)[2]).toBe(outputs(canonical)[2]);
    if (factory === managed) expect(JSON.parse(outputs(request)[3]).reference).toEqual({ messageID: 'c', callID: 'call_c' });
    expect(Buffer.byteLength(JSON.stringify(request))).toBeLessThan(Buffer.byteLength(JSON.stringify(canonical)));
    expect(projectObservations(request).appliedReductions).toBe(0);
  });
  it.each([skill, managed])('retains changed versions A/B/A and keeps an append-stable projected prefix', factory => {
    const a = factory('a'), b = factory('b'), c = factory('c', factory === skill ? body + ' changed' : managedBody('completed'));
    const history = [a, b, c, factory('d')], first = [...history]; projectObservations(first);
    expect(outputs(first)[2]).toBe(outputs([c])[0]); expect(outputs(first)[3]).toBe(outputs([a])[0]);
    const next = [...history, factory('e')]; projectObservations(next); expect(next.slice(0, 4)).toEqual(first);
  });
  it.each([
    part => { part.state.time.compacted = 1; }, part => { part.state.attachments = [{ type: 'file' }]; },
    part => { part.providerMetadata = { opaque: 'signed' }; }, part => { part.signature = 'signed'; },
    part => { part.state.metadata = { signature: 'signed' }; }, part => { part.state.status = 'running'; },
    part => { part.state.output = '🙂'.repeat(70_000); }, part => { part.callID = ''; },
  ])('rejects a protected or missing source', change => {
    const history = [skill('a'), skill('b')]; change(history[0].parts[0]);
    const before = structuredClone(history); expect(projectObservations(history).appliedReductions).toBe(0); expect(history).toEqual(before);
  });
  it('preserves tiny outputs, changed arguments/metadata, removed sources and unknown or mixed scopes', () => {
    for (const messages of [[skill('a', 'tiny'), skill('b', 'tiny')], [skill('a'), skill('b', body, 'Other')], [skill('b')],
      [{ ...skill('a'), info: { role: 'assistant' } }, skill('b')], [skill('a'), { ...skill('b'), info: { id: 'b', role: 'assistant', sessionID: 'other' } }]]) {
      expect(projectObservations(messages).appliedReductions).toBe(0);
    }
    const metadata = [skill('a'), skill('b')]; metadata[1].parts[0].state.metadata.dir = '/changed';
    expect(projectObservations(metadata).appliedReductions).toBe(0);
    const signed = [skill('a'), skill('b')]; signed[0].parts.push({ type: 'reasoning', text: 'opaque', providerMetadata: { signature: 'fixture' } });
    expect(projectObservations(signed).appliedReductions).toBe(0);
    const boundary = [skill('a'), { info: { id: 'summary', sessionID: 'ses_root', role: 'assistant', summary: true }, parts: [] }, skill('b')];
    expect(projectObservations(boundary).appliedReductions).toBe(0);
    const pruned = [managed('a'), managed('b')]; pruned[0].parts[0].state.time.compacted = 2;
    expect(projectObservations(pruned).appliedReductions).toBe(0);
  });
  it('preserves the reuse marker recognized by managed dispatch and leaves the standalone skill plugin inert', async () => {
    const messages = [skill('a'), skill('b')]; projectObservations(messages);
    expect(outputs(messages)[1]).toContain('<devryan_skill_reuse>');
    expect((await DevRyanSkillContextPlugin())['experimental.chat.messages.transform']).toBeUndefined();
  });
});

describe('managed gating and native summary isolation', () => {
  it('uses cached host qualification without blocking requests and checks model switches/config changes', async () => {
    const f = await setup();
    expect(outputs((await f.transform()).messages)[1]).toBe(body); await flush();
    const messages = [user(), skill('a'), skill('b')], out = await f.transform(messages);
    expect(out.messages).toBe(messages); expect(outputs(out.messages)[1]).toContain('<devryan_skill_reuse>');
    expect(outputs((await f.transform([user('other'), skill('a'), skill('b')])).messages)[1]).toBe(body);
    const changed = config(); await f.plugin.config(changed); changed.plugin.push('unknown');
    expect(outputs((await f.transform()).messages)[1]).toBe(body);
    expect(f.calls.find(call => call.params.phase === 'hook-applied').params.finalRequestBytes).toBeNull();
  });
  it('keeps checkpoint and duplicate policies independent and defaults all rollout switches off', async () => {
    expect(resolveHarnessPolicies({}).duplicateOutputs).toBe(false);
    expect(resolveHarnessPolicies({ DEVRYAN_TASK_CONTEXT_PROJECTION: '1', DEVRYAN_DUPLICATE_OUTPUTS: '0' }))
      .toMatchObject({ contextProjection: true, duplicateOutputs: false });
    const off = await setup(undefined, { contextProjection: true }); await off.transform(); await flush();
    expect(outputs((await off.transform()).messages)[1]).toBe(body);
    const on = await setup(undefined, { duplicateOutputs: true }); await on.transform(); await flush();
    expect(outputs((await on.transform()).messages)[1]).toContain('<devryan_skill_reuse>');
    vi.stubEnv('DEVRYAN_ORCHESTRATION_TOKEN', ''); expect(await DevRyanHarnessContextPlugin()).toEqual({});
  });
  it('does not wait for unresolved capability discovery before passing a request through', async () => {
    let resolve;
    const f = await setup(() => new Promise(done => { resolve = done; }));
    expect(outputs((await f.transform()).messages)[1]).toBe(body);
    expect(f.calls).toHaveLength(1);
    resolve({ policies: { duplicateOutputs: false } }); await flush();
  });
  it('backs off optional failures for 30 seconds while required checks still retry and fail closed', async () => {
    const f = await setup(() => { throw new Error('fixture unavailable'); });
    const initial = f.calls.length; await f.transform(); await f.transform(); expect(f.calls.length).toBe(initial);
    f.tick(30_000); await f.transform(); await flush(); expect(f.calls.length).toBe(initial + 1);
    await expect(f.plugin['tool.execute.before']({ tool: 'bash' }, { args: { command: 'check' } }))
      .rejects.toMatchObject({ code: 'managed_check_observer_unavailable' });
    expect(f.calls.length).toBe(initial + 2);
  });
  it('suppresses before async checkpoint work, keeps other sessions independent, and consumes two summary boundaries', async () => {
    let release;
    const f = await setup(({ method, params }) => method === 'harness_capabilities' ? { policies: { duplicateOutputs: true, contextProjection: true } }
      : method === 'harness_duplicate_qualification' ? { qualified: true, ...params, ...params.inventory }
        : method === 'harness_context' ? new Promise(resolve => { release = resolve; }) : {});
    await f.transform(); await flush();
    for (let i = 0; i < 2; i++) {
      const compacting = f.plugin['experimental.session.compacting']({ sessionID: 'ses_root' }, { context: [] });
      const summary = await f.transform(); expect(outputs(summary.messages)[1]).toBe(body);
      await flush(); release({ available: false }); await compacting;
      const other = [user(), skill('a'), skill('b')].map(m => ({ ...m, info: { ...m.info, sessionID: 'ses_other' } }));
      expect(outputs((await f.transform(other)).messages)[1]).toContain('<devryan_skill_reuse>');
      expect(outputs((await f.transform()).messages)[1]).toContain('<devryan_skill_reuse>');
    }
  });
  it('leaves a failed/cancelled summary marker pending until an unambiguous same-session transform and cleans up deletion', async () => {
    const f = await setup(); await f.transform(); await flush();
    await f.plugin['experimental.session.compacting']({ sessionID: 'ses_root' }, { context: [] });
    await f.transform([user(), { ...skill('a'), info: { id: 'a', role: 'assistant' } }]);
    expect(outputs((await f.transform()).messages)[1]).toBe(body);
    expect(outputs((await f.transform()).messages)[1]).toContain('<devryan_skill_reuse>');
    await f.plugin['experimental.session.compacting']({ sessionID: 'ses_root' }, { context: [] });
    f.plugin.event({ event: { type: 'session.deleted', properties: { info: { id: 'ses_root' } } } });
    expect(outputs((await f.transform()).messages)[1]).toContain('<devryan_skill_reuse>');
    f.plugin.dispose(); expect(outputs((await f.transform()).messages)[1]).toBe(body);
  });
  it('keeps ordinary headroom through a suppressed summary transform and its system hook', async () => {
    const f = await setup(); await f.transform(); await flush();
    const ordinary = [user(), skill('usage')];
    ordinary[1].info.modelID = 'fixture'; ordinary[1].info.tokens = { input: 400, output: 50, cache: { read: 100 } };
    const model = { providerID: 'openai', id: 'fixture', limit: { input: 800 } };
    await f.transform(ordinary); await f.plugin['experimental.chat.system.transform']({ sessionID: 'ses_root', model }, { system: ['Stable'] });
    await f.plugin['experimental.session.compacting']({ sessionID: 'ses_root' }, { context: [] });
    await f.transform([user(), skill('head')]);
    await f.plugin['experimental.chat.system.transform']({ sessionID: 'ses_root', model: {} }, { system: ['Summary'] });
    // The checkpoint tool response uses the ordinary snapshot, despite the
    // native compactor's smaller selected head and different model.
    const out = { output: JSON.stringify({ available: true, checkpoint: { sessionID: 'ses_root' } }) };
    await f.plugin['tool.execute.after']({ tool: 'devryan_task', sessionID: 'ses_root', args: { action: 'checkpoint' } }, out);
    expect(JSON.parse(out.output).headroom).toMatchObject({ previousRequestInputTokens: 500, estimatedHeadroomTokens: 250, sourceMessageID: 'usage' });
  });
  it('composes with the document-reader and input-guard mutations in either order', async () => {
    const base = path.resolve('../../.cache/qa'); fs.mkdirSync(base, { recursive: true });
    const root = fs.mkdtempSync(path.join(base, 'duplicate-composition-'));
    vi.stubEnv('DEVRYAN_OPENCODE_USER_CONFIG_DIR', root);
    try {
      const document = await DevRyanDocumentReaderPlugin({ parseAttachment: documentTest.parseAttachmentPayload });
      const guard = await DevRyanToolInputGuardPlugin({ directory: root }, { dataDir: root });
      const f = await setup(); await f.transform(); await flush();
      for (const first of [true, false]) {
        const canonical = [user(), skill('a'), skill('b')];
        canonical[0].parts.push({ type: 'file', filename: 'fixture.txt', mime: 'text/plain', sessionID: 'ses_root', messageID: 'msg_user',
          url: `data:text/plain;base64,${Buffer.from('Unique attachment evidence').toString('base64')}` });
        const read = skill('read', `header${'\uFFFD\u0001'.repeat(40)}`); read.parts[0].tool = 'read'; read.parts[0].state.input = { filePath: '/fixture/payload.data' };
        canonical.push(read);
        const request = structuredClone(canonical), out = { messages: request };
        if (first) await f.plugin['experimental.chat.messages.transform']({}, out);
        await document['experimental.chat.messages.transform']({}, out); await guard['experimental.chat.messages.transform']({}, out);
        if (!first) await f.plugin['experimental.chat.messages.transform']({}, out);
        expect(out.messages).toBe(request); expect(request[0].parts[0].text).toContain('Unique attachment evidence');
        expect(request[2].parts[0].state.output).toContain('<devryan_skill_reuse>');
        expect(request[3].parts[0].state.output).not.toContain('\u0001');
        expect(canonical[0].parts[0].type).toBe('file'); expect(canonical[2].parts[0].state.output).toBe(body);
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it('computes an ordered content inventory and rejects unresolved sources or plugin options', () => {
    expect(pluginInventory(config()).entries[0].contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(pluginInventory({ plugin: [['file:///fixture/plugin.mjs', {}]] })).toBeNull();
    expect(pluginInventory({ plugin: ['custom@latest'] })).toBeNull();
  });
});
