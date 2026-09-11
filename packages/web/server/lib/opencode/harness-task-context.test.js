import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarnessTaskContextHost } from './harness-task-context.js';

describe('native canonical task-context adapter', () => {
  let directory, host, enabled, primary, routes, requests;
  const scope = { sessionID: 'ses_root', directory: '/project' };
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-context-host-'));
    enabled = true; requests = [];
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
        ? { policies: { contextProjection: enabled } } : { tasks: [], envelopes: [] } }),
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
});
