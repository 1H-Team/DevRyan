import { createNativeConsumerFixture } from './test-native-consumer-client.js';
const createHarnessTaskContextHost = (options = {}) => createHarnessTaskContextHostNative({
  ...options, openCodeClient: options.openCodeClient ?? createNativeConsumerFixture({
    readFixture: options.fetchImpl ?? ((...args) => globalThis.fetch(...args)), headers: options.getOpenCodeAuthHeaders,
  }),
});
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatManagedAssignmentContext } from '@openchamber/orchestration-runtime';
import { createHarnessTaskContextHost as createHarnessTaskContextHostNative } from './harness-task-context.js';

describe('native canonical task-context adapter', () => {
  let directory, host, enabled, primary, routes, requests, owners;
  const scope = { sessionID: 'ses_root', directory: '/project' };
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-context-host-'));
    enabled = true; requests = []; owners = { ses_root: 'user:a' };
    primary = { sessionID: scope.sessionID, directory: scope.directory, anchorID: 'msg_user', state: 'completed' };
    routes = {
      '/session/ses_root': { id: 'ses_root', directory: '/project', projectID: 'project_a' },
      '/project/current': { id: 'project_a', worktree: '/project' },
      '/session/ses_root/message/msg_user': { info: { id: 'msg_user', sessionID: 'ses_root', role: 'user' },
        parts: [{ type: 'text', text: 'Keep dependencies unchanged.' }] },
      '/session/ses_root/todo': [],
    };
    host = createHarnessTaskContextHost({ dataDirectory: directory,
      buildOpenCodeUrl: pathname => `http://127.0.0.1:3000${pathname}`,
      readPrimaryRecord: async () => primary,
      getManagedRuntime: () => ({ handleRpc: async input => input.method === 'harness_capabilities'
        ? { policies: { contextProjection: enabled } }
        : input.method === 'child_assignment'
          ? { text: input.params.childSessionId === 'ses_root' ? formatManagedAssignmentContext({ taskId: 'dvr_task_child',
            rootSessionId: 'ses_parent', agent: 'fixer', label: 'Fix', prompt: '😀\u0001"\\'.repeat(8_000), readOnly: true },
          { maxBytes: input.params.maxBytes }) : null }
          : { tasks: [], envelopes: [] } }),
      compactionAnchorEnabled: true,
      sessionOwnerKey: async sessionID => owners[sessionID] ?? null,
      fetchImpl: async raw => {
        const url = new URL(raw); requests.push({ pathname: url.pathname, directory: url.searchParams.get('directory') });
        const value = routes[url.pathname];
        return value instanceof Response ? value : Response.json(value ?? null, { status: value === undefined ? 404 : 200 });
      },
    });
  });
  afterEach(async () => { await host.drain(); await fs.rm(directory, { recursive: true, force: true }); });
  const checkpoint = () => host.handleRpc({ action: 'checkpoint', ...scope });

  it('keeps a disabled policy inert and derives an enabled checkpoint from the durable user anchor', async () => {
    enabled = false;
    expect(await checkpoint()).toEqual({ available: false, reason: 'harness_policy_disabled' });
    expect(requests).toEqual([]);
    enabled = true;
    const result = await checkpoint();
    expect(result).toMatchObject({ available: true, checkpoint: { anchor: { messageID: 'msg_user', objective: 'Keep dependencies unchanged.' } } });
    expect(requests.every(request => request.directory === scope.directory)).toBe(true);
    expect(requests.some(request => request.pathname === '/session/ses_root/message/msg_user')).toBe(true);
  });
  it.each(['session', 'project', 'directory'])('rejects mismatched canonical %s scope before reading task details', async field => {
    if (field === 'session') routes['/session/ses_root'].id = 'ses_other';
    if (field === 'project') routes['/project/current'].id = 'project_other';
    if (field === 'directory') routes['/session/ses_root'].directory = '/other';
    await expect(checkpoint()).rejects.toThrow('context_project_scope_mismatch');
    expect(requests.some(request => request.pathname.includes('/message/'))).toBe(false);
  });
  it('does not invent an objective from a missing owner or a different message', async () => {
    primary = null;
    await expect(checkpoint()).rejects.toThrow('context_objective_owner_unavailable');
    primary = { sessionID: scope.sessionID, directory: scope.directory, anchorID: 'msg_user' };
    routes['/session/ses_root/message/msg_user'].info.id = 'msg_other';
    await expect(checkpoint()).rejects.toThrow('context_message_scope_mismatch');
  });
  it('rejects missing or oversized canonical sources without replacing stored history', async () => {
    delete routes['/session/ses_root/todo'];
    await expect(checkpoint()).rejects.toThrow('context_canonical_source_unavailable');
    routes['/session/ses_root/todo'] = new Response(' '.repeat(8 * 1024 * 1024 + 1));
    await expect(checkpoint()).rejects.toThrow('context_canonical_source_unavailable');
  });
  it('leaves children on their dispatch brief and does not read the parent objective for them', async () => {
    routes['/session/ses_root'].parentID = 'ses_parent';
    expect(await checkpoint()).toEqual({ available: false, reason: 'child_uses_its_dispatch_brief' });
    expect(requests.some(request => request.pathname.includes('/message/'))).toBe(false);
  });
  it('builds a compaction anchor with the policy disabled, including the approved plan outline', async () => {
    enabled = false;
    routes['/session/ses_root'] = { ...routes['/session/ses_root'], slug: 'calm-river', time: { created: 1700000000000 } };
    routes['/session/ses_root/message/msg_user'].parts.push({ type: 'text', synthetic: true,
      text: '[openchamber-plan-action:v1] {"action":"implement","sourceSessionId":"ses_root","sourceMessageId":"msg_plan","planIndex":0}' });
    const { resolveSessionPlanRevision } = await import('../plans/routes.js');
    const revision = await resolveSessionPlanRevision({ dataDirectory: directory, directory: '/project', sessionCreated: 1700000000000,
      sessionSlug: 'calm-river', sourceMessageID: 'msg_plan', path });
    await fs.mkdir(revision.directory, { recursive: true });
    await fs.writeFile(revision.path, '# Pricing plan\nContext prose that is not kept.\n## Steps\n- Add the rounding helper\n1. Wire settings\n');
    const result = await host.handleRpc({ action: 'compaction_anchor', ...scope });
    expect(result).toMatchObject({ available: true, kind: 'root' });
    expect(result.text).toContain('Keep dependencies unchanged.');
    expect(result.text).toContain(`File: ${revision.path}`);
    expect(result.text).toContain('- Add the rounding helper');
    expect(result.text).not.toContain('Context prose');
    expect(await fs.readdir(path.join(directory, 'harness', 'context')).catch(() => [])).toEqual([]);
  });
  it('anchors compaction to the objective an explicit continuation continued', async () => {
    routes['/session/ses_root/message/msg_explicit'] = { info: { id: 'msg_explicit', sessionID: 'ses_root', role: 'user' },
      parts: [{ type: 'text', text: 'Continue from the existing progress and completed tool results.' }] };
    primary = { ...primary, anchorID: 'msg_explicit', objectiveID: 'msg_user' };
    const { text } = await host.handleRpc({ action: 'compaction_anchor', ...scope });
    expect(text).toContain('Current objective (user message msg_user)');
    expect(text).toContain('Keep dependencies unchanged.');
    expect(text).not.toContain('Continue from the existing progress');
  });
  it('reads another session\'s plan only for the same owner and project', async () => {
    const { resolveSessionPlanRevision } = await import('../plans/routes.js');
    routes['/session/ses_root/message/msg_user'].parts.push({ type: 'text', synthetic: true,
      text: '[openchamber-plan-action:v1] {"action":"implement","sourceSessionId":"ses_plan","sourceMessageId":"msg_plan","planIndex":0}' });
    routes['/session/ses_plan'] = { id: 'ses_plan', directory: '/other', projectID: 'project_a', slug: 'quiet-lake', time: { created: 1700000000000 } };
    const revision = await resolveSessionPlanRevision({ dataDirectory: directory, directory: '/other', sessionCreated: 1700000000000,
      sessionSlug: 'quiet-lake', sourceMessageID: 'msg_plan', path });
    await fs.mkdir(revision.directory, { recursive: true });
    await fs.writeFile(revision.path, '# Private plan\n- Secret step\n');
    const anchor = async () => (await host.handleRpc({ action: 'compaction_anchor', ...scope })).text;

    owners.ses_plan = 'user:b';
    expect(await anchor()).not.toContain('Secret step');
    expect(requests.some(request => request.pathname === '/session/ses_plan')).toBe(false);
    delete owners.ses_plan;
    expect(await anchor()).not.toContain('Secret step');

    owners.ses_plan = 'user:a';
    routes['/session/ses_plan'].projectID = 'project_b';
    expect(await anchor()).not.toContain('Secret step');
    routes['/session/ses_plan'].projectID = 'project_a';
    const text = await anchor();
    expect(text).toContain('- Secret step');
    expect(text).toContain(`File: ${revision.path}`);
  });
  it('gives a child its delegated assignment and honors the host kill switch', async () => {
    routes['/session/ses_root'].parentID = 'ses_parent';
    const child = await host.handleRpc({ action: 'compaction_anchor', ...scope });
    expect(child).toMatchObject({ available: true, kind: 'child' });
    expect(child.text).toContain('"taskId":"dvr_task_child"');
    expect(Buffer.byteLength(child.text)).toBeLessThanOrEqual(12 * 1024);
    expect(JSON.parse(child.text.split('\n').at(-1))).toMatchObject({ taskId: 'dvr_task_child', promptTruncated: true });
    expect(child.text).toContain('read-only');
    const disabled = createHarnessTaskContextHost({ dataDirectory: directory, buildOpenCodeUrl: pathname => `http://127.0.0.1:3000${pathname}`,
      readPrimaryRecord: async () => primary, getManagedRuntime: () => ({ handleRpc: async () => ({}) }), compactionAnchorEnabled: false });
    expect(await disabled.handleRpc({ action: 'compaction_anchor', ...scope })).toEqual({ available: false, reason: 'compaction_anchor_disabled' });
  });
});

describe('native canonical task-context adapter on OpenCode 2', () => {
  let directory, routes, calls, fetchCalls;
  const scope = { sessionID: 'ses_root', directory: '/project' };
  const primary = { sessionID: scope.sessionID, directory: scope.directory, anchorID: 'msg_user', state: 'completed' };
  // A fake openCodeClient serving the projected v1 domain records.
  const fakeClient = (generation = 2) => {
    const answer = (name, key, options) => {
      calls.push({ name, key, directory: options?.directory ?? null, timeoutMs: options?.timeoutMs ?? null });
      const value = routes[key];
      if (value instanceof Error) throw value;
      return value;
    };
    return {
      generation: () => generation,
      sessions: {
        get: async (sessionID, options) => answer('sessions.get', `session:${sessionID}`, options),
        message: async (sessionID, messageID, options) => answer('sessions.message', `message:${sessionID}/${messageID}`, options),
        todo: async (sessionID, options) => answer('sessions.todo', `todo:${sessionID}`, options),
      },
      catalog: {
        project: async (query, options) => answer('catalog.project', 'project', { ...options, directory: query?.directory }),
      },
    };
  };
  const createHost = (openCodeClient, primaryRecord = primary) => createHarnessTaskContextHost({ dataDirectory: directory,
    buildOpenCodeUrl: pathname => `http://127.0.0.1:3000${pathname}`,
    readPrimaryRecord: async () => primaryRecord,
    getManagedRuntime: () => ({ handleRpc: async input => input.method === 'harness_capabilities'
      ? { policies: { contextProjection: true } }
      : { tasks: [], envelopes: [] } }),
    compactionAnchorEnabled: true,
    sessionOwnerKey: async () => 'user:a',
    openCodeClient,
    fetchImpl: async (raw) => {
      fetchCalls.push(new URL(raw).pathname);
      return Response.json(null, { status: 404 });
    },
  });
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-context-host-v2-'));
    calls = []; fetchCalls = [];
    routes = {
      'session:ses_root': { id: 'ses_root', directory: '/project', projectID: 'project_a' },
      project: { id: 'project_a', worktree: '/project' },
      'message:ses_root/msg_user': { info: { id: 'msg_user', sessionID: 'ses_root', role: 'user' },
        parts: [{ type: 'text', text: 'Keep dependencies unchanged.' }] },
      'todo:ses_root': [],
    };
  });
  afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });

  it('requires exact sequence proof before a v2 plan tool can read its selected plan', async () => {
    routes['session:ses_root'] = { ...routes['session:ses_root'], slug: 'proof-plan', time: { created: 1700000000000 } };
    routes['message:ses_root/msg_user'].parts.push({ type: 'text', synthetic: true,
      text: '[openchamber-plan-action:v1] {"action":"implement","sourceSessionId":"ses_root","sourceMessageId":"msg_plan","planIndex":0}' });
    const assistant = { info: { id: 'msg_assistant', sessionID: 'ses_root', role: 'assistant', parentID: 'msg_user' },
      parts: [{ type: 'tool', tool: 'devryan_task', callID: 'call_plan', state: { status: 'running' } }] };
    routes['message:ses_root/msg_assistant'] = assistant;
    const host = createHost(fakeClient(), { ...primary, agent: 'build', stepID: 'msg_assistant', state: 'working', cancellationGeneration: 0 });
    const input = { action: 'plan_read', ...scope, messageID: 'msg_assistant', callID: 'call_plan' };
    await expect(host.handlePlanRpc(input)).rejects.toMatchObject({ code: 'plan_call_stale' });
    assistant.turnOwnership = { source: 'native-sequence', userMessageID: 'msg_other' };
    await expect(host.handlePlanRpc(input)).rejects.toMatchObject({ code: 'plan_call_stale' });
    assistant.turnOwnership = { source: 'native-sequence', userMessageID: 'msg_user' };
    const { resolveSessionPlanRevision } = await import('../plans/routes.js');
    const revision = await resolveSessionPlanRevision({ dataDirectory: directory, directory: '/project',
      sessionCreated: 1700000000000, sessionSlug: 'proof-plan', sourceMessageID: 'msg_plan', path });
    await fs.mkdir(revision.directory, { recursive: true });
    await fs.writeFile(revision.path, '# Selected plan\n');
    const selected = await host.handlePlanRpc(input);
    expect(selected).toMatchObject({ content: '# Selected plan\n' });
    await host.authorizeNativePlanInvocation({ ...input, tool: 'devryan_task' });
    await expect(host.handleNativePlanRpc({ ...input, action: 'plan_update', expectedVersion: selected.version, text: '# Changed plan\n' },
      async () => { throw Object.assign(Error('original grant revoked'), { code: 'original_grant_revoked' }); }))
      .rejects.toMatchObject({ code: 'original_grant_revoked' });
    expect(await fs.readFile(revision.path, 'utf8')).toBe('# Selected plan\n');
    expect(await host.handleNativePlanRpc({ ...input, action: 'plan_update', expectedVersion: selected.version, text: '# Changed plan\n' },
      async () => {})).toMatchObject({ saved: true });
    expect(await fs.readFile(revision.path, 'utf8')).toBe('# Changed plan\n');
    await host.drain();
  });

  it('derives the checkpoint from the client records, scoped to the session directory', async () => {
    const host = createHost(() => fakeClient());
    const result = await host.handleRpc({ action: 'checkpoint', ...scope });
    await host.drain();
    expect(result).toMatchObject({ available: true, checkpoint: { anchor: { messageID: 'msg_user', objective: 'Keep dependencies unchanged.' } } });
    expect(fetchCalls).toEqual([]);
    // Initial scope plus the independent canonical scope recheck before commit.
    expect(calls.map((call) => call.name).sort()).toEqual(['catalog.project', 'catalog.project',
      'sessions.get', 'sessions.get', 'sessions.message', 'sessions.todo']);
    expect(calls.every((call) => call.directory === '/project' && call.timeoutMs === 5000)).toBe(true);
  });

  it('binds native task authority to the exact current call and durable Plan objective', async () => {
    const active = { ...primary, agent: 'orchestrator', stepID: 'msg_assistant', state: 'working' };
    routes['message:ses_root/msg_user'].info.metadata = { openchamberPlanMode: true };
    const assistant = { info: { id: 'msg_assistant', sessionID: 'ses_root', role: 'assistant', parentID: 'msg_user' },
      turnOwnership: { source: 'native-sequence', userMessageID: 'msg_user' },
      parts: [{ type: 'tool', tool: 'devryan_task', callID: 'call_task', state: { status: 'running' } }] };
    routes['message:ses_root/msg_assistant'] = assistant;
    const host = createHost(fakeClient(), active);
    const input = { ...scope, messageID: 'msg_assistant', callID: 'call_task' };
    expect(await host.authorizeNativeTaskInvocation(input)).toEqual({ objectiveID: 'msg_user', readOnly: true });
    await expect(host.authorizeNativeTaskInvocation({ ...input, callID: 'call_old' })).rejects.toThrow('native_task_call_stale');
    assistant.parts[0].tool = 'council_session';
    expect(await host.authorizeNativeTaskInvocation({ ...input, tool: 'council_session' })).toEqual({ objectiveID: 'msg_user', readOnly: true });
    await expect(host.authorizeNativeTaskInvocation(input)).rejects.toThrow('native_task_call_stale');
    assistant.parts[0].tool = 'devryan_task';
    assistant.turnOwnership.source = 'display';
    await expect(host.authorizeNativeTaskInvocation(input)).rejects.toThrow('native_task_call_stale');
    assistant.turnOwnership.source = 'native-sequence'; active.state = 'stopping';
    await expect(host.authorizeNativeTaskInvocation(input)).rejects.toMatchObject({ code: 'managed_orchestrator_authority_required' });
    await host.drain();
  });

  it('requires native-sequence current Builder/Orchestrator TODO calls, without selected-plan or payload role authority',async()=>{
    const active={...primary,agent:'builder',stepID:'msg_assistant',state:'working'};
    const assistant={info:{id:'msg_assistant',sessionID:'ses_root',role:'assistant',parentID:'msg_user'},
      turnOwnership:{source:'native-sequence',userMessageID:'msg_user'},parts:[{type:'tool',tool:'todowrite',callID:'call_todo',state:{status:'running'}}]};
    routes['message:ses_root/msg_assistant']=assistant;
    const host=createHost(fakeClient(),active),input={...scope,tool:'todowrite',messageID:'msg_assistant',callID:'call_todo'};
    await expect(host.authorizeNativeTodoInvocation(input)).resolves.toBeUndefined();
    await expect(host.authorizeNativeTodoInvocation({...input,tool:'todoread'})).rejects.toThrow('native_todo_call_stale');
    assistant.turnOwnership.source='display';await expect(host.authorizeNativeTodoInvocation(input)).rejects.toThrow('native_todo_call_stale');
    assistant.turnOwnership.source='native-sequence';active.agent='fixer';
    await expect(host.authorizeNativeTodoInvocation({...input,agent:'builder'})).rejects.toThrow('native_todo_root_authority_required');
    active.agent='builder';active.state='stopping';await expect(host.authorizeNativeTodoInvocation(input)).rejects.toThrow('native_todo_root_authority_required');
    await host.drain();
  });

  it('keeps the canonical scope checks on client records', async () => {
    routes.project = { id: 'project_other', worktree: '/project' };
    const host = createHost(fakeClient());
    await expect(host.handleRpc({ action: 'checkpoint', ...scope })).rejects.toThrow('context_project_scope_mismatch');
    expect(calls.some((call) => call.name === 'sessions.message')).toBe(false);
    await host.drain();
  });

  it('reports a failed client read or an unknown generation as an unavailable canonical source', async () => {
    routes['todo:ses_root'] = Object.assign(new Error('sessions.todo failed (503)'), { statusCode: 503 });
    const failing = createHost(fakeClient());
    await expect(failing.handleRpc({ action: 'checkpoint', ...scope })).rejects.toThrow('context_canonical_source_unavailable');
    await failing.drain();

    const unknown = createHost({ generation: () => { throw new Error('The OpenCode runtime generation is unknown'); } });
    await expect(unknown.handleRpc({ action: 'checkpoint', ...scope })).rejects.toThrow('context_canonical_source_unavailable');
    await unknown.drain();
    expect(fetchCalls).toEqual([]);
  });

  it('refuses generation 1 before reading canonical state', async () => {
    const host = createHost(fakeClient(1));
    await expect(host.handleRpc({ action: 'checkpoint', ...scope })).rejects.toThrow('context_canonical_source_unavailable');
    await host.drain();
    expect(calls).toEqual([]);
    expect(fetchCalls).toEqual([]);
  });
});

// Final native authorization is private constructor state, never a context RPC field.
describe('native context writes retain original caller authority', () => {
  it('refuses revocation during canonical reads before writing a decision or checkpoint', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-native-context-grant-'));
    let revoked = false;
    const scope = { sessionID: 'ses_root', directory: '/project' };
    const source = { info: { id: 'msg_user', sessionID: 'ses_root', role: 'user' }, parts: [{type:'text',text:'Keep dependencies unchanged.'}] };
    const host = createHarnessTaskContextHost({dataDirectory:directory,
      openCodeClient:{generation:()=>2,sessions:{get:async()=>({id:'ses_root',directory:'/project',projectID:'project'}),
        message:async()=>{revoked=true;return source;},todo:async()=>[]},catalog:{project:async()=>({id:'project',worktree:'/project'})}},
      readPrimaryRecord:async()=>({...scope,anchorID:'msg_user'}),getManagedRuntime:()=>({handleRpc:async input=>input.method==='harness_capabilities'?{policies:{contextProjection:true}}:{tasks:[],envelopes:[]}})});
    const recheck=async()=>{if(revoked)throw Error('original_grant_revoked');};
    try {
      await expect(host.handleNativeContextRpc({...scope,action:'remember_decision',statement:'Keep dependencies unchanged.',sourceMessageID:'msg_user'},recheck)).rejects.toThrow('original_grant_revoked');
      revoked=false;
      await expect(host.handleNativeContextRpc({...scope,action:'checkpoint'},recheck)).rejects.toThrow('original_grant_revoked');
      expect((await fs.readdir(path.join(directory,'harness','context'))).filter(value=>value.endsWith('.json'))).toEqual([]);
    } finally {await host.drain();await fs.rm(directory,{recursive:true,force:true});}
  });
});
