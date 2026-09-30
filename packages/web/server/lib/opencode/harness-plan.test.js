import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarnessTaskContextHost } from './harness-task-context.js';
import { readPlanRevision, resolveSessionPlanRevision } from '../plans/revisions.js';

describe('selected saved-plan root authority', () => {
  let root, directory, scope, primary, routes, marker, revision, hosts, events, diagnostics, owners, projects;
  const user = () => routes['/session/ses_root/message/msg_user'];
  const assistant = () => routes['/session/ses_root/message/msg_assistant'];
  const select = (extra = {}) => { marker = { action: 'implement', sourceSessionId: 'ses_plan', sourceMessageId: 'msg_plan', planIndex: 0, ...extra };
    user().parts = [{ type: 'text', text: 'Implement this plan.' }, { type: 'text', synthetic: true,
      text: `[openchamber-plan-action:v1] ${JSON.stringify(marker)}` }]; };
  const host = (extra = {}) => {
    const value = createHarnessTaskContextHost({ dataDirectory: root,
      buildOpenCodeUrl: pathname => `http://127.0.0.1:3000${pathname}`,
      readPrimaryRecord: async () => structuredClone(primary),
      sessionOwnerKey: async id => owners[id] ?? null,
      getRegisteredProjects: async () => projects,
      publishEvent: (...args) => events.push(args), recordDiagnostic: entry => diagnostics.push(entry),
      getManagedRuntime: () => ({ handleRpc: async input => input.method === 'harness_capabilities'
        ? { policies: { contextProjection: false } } : { tasks: [], envelopes: [] } }),
      fetchImpl: async raw => {
        const url = new URL(raw);
        const value = url.pathname === '/project/current'
          ? { id: url.searchParams.get('directory') === path.join(root, 'foreign') ? 'project_other' : 'project_a', worktree: directory }
          : routes[url.pathname];
        return Response.json(value ?? null, { status: value === undefined ? 404 : 200 });
      }, ...extra });
    hosts.push(value); return value;
  };
  const rpc = (value, extra = {}) => value.handlePlanRpc({ action: 'plan_read', ...scope, messageID: 'msg_assistant', callID: 'call_plan', ...extra });
  const update = (value, version, text = '# Plan\n- Updated step\n') => rpc(value, { action: 'plan_update', expectedVersion: version, text });
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-plan-authority-'));
    directory = path.join(root, 'project'); await fs.mkdir(directory); directory = await fs.realpath(directory);
    scope = { sessionID: 'ses_root', directory };
    primary = { ...scope, anchorID: 'msg_user', agent: 'builder', state: 'observing', cancellationGeneration: 2, stepID: 'msg_assistant', guardedIDs: [] };
    routes = {
      '/session/ses_root': { id: 'ses_root', directory, projectID: 'project_a', slug: 'root', time: { created: 1700000000001 } },
      '/session/ses_plan': { id: 'ses_plan', directory, projectID: 'project_a', slug: 'plan', time: { created: 1700000000000 } },
      '/session/ses_plan/message/msg_plan': { info: { id: 'msg_plan', sessionID: 'ses_plan', role: 'assistant' }, parts: [] },
      '/session/ses_root/message/msg_user': { info: { id: 'msg_user', sessionID: 'ses_root', role: 'user' }, parts: [] },
      '/session/ses_root/message/msg_assistant': { info: { id: 'msg_assistant', sessionID: 'ses_root', role: 'assistant', parentID: 'msg_user' },
        parts: [{ type: 'tool', tool: 'devryan_task', callID: 'call_plan', state: { status: 'running' } }] },
      '/session/ses_root/todo': [],
    };
    select({ projectDirectory: directory });
    revision = await resolveSessionPlanRevision({ dataDirectory: root, directory, sessionCreated: 1700000000000, sessionSlug: 'plan', sourceMessageID: 'msg_plan' });
    await fs.mkdir(revision.directory, { recursive: true }); await fs.writeFile(revision.path, '# Plan\n- Original step\n');
    hosts = []; events = []; diagnostics = []; owners = { ses_root: 'user:a', ses_plan: 'user:a' }; projects = [{ path: directory }];
  });
  afterEach(async () => { await Promise.all(hosts.map(value => value.drain())); await fs.rm(root, { recursive: true, force: true }); });

  it('derives HTTP plan identity from its canonical session and assistant message across worktrees', async () => {
    const worktree = path.join(root, 'worktree'); await fs.mkdir(worktree);
    routes['/session/ses_plan'].directory = worktree;
    const value = host();
    expect(await value.readCanonicalPlanIdentity({ sessionID: 'ses_plan', sourceMessageID: 'msg_plan', directory }))
      .toEqual({ sessionCreated: 1700000000000, sessionSlug: 'plan' });
    routes['/session/ses_plan/message/msg_plan'].info.sessionID = 'ses_foreign';
    await expect(value.readCanonicalPlanIdentity({ sessionID: 'ses_plan', sourceMessageID: 'msg_plan', directory })).rejects.toThrow();
    routes['/session/ses_plan/message/msg_plan'].info.sessionID = 'ses_plan';
    routes['/session/ses_plan/message/msg_plan'].info.role = 'user';
    await expect(value.readCanonicalPlanIdentity({ sessionID: 'ses_plan', sourceMessageID: 'msg_plan', directory })).rejects.toThrow();
  });

  it('binds global non-Git plans to their actual registered root on HTTP and private selection', async () => {
    const other = path.join(root, 'other'); await fs.mkdir(other); projects.push({ path: other });
    for (const id of ['ses_root', 'ses_plan']) routes[`/session/${id}`].projectID = 'global';
    const value = host({ fetchImpl: async raw => {
      const url = new URL(raw);
      return Response.json(url.pathname === '/project/current' ? { id: 'global', worktree: '/' } : routes[url.pathname]);
    } });
    const otherRevision = await resolveSessionPlanRevision({ dataDirectory: root, directory: other,
      sessionCreated: 1700000000000, sessionSlug: 'plan', sourceMessageID: 'msg_plan' });
    await fs.mkdir(otherRevision.directory, { recursive: true }); await fs.writeFile(otherRevision.path, '# Foreign root');
    select({ projectDirectory: other });
    await expect(rpc(value)).rejects.toMatchObject({ code: 'plan_project_mismatch' });
    await expect(value.readCanonicalPlanIdentity({ sessionID: 'ses_plan', sourceMessageID: 'msg_plan', directory: other }))
      .rejects.toMatchObject({ code: 'plan_project_mismatch' });
    await expect(value.readCanonicalPlanIdentity({ sessionID: 'ses_plan', sourceMessageID: 'msg_plan', directory: '/' }))
      .rejects.toMatchObject({ code: 'plan_project_mismatch' });
    const subdir = path.join(directory, 'pkg'); await fs.mkdir(subdir);
    routes['/session/ses_root'].directory = subdir; scope.directory = subdir; primary.directory = subdir;
    select();
    // A subdirectory is not the common root; legacy resolution must still try
    // the source root, which contains both canonical session directories.
    expect((await rpc(value)).path).toBe(revision.path);
    routes['/session/ses_root'].directory = subdir; routes['/session/ses_plan'].directory = subdir; scope.directory = subdir; primary.directory = subdir;
    select({ projectDirectory: directory });
    expect((await rpc(value)).path).toBe(revision.path);
    expect(await value.readCanonicalPlanIdentity({ sessionID: 'ses_plan', sourceMessageID: 'msg_plan', directory }))
      .toEqual({ sessionCreated: 1700000000000, sessionSlug: 'plan' });
  });

  it('reads saved identity from the authorized root when a historical Git worktree is gone', async () => {
    routes['/session/ses_plan'].directory = path.join(root, 'removed-worktree');
    const value = host({ fetchImpl: async raw => {
      const url = new URL(raw);
      if (url.searchParams.get('directory') !== directory) return Response.json(null, { status: 404 });
      return Response.json(url.pathname === '/project/current' ? { id: 'project_a', worktree: directory } : routes[url.pathname]);
    } });
    expect(await value.readCanonicalPlanIdentity({ sessionID: 'ses_plan', sourceMessageID: 'msg_plan', directory }))
      .toEqual({ sessionCreated: 1700000000000, sessionSlug: 'plan' });
  });

  it('rejects missing canonical project identity rather than comparing two undefined IDs', async () => {
    delete routes['/session/ses_plan'].projectID;
    const value = host({ fetchImpl: async raw => {
      const url = new URL(raw);
      return Response.json(url.pathname === '/project/current' ? {} : routes[url.pathname]);
    } });
    await expect(value.readCanonicalPlanIdentity({ sessionID: 'ses_plan', sourceMessageID: 'msg_plan', directory }))
      .rejects.toMatchObject({ code: 'plan_source_mismatch' });
  });

  it.each(['build', 'builder', 'orchestrator'])('reads and updates as authoritative %s independently of context projection', async agent => {
    primary.agent = agent;
    const value = host(), before = await rpc(value);
    expect(before).toMatchObject({ path: revision.path, content: '# Plan\n- Original step\n', version: expect.stringMatching(/^[a-f0-9]{64}$/) });
    const saved = await update(value, before.version);
    expect(saved.version).not.toBe(before.version);
    expect((await rpc(value)).content).toBe('# Plan\n- Updated step\n');
    expect(events).toHaveLength(1);
    expect(events[0][0]).toMatchObject({ type: 'session.plan.updated', properties: { sessionID: 'ses_plan', sourceMessageID: 'msg_plan', directory, version: saved.version } });
    expect(JSON.stringify(events)).not.toContain('Updated step');
    expect(JSON.stringify(diagnostics)).not.toContain('Updated step');
    expect((await value.handleRpc({ action: 'compaction_anchor', ...scope })).text).toContain('- Updated step');
  });
  it('denies the native build alias management regardless of declared mode', async () => {
    primary.agent = 'build';
    await expect(host().authorizePrivateRpc({ method: 'submit', params: { rootSessionId: scope.sessionID, directory, mode: 'orchestrator' } }))
      .rejects.toMatchObject({ code: 'managed_orchestrator_authority_required' });
  });
  it.each(['submit', 'status', 'wait', 'wait_any', 'wait_result_action', 'cancel', 'read_result', 'acknowledge', 'set_auto_resume'])('rejects Builder %s at private native admission even with a forged mode', async method => {
    const value = host();
    await expect(value.authorizePrivateRpc({ method, params: { rootSessionId: scope.sessionID, directory, mode: 'orchestrator', agent: 'orchestrator' } }))
      .rejects.toMatchObject({ code: 'managed_orchestrator_authority_required', statusCode: 403 });
  });
  it('allows Builder plan calls through unchanged selected-plan authority and denies model context actions', async () => {
    const value = host();
    await expect(value.authorizePrivateRpc({ method: 'harness_plan', params: { action: 'plan_read', ...scope } })).resolves.toBeUndefined();
    expect((await rpc(value)).content).toContain('Original step');
    await expect(value.authorizePrivateRpc({ method: 'harness_context', params: { action: 'checkpoint', ...scope } }))
      .rejects.toMatchObject({ code: 'managed_orchestrator_authority_required' });
    await expect(value.authorizePrivateRpc({ method: 'harness_context', params: { action: 'compaction_anchor', ...scope } })).resolves.toBeUndefined();
  });
  it('rereads canonical authority after a handoff instead of trusting declared Orchestrator mode', async () => {
    const value = host(), request = { method: 'submit', params: { rootSessionId: scope.sessionID, directory, mode: 'orchestrator' } };
    primary.agent = 'orchestrator';
    await expect(value.authorizePrivateRpc(request)).resolves.toBeUndefined();
    primary.agent = 'builder';
    await expect(value.authorizePrivateRpc(request)).rejects.toMatchObject({ code: 'managed_orchestrator_authority_required' });
  });
  it.each(['missing', 'plan', 'fixer', 'child', 'foreign-directory', 'cancelled'])('fails closed for %s management callers', async kind => {
    const value = host();
    if (kind === 'missing') primary = null;
    else if (kind === 'child') routes['/session/ses_root'].parentID = 'ses_parent';
    else if (kind === 'foreign-directory') primary.directory = path.join(root, 'foreign');
    else if (kind === 'cancelled') primary.state = 'cancelled';
    else primary.agent = kind;
    await expect(value.authorizePrivateRpc({ method: 'submit', params: { rootSessionId: scope.sessionID, directory, mode: 'orchestrator' } }))
      .rejects.toMatchObject({ code: 'managed_orchestrator_authority_required' });
  });
  it('rejects incomplete management scope but leaves internal hooks and capabilities available', async () => {
    const value = host();
    await expect(value.authorizePrivateRpc({ method: 'submit', params: { mode: 'orchestrator' } })).rejects.toMatchObject({ code: 'context_invalid_scope' });
    await expect(value.authorizePrivateRpc({ method: 'harness_capabilities' })).resolves.toBeUndefined();
    await expect(value.authorizePrivateRpc({ method: 'primary_recovery', params: scope })).resolves.toBeUndefined();
    await expect(value.authorizePrivateRpc({ method: 'parent_tool', params: scope })).resolves.toBeUndefined();
  });
  it.each([
    ['child', () => { routes['/session/ses_root'].parentID = 'ses_parent'; }],
    ['plan agent', () => { primary.agent = 'plan'; }],
    ['specialist', () => { primary.agent = 'fixer'; }],
    ['missing primary', () => { primary = null; }],
    ['foreign primary', () => { primary.directory = '/other'; }],
    ['stopping', () => { primary.state = 'stopping'; }],
    ['cancelled', () => { primary.state = 'cancelled'; }],
    ['superseded', () => { primary.state = 'superseded'; }],
    ['read-only recovery', () => { primary.guardedIDs = ['msg_user']; }],
    ['foreign parent', () => { assistant().info.parentID = 'msg_old'; }],
    ['old step', () => { primary.stepID = 'msg_old'; }],
    ['completed assistant', () => { assistant().info.time = { completed: 1 }; }],
    ['wrong call', () => { assistant().parts[0].callID = 'call_old'; }],
    ['wrong tool', () => { assistant().parts[0].tool = 'task'; }],
    ['settled call', () => { assistant().parts[0].state.status = 'completed'; }],
    ['ordinary new user request', () => { user().parts = [{ type: 'text', text: 'Do something else.' }]; }],
    ['nonsynthetic marker', () => { user().parts[1].synthetic = false; }],
    ['malformed marker', () => { user().parts[1].text = '[openchamber-plan-action:v1] {'; }],
    ['foreign owner', () => { owners.ses_plan = 'user:b'; }],
    ['unknown owner', () => { delete owners.ses_plan; }],
    ['foreign project', () => { routes['/session/ses_plan'].projectID = 'project_other'; }],
    ['unregistered project', () => { projects = []; }],
    ['marker project mismatch', () => { select({ projectDirectory: path.join(root, 'foreign') }); projects.push({ path: marker.projectDirectory }); }],
  ])('refuses %s without changing the saved plan', async (_name, change) => {
    const value = host(), version = (await rpc(value)).version; change();
    await expect(update(value, version)).rejects.toThrow();
    expect((await readPlanRevision(revision)).content).toBe('# Plan\n- Original step\n');
    expect(events).toEqual([]);
  });
  it('rejects caller-selected targets and stale versions, and serializes competing updates', async () => {
    const value = host(), before = await rpc(value);
    await expect(rpc(value, { path: revision.path })).rejects.toThrow();
    const results = await Promise.allSettled([update(value, before.version, '# One'), update(value, before.version, '# Two')]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected').reason).toMatchObject({ code: 'plan_version_conflict' });
    expect(events).toHaveLength(1);
  });
  it.each(['generation', 'owner'])('reauthorizes %s immediately before committing', async field => {
    const value = host({ fsApi: { ...fs, async open(file, ...args) {
      const handle = await fs.open(file, ...args);
      if (String(file).endsWith('.tmp')) {
        if (field === 'generation') primary.cancellationGeneration++;
        else owners.ses_plan = 'user:b';
      }
      return handle;
    } } });
    const before = await rpc(value);
    await expect(update(value, before.version)).rejects.toThrow();
    expect((await readPlanRevision(revision)).content).toBe(before.content);
    expect((await fs.readdir(revision.directory)).some(name => name.endsWith('.tmp'))).toBe(false);
    expect(events).toEqual([]);
  });
  it('retains selected objectives through maintenance, questions and explicit continuation', async () => {
    const value = host();
    for (const activeUserID of ['msg_maintenance', 'msg_answer', 'msg_compaction', 'msg_explicit']) {
      primary = { ...primary, activeUserID, objectiveID: 'msg_user' }; assistant().info.parentID = activeUserID;
      expect((await rpc(value)).path).toBe(revision.path);
    }
  });
  it('accepts registered subdirectories and resolves unambiguous legacy worktree markers', async () => {
    const subdir = path.join(directory, 'pkg'); await fs.mkdir(subdir); projects.push({ path: subdir });
    const subRevision = await resolveSessionPlanRevision({ dataDirectory: root, directory: subdir, sessionCreated: 1700000000000, sessionSlug: 'plan', sourceMessageID: 'msg_plan' });
    await fs.mkdir(subRevision.directory, { recursive: true }); await fs.writeFile(subRevision.path, '# Subdirectory');
    select({ projectDirectory: subdir }); expect((await rpc(host())).path).toBe(subRevision.path);
    await fs.mkdir(path.join(root, 'worktree')); const worktree = await fs.realpath(path.join(root, 'worktree')); routes['/session/ses_plan'].directory = worktree;
    select(); expect((await rpc(host())).path).toBe(revision.path);
    const oldRevision = await resolveSessionPlanRevision({ dataDirectory: root, directory: worktree, sessionCreated: 1700000000000, sessionSlug: 'plan', sourceMessageID: 'msg_plan' });
    await fs.mkdir(oldRevision.directory, { recursive: true }); await fs.writeFile(oldRevision.path, '# Legacy worktree');
    await expect(rpc(host())).rejects.toMatchObject({ code: 'plan_selection_required' });
  });
  it('uses current managed assignments and the owned repository root for worktree sessions', async () => {
    await fs.mkdir(path.join(root, 'worktree')); const worktree = await fs.realpath(path.join(root, 'worktree')); routes['/session/ses_plan'].directory = worktree;
    let granted = true;
    const value = host({ isManaged: () => true, resolveOwnedPlanContext: async () => granted ? { directory, ownerKey: 'user:a' } : null });
    expect((await rpc(value)).path).toBe(revision.path);
    granted = false; await expect(rpc(value)).rejects.toThrow();
  });
  it('preserves literal registered storage keys while authorizing aliases canonically', async () => {
    const alias = path.join(root, 'project-alias'); await fs.symlink(directory, alias); projects.push({ path: alias });
    const aliasRevision = await resolveSessionPlanRevision({ dataDirectory: root, directory: alias, sessionCreated: 1700000000000,
      sessionSlug: 'plan', sourceMessageID: 'msg_plan' });
    await fs.mkdir(aliasRevision.directory, { recursive: true }); await fs.writeFile(aliasRevision.path, '# Alias plan');
    select({ projectDirectory: alias }); expect((await rpc(host())).path).toBe(aliasRevision.path);
    expect((await rpc(host({ isManaged: () => true, resolveOwnedPlanContext: async () => ({ directory: alias, ownerKey: 'user:a' }) }))).path).toBe(aliasRevision.path);
    routes['/session/ses_plan'].directory = alias; select(); await fs.unlink(revision.path);
    expect((await rpc(host())).path).toBe(aliasRevision.path);
    await fs.writeFile(revision.path, '# Canonical plan');
    await expect(rpc(host())).rejects.toMatchObject({ code: 'plan_selection_required' });
  });
  it('refuses missing revisions and symlink escapes', async () => {
    const value = host(); await fs.unlink(revision.path);
    await expect(rpc(value)).rejects.toMatchObject({ code: 'plan_revision_missing' });
    const foreign = path.join(root, 'foreign.md'); await fs.writeFile(foreign, '# Foreign'); await fs.symlink(foreign, revision.path);
    await expect(rpc(value)).rejects.toMatchObject({ code: 'plan_path_unsafe' });
    expect(await fs.readFile(foreign, 'utf8')).toBe('# Foreign');
  });
});
