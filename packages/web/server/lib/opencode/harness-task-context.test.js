import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarnessTaskContextHost } from './harness-task-context.js';

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
          ? { text: input.params.childSessionId === 'ses_root' ? 'Continue only the original delegated assignment below.\n{"taskId":"dvr_task_child"}' : null }
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
    await expect(checkpoint()).rejects.toThrow('context_canonical_source_too_large');
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
    const disabled = createHarnessTaskContextHost({ dataDirectory: directory, buildOpenCodeUrl: pathname => `http://127.0.0.1:3000${pathname}`,
      readPrimaryRecord: async () => primary, getManagedRuntime: () => ({ handleRpc: async () => ({}) }), compactionAnchorEnabled: false });
    expect(await disabled.handleRpc({ action: 'compaction_anchor', ...scope })).toEqual({ available: false, reason: 'compaction_anchor_disabled' });
  });
});
