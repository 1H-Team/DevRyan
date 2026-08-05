import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMultiUserRuntime } from './runtime.js';
import { createSessionVault } from './vault.js';

const USER_IDS = {
  developer: '11111111-1111-4111-8111-111111111111',
  admin: '22222222-2222-4222-8222-222222222222',
};

const fixtureProfile = (role, overrides = {}) => ({
  id: USER_IDS[role],
  email: `${role}@example.test`,
  display_name: role === 'developer' ? 'Test Developer' : 'Test Administrator',
  role,
  status: 'active',
  github_account_id: null,
  account_kind: 'agent_test',
  ...overrides,
});

const fixtureGitHubAccount = (accountId, login = accountId) => ({
  accountId,
  accessToken: `token-${accountId}`,
  scope: 'repo read:user',
  current: false,
  user: { login, id: accountId === 'account-a' ? 101 : 202, name: `${login} Name`, email: `${login}@example.test` },
});

const jsonResponse = (payload = [], status = 200) => new Response(JSON.stringify(payload), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

const makeRequest = ({
  body = {},
  cookie = '',
  loopback = true,
  method = 'GET',
  path: requestPath = '/',
  csrf = false,
} = {}) => ({
  body,
  method,
  path: requestPath,
  url: requestPath,
  headers: {
    host: loopback ? '127.0.0.1:3000' : 'devryan.example',
    cookie,
    'user-agent': 'DevRyan auth test',
    ...(csrf ? { 'x-devryan-csrf': '1' } : {}),
  },
  ip: loopback ? '127.0.0.1' : '203.0.113.8',
  secure: false,
  socket: { remoteAddress: loopback ? '127.0.0.1' : '203.0.113.8' },
});

const makeResponse = () => {
  const headers = new Map();
  const listeners = new Map();
  return {
    statusCode: 200,
    payload: null,
    locals: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      for (const listener of listeners.get('finish') || []) listener();
      return this;
    },
    send(payload) {
      this.payload = payload;
      for (const listener of listeners.get('finish') || []) listener();
      return this;
    },
    getHeader(name) {
      return headers.get(String(name).toLowerCase());
    },
    setHeader(name, value) {
      headers.set(String(name).toLowerCase(), value);
    },
    once(event, listener) {
      const values = listeners.get(event) || [];
      values.push(listener);
      listeners.set(event, values);
      return this;
    },
  };
};

const sessionCookie = (response) => {
  const header = response.getHeader('set-cookie');
  const values = Array.isArray(header) ? header : [header];
  const value = values.find((entry) => String(entry).startsWith('oc_app_session='));
  return String(value || '').split(';')[0];
};

const temporaryDirectories = [];
const activeRuntimes = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(activeRuntimes.splice(0).map((runtime) => runtime.authController.dispose()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    fs.rm(directory, { recursive: true, force: true })
  )));
});

const createHarness = async ({
  profiles = [fixtureProfile('developer'), fixtureProfile('admin')],
  signedInRole = 'developer',
  tokenExpiresAt = Math.floor(Date.now() / 1000) + 3600,
  projects = [],
  accessRows = [],
  branchRows = [],
  ownershipRows = [],
  openCodeSessions = [],
  githubAccounts = [],
  userPolicies = [],
  githubUniqueViolationAccountId = null,
  missingGithubAccountColumn = false,
  missingGithubReassignmentFunction = false,
} = {}) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-runtime-auth-'));
  temporaryDirectories.push(directory);
  await fs.writeFile(path.join(directory, 'supabase.json'), JSON.stringify({
    url: 'https://project.supabase.test',
    publishableKey: 'sb_publishable_public',
    secretKey: 'sb_secret_private',
  }), { mode: 0o600 });

  const sessions = new Map();
  const auditEvents = [];
  let appSessionUnavailable = false;
  let refreshUnavailable = false;
  let ownershipArchiveUnavailable = false;
  let mintedEmail = '';
  const mutableProfiles = profiles.map((profile) => ({ ...profile }));
  const mutableOwnershipRows = ownershipRows.map((row) => ({ ...row }));
  const mutableOpenCodeSessions = openCodeSessions.map((session) => structuredClone(session));
  const projectsById = new Map(projects.map((project) => [project.id, { ...project }]));
  const githubAccountsById = new Map(githubAccounts.map((account) => [account.accountId, structuredClone(account)]));

  const profileById = (id) => mutableProfiles.find((profile) => profile.id === id) || null;
  const fetchImpl = vi.fn(async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : null;

    if (url.hostname === 'opencode.test') {
      if (url.pathname === '/experimental/session') {
        const archived = url.searchParams.get('archived') === 'true';
        const rawCursor = url.searchParams.get('cursor');
        const cursor = rawCursor === null ? null : Number(rawCursor);
        const limit = Math.max(1, Number(url.searchParams.get('limit') || 100));
        const filtered = mutableOpenCodeSessions
          .filter((session) => Boolean(session.time?.archived) === archived)
          .filter((session) => cursor === null || !Number.isFinite(cursor) || Number(session.time?.updated) < cursor)
          .sort((left, right) => Number(right.time?.updated || 0) - Number(left.time?.updated || 0));
        const page = filtered.slice(0, limit);
        const headers = { 'Content-Type': 'application/json' };
        if (filtered.length > page.length && page.length > 0) {
          headers['X-Next-Cursor'] = String(page[page.length - 1].time.updated);
        }
        return new Response(JSON.stringify(page), { status: 200, headers });
      }
      const sessionMatch = url.pathname.match(/^\/session\/([^/]+)$/);
      if (sessionMatch) {
        const sessionId = decodeURIComponent(sessionMatch[1]);
        const index = mutableOpenCodeSessions.findIndex((session) => session.id === sessionId);
        if (index < 0) return jsonResponse({ message: 'not found' }, 404);
        if (method === 'DELETE') {
          mutableOpenCodeSessions.splice(index, 1);
          return jsonResponse(true);
        }
        if (method === 'PATCH') {
          mutableOpenCodeSessions[index] = {
            ...mutableOpenCodeSessions[index],
            ...body,
            time: { ...mutableOpenCodeSessions[index].time, ...body?.time },
          };
        }
        return jsonResponse(mutableOpenCodeSessions[index]);
      }
      return jsonResponse({ message: 'not found' }, 404);
    }

    if (url.pathname === '/auth/v1/token') {
      if (url.searchParams.get('grant_type') === 'refresh_token' && refreshUnavailable) {
        return jsonResponse({ message: 'identity temporarily unavailable' }, 503);
      }
      const profile = fixtureProfile(signedInRole);
      return jsonResponse({
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        expires_at: tokenExpiresAt,
        user: { id: profile.id, email: profile.email },
      });
    }
    if (url.pathname === '/auth/v1/admin/generate_link') {
      mintedEmail = body.email;
      return jsonResponse({ properties: { hashed_token: 'agent-test-token' } });
    }
    if (url.pathname === '/auth/v1/verify') {
      const profile = profiles.find((candidate) => candidate.email === mintedEmail);
      return jsonResponse({
        access_token: 'agent-access-token',
        refresh_token: 'agent-refresh-token',
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        user: { id: profile?.id, email: profile?.email },
      });
    }
    if (url.pathname === '/rest/v1/rpc/devryan_reassign_github_account') {
      if (missingGithubReassignmentFunction) {
        return jsonResponse({
          code: 'PGRST202',
          message: 'Could not find the function public.devryan_reassign_github_account in the schema cache',
        }, 404);
      }
      const accountId = body?.p_account_id;
      const targetUserId = body?.p_target_user_id || null;
      const previousProfile = mutableProfiles.find((profile) => profile.github_account_id === accountId) || null;
      const targetProfile = targetUserId ? profileById(targetUserId) : null;
      if (targetUserId && !targetProfile) {
        return jsonResponse({
          code: 'P0002',
          details: 'GITHUB_ASSIGNMENT_TARGET_NOT_FOUND',
          message: 'GitHub assignment target was not found',
        }, 404);
      }
      if (targetProfile?.github_account_id && targetProfile.github_account_id !== accountId) {
        return jsonResponse({
          code: 'P0001',
          details: 'GITHUB_ASSIGNMENT_TARGET_CONFLICT',
          message: 'GitHub assignment target already has another account',
        }, 400);
      }
      if (previousProfile && previousProfile.id !== targetUserId) previousProfile.github_account_id = null;
      if (targetProfile && previousProfile?.id !== targetUserId) targetProfile.github_account_id = accountId;
      for (const access of accessRows) {
        const profile = profileById(access.user_id);
        access.github_account_id = profile?.github_account_id || null;
      }
      const publicUser = (profile) => profile ? {
        id: profile.id,
        email: profile.email,
        displayName: profile.display_name,
      } : null;
      return jsonResponse({
        accountId,
        previousAssignedUser: publicUser(previousProfile),
        assignedUser: publicUser(targetProfile),
      });
    }
    if (!url.pathname.startsWith('/rest/v1/')) return jsonResponse({ message: 'not found' }, 404);

    const table = decodeURIComponent(url.pathname.slice('/rest/v1/'.length));
    if (table === 'opencode_session_ownership') {
      const sessionFilter = url.searchParams.get('session_id');
      const matching = mutableOwnershipRows.filter((row) => (
        !sessionFilter || row.session_id === sessionFilter.replace(/^eq\./, '')
      ));
      if (method === 'POST') {
        if (!mutableOwnershipRows.some((row) => row.session_id === body.session_id)) {
          mutableOwnershipRows.push({ ...body, archived_at: body.archived_at || null });
        }
        return jsonResponse([]);
      }
      if (method === 'PATCH') {
        if (ownershipArchiveUnavailable && body?.archived_at) {
          return jsonResponse({ message: 'ownership temporarily unavailable' }, 503);
        }
        for (const row of matching) Object.assign(row, body);
        return jsonResponse([]);
      }
      return jsonResponse(matching);
    }
    if (table === 'activity_logs') {
      if (body) auditEvents.push(body);
      return jsonResponse([]);
    }
    if (table === 'user_profiles') {
      if (missingGithubAccountColumn && url.searchParams.has('github_account_id')) {
        return jsonResponse({ message: 'column user_profiles.github_account_id does not exist' }, 400);
      }
      if (url.searchParams.has('account_kind')) return jsonResponse(mutableProfiles);
      const idFilter = url.searchParams.get('id');
      if (idFilter?.startsWith('eq.')) {
        const profile = profileById(idFilter.slice(3));
        if (method === 'PATCH' && profile) {
          if (githubUniqueViolationAccountId && body?.github_account_id === githubUniqueViolationAccountId) {
            return jsonResponse({
              code: '23505',
              constraint: 'user_profiles_github_account_id_idx',
              message: 'duplicate key value violates unique constraint',
            }, 409);
          }
          Object.assign(profile, body);
        }
        return jsonResponse(profile ? [profile] : []);
      }
      const githubAccountFilter = url.searchParams.get('github_account_id');
      if (githubAccountFilter === 'not.is.null') {
        return jsonResponse(mutableProfiles.filter((profile) => profile.github_account_id));
      }
      if (githubAccountFilter?.startsWith('eq.')) {
        const accountId = githubAccountFilter.slice(3);
        return jsonResponse(mutableProfiles.filter((profile) => profile.github_account_id === accountId));
      }
      if (url.searchParams.get('select') === 'id') return jsonResponse(mutableProfiles.slice(0, 1).map(({ id }) => ({ id })));
      return jsonResponse(mutableProfiles);
    }
    if (table === 'managed_projects') {
      const idFilter = url.searchParams.get('id');
      const matching = [...projectsById.values()].filter((project) => (
        !idFilter
        || (idFilter.startsWith('eq.') && project.id === idFilter.slice(3))
        || (idFilter.startsWith('in.(') && idFilter.slice(4, -1).split(',').includes(project.id))
      ));
      if (method === 'PATCH') {
        const project = matching[0];
        if (!project) return jsonResponse([]);
        Object.assign(project, body);
        projectsById.set(project.id, project);
        return jsonResponse([project]);
      }
      return jsonResponse(matching);
    }
    if (table === 'user_project_access') {
      const userId = url.searchParams.get('user_id')?.replace(/^eq\./, '');
      return jsonResponse(accessRows.filter((row) => !userId || row.user_id === userId));
    }
    if (table === 'user_project_branches') {
      const userId = url.searchParams.get('user_id')?.replace(/^eq\./, '');
      return jsonResponse(branchRows.filter((row) => !userId || row.user_id === userId));
    }
    if (table === 'user_policies') {
      const userId = url.searchParams.get('user_id')?.replace(/^eq\./, '');
      return jsonResponse(userPolicies.filter((row) => !userId || row.user_id === userId));
    }
    if (table === 'role_policies') {
      return jsonResponse([]);
    }
    if (table === 'app_sessions') {
      if (method === 'GET' && appSessionUnavailable) {
        return jsonResponse({ message: 'identity temporarily unavailable' }, 503);
      }
      if (method === 'POST') {
        sessions.set(body.id, { ...body, revoked_at: null });
        return jsonResponse([]);
      }
      const tokenHashFilter = url.searchParams.get('session_token_hash');
      const idFilter = url.searchParams.get('id');
      if (method === 'PATCH') {
        const id = idFilter?.startsWith('eq.') ? idFilter.slice(3) : '';
        const userIdFilter = url.searchParams.get('user_id');
        for (const [sessionId, existing] of sessions) {
          const idMatches = !id || sessionId === id;
          const userMatches = !userIdFilter || existing.user_id === userIdFilter.replace(/^eq\./, '');
          if (idMatches && userMatches) sessions.set(sessionId, { ...existing, ...body });
        }
        return jsonResponse([]);
      }
      const match = [...sessions.values()].find((session) => (
        !tokenHashFilter || session.session_token_hash === tokenHashFilter.replace(/^eq\./, '')
      ));
      return jsonResponse(match && !match.revoked_at ? [match] : []);
    }
    return jsonResponse([]);
  });

  const runtime = await createMultiUserRuntime({
    dataDirectory: directory,
    fetchImpl,
    logger: { warn: vi.fn(), error: vi.fn() },
    githubAuthStore: {
      getGitHubAuthById: (accountId) => githubAccountsById.get(accountId) || null,
      getAllGitHubAuthAccounts: () => [...githubAccountsById.values()].map((account) => ({
        id: account.accountId,
        user: account.user,
        scope: account.scope || '',
        current: Boolean(account.current),
      })),
      clearGitHubAuthById: (accountId) => githubAccountsById.delete(accountId),
    },
  });
  activeRuntimes.push(runtime);

  return {
    auditEvents,
    directory,
    fetchImpl,
    getMintedEmail: () => mintedEmail,
    getProfile: (userId) => profileById(userId),
    getOwnership: (sessionId) => mutableOwnershipRows.find((row) => row.session_id === sessionId) || null,
    getGitHubAccount: (accountId) => githubAccountsById.get(accountId) || null,
    runtime,
    projectsById,
    setAppSessionUnavailable(value) { appSessionUnavailable = value; },
    setOwnershipArchiveUnavailable(value) { ownershipArchiveUnavailable = value; },
    setRefreshUnavailable(value) { refreshUnavailable = value; },
  };
};

const passwordLogin = async (harness, { role = 'developer', trustDevice = false } = {}) => {
  const response = makeResponse();
  await harness.runtime.authController.handleSessionCreate(makeRequest({
    method: 'POST',
    body: { email: `${role}@example.test`, password: 'correct-password', trustDevice },
  }), response);
  expect(response.statusCode).toBe(200);
  return { response, cookie: sessionCookie(response), principal: response.payload.principal };
};

const waitForAudit = async (harness, action, targetId = null) => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const event = harness.auditEvents.find((candidate) => (
      candidate.action === action && (!targetId || candidate.target_id === targetId)
    ));
    if (event) return event;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return null;
};

describe('multi-user authentication runtime', () => {
  it('allows assigned GitHub identity status while keeping operations policy-gated', async () => {
    const harness = await createHarness({
      profiles: [
        fixtureProfile('developer', { github_account_id: 'account-a' }),
        fixtureProfile('admin'),
      ],
      githubAccounts: [fixtureGitHubAccount('account-a', 'assigned-dev')],
      userPolicies: [{
        user_id: USER_IDS.developer,
        settings_pages: null,
        settings_permission_overrides: {},
        capabilities: { github: false },
        settings_overrides: {},
      }],
    });
    const login = await passwordLogin(harness);

    const allowedRequest = makeRequest({ cookie: login.cookie, path: '/github/auth/status' });
    const allowedResponse = makeResponse();
    const next = vi.fn(() => allowedResponse.json({ ok: true }));
    await harness.runtime.authController.requireAuth(allowedRequest, allowedResponse, next);
    expect(next).toHaveBeenCalledOnce();
    expect(allowedResponse.statusCode).toBe(200);

    const deniedResponse = makeResponse();
    await harness.runtime.authController.requireAuth(
      makeRequest({ cookie: login.cookie, path: '/github/pr/status' }),
      deniedResponse,
      vi.fn(),
    );
    expect(deniedResponse.statusCode).toBe(403);
    expect(deniedResponse.payload.error).toBe('GitHub access is disabled by policy');
  });

  it('filters global session pages and permits only owner lifecycle mutations for both roles', async () => {
    const lifecycleRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-lifecycle-'));
    temporaryDirectories.push(lifecycleRoot);
    const adminDirectory = path.join(lifecycleRoot, 'admin');
    const developerDirectory = path.join(lifecycleRoot, 'developer');
    await Promise.all([
      fs.mkdir(adminDirectory, { recursive: true }),
      fs.mkdir(developerDirectory, { recursive: true }),
    ]);
    const project = {
      id: '33333333-3333-4333-8333-333333333333',
      label: 'Lifecycle Project',
      repository_path: adminDirectory,
      remote_url: null,
      default_branch: 'main',
      status: 'active',
    };
    const ownership = (sessionId, userId) => ({
      session_id: sessionId,
      user_id: userId,
      project_id: project.id,
      branch_name: 'main',
      public_directory: '/projects/lifecycle/main',
      archived_at: null,
    });
    const harness = await createHarness({
      projects: [project],
      accessRows: [
        { user_id: USER_IDS.admin, project_id: project.id, is_default: true, github_account_id: null },
        { user_id: USER_IDS.developer, project_id: project.id, is_default: true, github_account_id: null },
      ],
      branchRows: [
        { user_id: USER_IDS.admin, project_id: project.id, branch_name: 'main', workspace_path: project.repository_path, is_default: true },
        { user_id: USER_IDS.developer, project_id: project.id, branch_name: 'main', workspace_path: developerDirectory, is_default: true },
      ],
      ownershipRows: [
        ownership('admin-active', USER_IDS.admin),
        ownership('admin-archived', USER_IDS.admin),
        ownership('partial-delete', USER_IDS.admin),
        ownership('developer-active', USER_IDS.developer),
        { ...ownership('tombstoned', USER_IDS.admin), archived_at: '2026-08-01T00:00:00.000Z' },
      ],
      openCodeSessions: [
        { id: 'developer-active', directory: developerDirectory, time: { updated: 400 } },
        { id: 'admin-active', directory: project.repository_path, time: { updated: 300 } },
        { id: 'partial-delete', directory: project.repository_path, time: { updated: 290 } },
        { id: 'repairable', directory: project.repository_path, time: { updated: 275 } },
        { id: 'tombstoned', directory: project.repository_path, time: { updated: 250 } },
        { id: 'unclaimed', directory: '/tmp/ambiguous', time: { updated: 200 } },
        { id: 'admin-archived', directory: project.repository_path, time: { updated: 100, archived: 150 } },
      ],
    });
    const handlers = new Map();
    const app = Object.fromEntries(['get', 'post', 'put', 'patch', 'delete', 'use'].map((method) => [
      method,
      (route, handler) => handlers.set(`${method.toUpperCase()} ${route}`, handler),
    ]));
    harness.runtime.registerRoutes(app, {
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
    });
    const assignment = (userId, repositoryPath) => ({
      projectId: project.id,
      branchName: 'main',
      publicDirectory: '/projects/lifecycle/main',
      repositoryPath,
      isDefault: true,
    });
    const admin = { scope: 'managed', id: USER_IDS.admin, role: 'admin', assignments: [assignment(USER_IDS.admin, project.repository_path)] };
    const developer = { scope: 'managed', id: USER_IDS.developer, role: 'developer', assignments: [assignment(USER_IDS.developer, developerDirectory)] };
    const list = handlers.get('GET /api/experimental/session');

    const adminList = makeResponse();
    await list({ principal: admin, query: { archived: 'false', limit: '1' } }, adminList, vi.fn());
    expect(adminList.payload.map(({ id }) => id)).toEqual(['admin-active']);
    expect(adminList.getHeader('x-next-cursor')).toBe('300');
    expect(harness.getOwnership('repairable')).toBeNull();
    expect(harness.getOwnership('tombstoned')?.archived_at).toBe('2026-08-01T00:00:00.000Z');

    const developerList = makeResponse();
    await list({ principal: developer, query: { archived: 'false', limit: '10' } }, developerList, vi.fn());
    expect(developerList.payload.map(({ id }) => id)).toEqual(['developer-active']);

    const archivedList = makeResponse();
    await list({ principal: admin, query: { archived: 'true', limit: '10' } }, archivedList, vi.fn());
    expect(archivedList.payload.map(({ id }) => id)).toEqual(['admin-archived']);

    const lifecycle = handlers.get('PATCH /api/session/:sessionID');
    for (const [archivedAt, action] of [[Date.now(), 'session.archived'], [0, 'session.unarchived']]) {
      const response = makeResponse();
      await lifecycle({
        body: { time: { archived: archivedAt } },
        params: { sessionID: 'admin-active' },
        principal: admin,
      }, response, () => response.json({ updated: true }));
      await expect(waitForAudit(harness, action)).resolves.toEqual(expect.objectContaining({ action, success: true }));
    }

    const foreignDelete = makeResponse();
    await handlers.get('DELETE /api/session/:sessionID')({
      body: undefined,
      method: 'DELETE',
      originalUrl: '/api/session/developer-active',
      params: { sessionID: 'developer-active' },
      principal: admin,
    }, foreignDelete, vi.fn());
    expect({ status: foreignDelete.statusCode, payload: foreignDelete.payload }).toEqual({
      status: 404,
      payload: { error: 'Session not found' },
    });

    const journalDirectory = path.join(harness.directory, 'harness', 'journal');
    await fs.mkdir(journalDirectory, { recursive: true });
    const journalMarker = path.join(journalDirectory, 'retained-after-delete');
    await fs.writeFile(journalMarker, 'diagnostic evidence');
    const deleteResponse = makeResponse();
    await handlers.get('DELETE /api/session/:sessionID')({
      body: undefined,
      method: 'DELETE',
      originalUrl: '/api/session/admin-active',
      params: { sessionID: 'admin-active' },
      principal: admin,
    }, deleteResponse, vi.fn());
    await waitForAudit(harness, 'session.deleted');

    expect(deleteResponse.statusCode).toBe(200);
    expect(harness.getOwnership('admin-active')?.archived_at).toEqual(expect.any(String));
    await expect(fs.readFile(journalMarker, 'utf8')).resolves.toBe('diagnostic evidence');
    expect(harness.auditEvents).toContainEqual(expect.objectContaining({
      action: 'session.deleted',
      success: true,
      metadata: expect.objectContaining({ upstreamDeleted: true, ownershipTombstoned: true }),
    }));

    harness.setOwnershipArchiveUnavailable(true);
    const partialResponse = makeResponse();
    await handlers.get('DELETE /api/session/:sessionID')({
      body: undefined,
      method: 'DELETE',
      originalUrl: '/api/session/partial-delete',
      params: { sessionID: 'partial-delete' },
      principal: admin,
    }, partialResponse, vi.fn());
    const partialAudit = await waitForAudit(harness, 'session.deleted', 'partial-delete');

    expect(partialResponse.statusCode).toBe(502);
    expect(harness.getOwnership('partial-delete')?.archived_at).toBeNull();
    expect(partialAudit).toEqual(expect.objectContaining({
      success: false,
      metadata: expect.objectContaining({ upstreamDeleted: true, ownershipTombstoned: false }),
    }));
    await expect(fs.readFile(journalMarker, 'utf8')).resolves.toBe('diagnostic evidence');
  });

  it('saves GitHub association with the profile without revoking app sessions', async () => {
    const harness = await createHarness({
      signedInRole: 'admin',
      profiles: [
        fixtureProfile('developer', { github_account_id: 'legacy-account' }),
        fixtureProfile('admin'),
      ],
    });
    const login = await passwordLogin(harness, { role: 'admin' });
    const handlers = new Map();
    const app = Object.fromEntries(['get', 'post', 'put', 'patch', 'delete'].map((method) => [
      method,
      (route, handler) => handlers.set(`${method.toUpperCase()} ${route}`, handler),
    ]));
    harness.runtime.registerRoutes(app);
    const principal = await harness.runtime.resolvePrincipal(makeRequest({ cookie: login.cookie }));
    const appSessionRevocations = () => harness.fetchImpl.mock.calls.filter(([input, init = {}]) => {
      const url = new URL(String(input));
      return url.pathname === '/rest/v1/app_sessions'
        && init.method === 'PATCH'
        && url.searchParams.get('user_id') === `eq.${USER_IDS.developer}`;
    });

    const clearResponse = makeResponse();
    await handlers.get('PATCH /api/admin/users/:userId')({
      body: { role: 'developer', status: 'active', githubAccountId: null },
      params: { userId: USER_IDS.developer },
      principal,
    }, clearResponse);

    expect(clearResponse.statusCode).toBe(200);
    expect(clearResponse.payload.user.github_account_id).toBeNull();
    expect(harness.getProfile(USER_IDS.developer)?.github_account_id).toBeNull();
    expect(appSessionRevocations()).toHaveLength(0);

    const invalidResponse = makeResponse();
    await handlers.get('PATCH /api/admin/users/:userId')({
      body: { githubAccountId: 'missing-account' },
      params: { userId: USER_IDS.developer },
      principal,
    }, invalidResponse);
    expect(invalidResponse.statusCode).toBe(400);
    expect(harness.getProfile(USER_IDS.developer)?.github_account_id).toBeNull();

    const suspendResponse = makeResponse();
    await handlers.get('PATCH /api/admin/users/:userId')({
      body: { role: 'developer', status: 'suspended', githubAccountId: null },
      params: { userId: USER_IDS.developer },
      principal,
    }, suspendResponse);
    expect(suspendResponse.statusCode).toBe(200);
    expect(appSessionRevocations()).toHaveLength(1);
  });

  it('rejects profile GitHub accounts owned by another user and normalizes database races', async () => {
    const harness = await createHarness({
      signedInRole: 'admin',
      profiles: [
        fixtureProfile('developer'),
        fixtureProfile('admin', { github_account_id: 'account-a' }),
      ],
      githubAccounts: [fixtureGitHubAccount('account-a'), fixtureGitHubAccount('account-b')],
      githubUniqueViolationAccountId: 'account-b',
    });
    const login = await passwordLogin(harness, { role: 'admin' });
    const handlers = new Map();
    const app = Object.fromEntries(['get', 'post', 'put', 'patch', 'delete'].map((method) => [
      method,
      (route, handler) => handlers.set(`${method.toUpperCase()} ${route}`, handler),
    ]));
    harness.runtime.registerRoutes(app);
    const principal = await harness.runtime.resolvePrincipal(makeRequest({ cookie: login.cookie }));

    const ownedResponse = makeResponse();
    await handlers.get('PATCH /api/admin/users/:userId')({
      body: { githubAccountId: 'account-a' },
      params: { userId: USER_IDS.developer },
      principal,
    }, ownedResponse);
    expect(ownedResponse.statusCode).toBe(409);
    expect(ownedResponse.payload).toMatchObject({
      code: 'GITHUB_ACCOUNT_ALREADY_ASSIGNED',
      assignedUserId: USER_IDS.admin,
    });

    const raceResponse = makeResponse();
    await handlers.get('PATCH /api/admin/users/:userId')({
      body: { githubAccountId: 'account-b' },
      params: { userId: USER_IDS.developer },
      principal,
    }, raceResponse);
    expect(raceResponse.statusCode).toBe(409);
    expect(raceResponse.payload.code).toBe('GITHUB_ACCOUNT_ALREADY_ASSIGNED');
    expect(harness.getProfile(USER_IDS.developer)?.github_account_id).toBeNull();
  });

  it('lists token-free GitHub inventory and blocks disconnect until an account is unassigned', async () => {
    const harness = await createHarness({
      signedInRole: 'admin',
      profiles: [
        fixtureProfile('developer'),
        fixtureProfile('admin', { github_account_id: 'account-a' }),
      ],
      githubAccounts: [fixtureGitHubAccount('account-a', 'alpha'), fixtureGitHubAccount('account-b', 'beta')],
    });
    const login = await passwordLogin(harness, { role: 'admin' });
    const handlers = new Map();
    const app = Object.fromEntries(['get', 'post', 'put', 'patch', 'delete'].map((method) => [
      method,
      (route, handler) => handlers.set(`${method.toUpperCase()} ${route}`, handler),
    ]));
    harness.runtime.registerRoutes(app);
    const principal = await harness.runtime.resolvePrincipal(makeRequest({ cookie: login.cookie }));

    const listResponse = makeResponse();
    await handlers.get('GET /api/admin/github-accounts')({ principal }, listResponse);
    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.payload.accounts).toHaveLength(2);
    expect(listResponse.payload.accounts[0]).not.toHaveProperty('accessToken');
    expect(listResponse.payload.accounts.find((account) => account.id === 'account-a')?.assignedUser).toMatchObject({
      id: USER_IDS.admin,
      displayName: 'Test Administrator',
    });

    const seniorPrincipal = { ...principal, role: 'senior_developer' };
    const deniedListResponse = makeResponse();
    await handlers.get('GET /api/admin/github-accounts')({ principal: seniorPrincipal }, deniedListResponse);
    expect(deniedListResponse.statusCode).toBe(403);

    const deniedDeleteResponse = makeResponse();
    await handlers.get('DELETE /api/admin/github-accounts/:accountId')({
      params: { accountId: 'account-b' },
      principal: seniorPrincipal,
    }, deniedDeleteResponse);
    expect(deniedDeleteResponse.statusCode).toBe(403);
    expect(harness.getGitHubAccount('account-b')).not.toBeNull();

    const assignedResponse = makeResponse();
    await handlers.get('DELETE /api/admin/github-accounts/:accountId')({
      params: { accountId: 'account-a' },
      principal,
    }, assignedResponse);
    expect(assignedResponse.statusCode).toBe(409);
    expect(assignedResponse.payload.code).toBe('GITHUB_ACCOUNT_ASSIGNED');
    expect(harness.getGitHubAccount('account-a')).not.toBeNull();

    const unassignedResponse = makeResponse();
    await handlers.get('DELETE /api/admin/github-accounts/:accountId')({
      params: { accountId: 'account-b' },
      principal,
    }, unassignedResponse);
    expect(unassignedResponse.statusCode).toBe(200);
    expect(unassignedResponse.payload).toEqual({ removed: true });
    expect(harness.getGitHubAccount('account-b')).toBeNull();
  });

  it('atomically moves a GitHub account from the hidden developer fixture to the signed-in administrator', async () => {
    const accessRows = [
      { user_id: USER_IDS.developer, project_id: 'project', is_default: true, github_account_id: 'account-a' },
      { user_id: USER_IDS.admin, project_id: 'project', is_default: true, github_account_id: null },
    ];
    const harness = await createHarness({
      signedInRole: 'admin',
      profiles: [
        fixtureProfile('developer', { github_account_id: 'account-a' }),
        fixtureProfile('admin'),
      ],
      accessRows,
      githubAccounts: [fixtureGitHubAccount('account-a', 'alpha')],
    });
    const login = await passwordLogin(harness, { role: 'admin' });
    const handlers = new Map();
    const app = Object.fromEntries(['get', 'post', 'put', 'patch', 'delete'].map((method) => [
      method,
      (route, handler) => handlers.set(`${method.toUpperCase()} ${route}`, handler),
    ]));
    harness.runtime.registerRoutes(app);
    const principal = await harness.runtime.resolvePrincipal(makeRequest({ cookie: login.cookie }));
    const closeDeveloper = vi.fn();
    const closeAdministrator = vi.fn();
    harness.runtime.registerConnection({ id: USER_IDS.developer, scope: 'managed' }, closeDeveloper);
    harness.runtime.registerConnection({ id: USER_IDS.admin, scope: 'managed' }, closeAdministrator);

    const response = makeResponse();
    await handlers.get('PUT /api/admin/github-accounts/:accountId/assignment')({
      params: { accountId: 'account-a' },
      body: { userId: USER_IDS.admin },
      principal,
    }, response);

    expect(response.statusCode).toBe(200);
    expect(response.payload).toMatchObject({
      accountId: 'account-a',
      previousAssignedUser: { id: USER_IDS.developer, displayName: 'Test Developer' },
      assignedUser: { id: USER_IDS.admin, displayName: 'Test Administrator' },
    });
    expect(harness.getProfile(USER_IDS.developer)?.github_account_id).toBeNull();
    expect(harness.getProfile(USER_IDS.admin)?.github_account_id).toBe('account-a');
    expect(accessRows).toMatchObject([
      { user_id: USER_IDS.developer, github_account_id: null },
      { user_id: USER_IDS.admin, github_account_id: 'account-a' },
    ]);
    expect(harness.getGitHubAccount('account-a')).not.toBeNull();
    expect(closeDeveloper).toHaveBeenCalledOnce();
    expect(closeAdministrator).toHaveBeenCalledOnce();
    await expect(waitForAudit(harness, 'github.account_assignment_changed', 'account-a')).resolves.toMatchObject({
      metadata: expect.objectContaining({
        previousUserId: USER_IDS.developer,
        assignedUserId: USER_IDS.admin,
      }),
    });

    const idempotentResponse = makeResponse();
    await handlers.get('PUT /api/admin/github-accounts/:accountId/assignment')({
      params: { accountId: 'account-a' },
      body: { userId: USER_IDS.admin },
      principal,
    }, idempotentResponse);
    expect(idempotentResponse.statusCode).toBe(200);
    expect(idempotentResponse.payload.assignedUser.id).toBe(USER_IDS.admin);
    expect(harness.getProfile(USER_IDS.admin)?.github_account_id).toBe('account-a');
  });

  it('reassigns to visible humans, unassigns without deleting credentials, and rejects unsafe targets', async () => {
    const humanUserId = '44444444-4444-4444-8444-444444444444';
    const hiddenFixtureId = '55555555-5555-4555-8555-555555555555';
    const conflictUserId = '66666666-6666-4666-8666-666666666666';
    const harness = await createHarness({
      signedInRole: 'admin',
      profiles: [
        fixtureProfile('developer', { github_account_id: 'account-a' }),
        fixtureProfile('admin'),
        fixtureProfile('developer', {
          id: humanUserId,
          email: 'human@example.test',
          display_name: 'Human Developer',
          account_kind: 'human',
        }),
        fixtureProfile('developer', {
          id: hiddenFixtureId,
          email: 'hidden@example.test',
          display_name: 'Other Test Developer',
        }),
        fixtureProfile('developer', {
          id: conflictUserId,
          email: 'conflict@example.test',
          display_name: 'Assigned Human',
          account_kind: 'human',
          github_account_id: 'account-b',
        }),
      ],
      githubAccounts: [
        fixtureGitHubAccount('account-a', 'alpha'),
        fixtureGitHubAccount('account-b', 'beta'),
      ],
    });
    const login = await passwordLogin(harness, { role: 'admin' });
    const handlers = new Map();
    const app = Object.fromEntries(['get', 'post', 'put', 'patch', 'delete'].map((method) => [
      method,
      (route, handler) => handlers.set(`${method.toUpperCase()} ${route}`, handler),
    ]));
    harness.runtime.registerRoutes(app);
    const principal = await harness.runtime.resolvePrincipal(makeRequest({ cookie: login.cookie }));
    const route = handlers.get('PUT /api/admin/github-accounts/:accountId/assignment');

    const humanResponse = makeResponse();
    await route({ params: { accountId: 'account-a' }, body: { userId: humanUserId }, principal }, humanResponse);
    expect(humanResponse.statusCode).toBe(200);
    expect(humanResponse.payload.assignedUser).toMatchObject({ id: humanUserId, displayName: 'Human Developer' });

    const unassignResponse = makeResponse();
    await route({ params: { accountId: 'account-a' }, body: { userId: null }, principal }, unassignResponse);
    expect(unassignResponse.statusCode).toBe(200);
    expect(unassignResponse.payload.assignedUser).toBeNull();
    expect(harness.getProfile(humanUserId)?.github_account_id).toBeNull();
    expect(harness.getGitHubAccount('account-a')).not.toBeNull();

    const hiddenResponse = makeResponse();
    await route({ params: { accountId: 'account-a' }, body: { userId: hiddenFixtureId }, principal }, hiddenResponse);
    expect(hiddenResponse.statusCode).toBe(403);
    expect(hiddenResponse.payload.code).toBe('GITHUB_ASSIGNMENT_TARGET_NOT_ALLOWED');

    const conflictResponse = makeResponse();
    await route({ params: { accountId: 'account-a' }, body: { userId: conflictUserId }, principal }, conflictResponse);
    expect(conflictResponse.statusCode).toBe(409);
    expect(conflictResponse.payload).toMatchObject({
      code: 'GITHUB_ASSIGNMENT_TARGET_CONFLICT',
      conflictingAccountId: 'account-b',
    });

    const missingTargetResponse = makeResponse();
    await route({
      params: { accountId: 'account-a' },
      body: { userId: '77777777-7777-4777-8777-777777777777' },
      principal,
    }, missingTargetResponse);
    expect(missingTargetResponse.statusCode).toBe(404);
    expect(missingTargetResponse.payload.code).toBe('GITHUB_ASSIGNMENT_TARGET_NOT_FOUND');

    const missingAccountResponse = makeResponse();
    await route({ params: { accountId: 'missing' }, body: { userId: null }, principal }, missingAccountResponse);
    expect(missingAccountResponse.statusCode).toBe(404);
    expect(missingAccountResponse.payload.code).toBe('GITHUB_ACCOUNT_NOT_FOUND');

    const deniedResponse = makeResponse();
    await route({
      params: { accountId: 'account-a' },
      body: { userId: null },
      principal: { ...principal, role: 'senior_developer' },
    }, deniedResponse);
    expect(deniedResponse.statusCode).toBe(403);
  });

  it('returns a migration-required response when the GitHub reassignment function is missing', async () => {
    const harness = await createHarness({
      signedInRole: 'admin',
      missingGithubReassignmentFunction: true,
      githubAccounts: [fixtureGitHubAccount('account-a', 'alpha')],
    });
    const login = await passwordLogin(harness, { role: 'admin' });
    const handlers = new Map();
    const app = Object.fromEntries(['get', 'post', 'put', 'patch', 'delete'].map((method) => [
      method,
      (route, handler) => handlers.set(`${method.toUpperCase()} ${route}`, handler),
    ]));
    harness.runtime.registerRoutes(app);
    const principal = await harness.runtime.resolvePrincipal(makeRequest({ cookie: login.cookie }));

    const response = makeResponse();
    await handlers.get('PUT /api/admin/github-accounts/:accountId/assignment')({
      params: { accountId: 'account-a' },
      body: { userId: null },
      principal,
    }, response);

    expect(response.statusCode).toBe(503);
    expect(response.payload).toEqual({
      error: 'Database migration required',
      code: 'schema_migration_required',
      requiredMigration: '20260804120000',
    });
  });

  it('returns a migration-required response when the GitHub profile column is missing', async () => {
    const harness = await createHarness({
      signedInRole: 'admin',
      missingGithubAccountColumn: true,
    });
    const login = await passwordLogin(harness, { role: 'admin' });
    const handlers = new Map();
    const app = Object.fromEntries(['get', 'post', 'put', 'patch', 'delete'].map((method) => [
      method,
      (route, handler) => handlers.set(`${method.toUpperCase()} ${route}`, handler),
    ]));
    harness.runtime.registerRoutes(app);
    const principal = await harness.runtime.resolvePrincipal(makeRequest({ cookie: login.cookie }));

    const response = makeResponse();
    await handlers.get('GET /api/admin/github-accounts')({ principal }, response);

    expect(response.statusCode).toBe(503);
    expect(response.payload).toEqual({
      error: 'Database migration required',
      code: 'schema_migration_required',
      requiredMigration: '20260804100000',
    });
  });

  it('allows real-worktree Git routes for developers and clears cached principals after creation', async () => {
    const repositoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-route-policy-'));
    temporaryDirectories.push(repositoryPath);
    const project = {
      id: '33333333-3333-4333-8333-333333333333',
      label: 'Route Policy',
      repository_path: repositoryPath,
      remote_url: null,
      default_branch: 'main',
      status: 'active',
    };
    const harness = await createHarness({
      signedInRole: 'developer',
      projects: [project],
      accessRows: [{ user_id: USER_IDS.developer, project_id: project.id, is_default: true, github_account_id: null }],
      branchRows: [{
        user_id: USER_IDS.developer,
        project_id: project.id,
        branch_name: 'main',
        workspace_path: repositoryPath,
        is_default: true,
      }],
    });
    const login = await passwordLogin(harness, { role: 'developer' });

    for (const [method, requestPath] of [
      ['GET', '/git/worktrees'],
      ['GET', '/git/worktree-root'],
      ['GET', '/git/worktrees/operations'],
      ['GET', '/git/worktrees/operations/operation-1'],
      ['POST', '/git/worktrees/validate'],
      ['POST', '/git/worktrees/preview'],
      ['POST', '/git/worktrees/operations/operation-1/retry'],
      ['POST', '/git/branches'],
      ['POST', '/git/checkout'],
      ['DELETE', '/git/worktrees'],
    ]) {
      const response = makeResponse();
      const next = vi.fn(() => response.json({ allowed: true }));
      await harness.runtime.authController.requireAuth(makeRequest({
        cookie: login.cookie,
        method,
        path: requestPath,
        csrf: method !== 'GET',
      }), response, next);
      expect(response.statusCode, `${method} ${requestPath}`).toBe(200);
      expect(next, `${method} ${requestPath}`).toHaveBeenCalledOnce();
    }

    harness.getProfile(USER_IDS.developer).display_name = 'Updated Developer';
    const creationResponse = makeResponse();
    await harness.runtime.authController.requireAuth(makeRequest({
      cookie: login.cookie,
      method: 'POST',
      path: '/git/worktrees',
      csrf: true,
    }), creationResponse, () => creationResponse.json({ created: true }));
    const refreshed = await harness.runtime.resolvePrincipal(makeRequest({ cookie: login.cookie }));
    expect(refreshed.displayName).toBe('Updated Developer');

    const deniedResponse = makeResponse();
    await harness.runtime.authController.requireAuth(makeRequest({
      cookie: login.cookie,
      path: '/git/identities',
    }), deniedResponse, vi.fn());
    expect(deniedResponse.statusCode).toBe(403);
  });

  it('normalizes SDK-encoded directory headers without weakening managed path authorization', async () => {
    const repositoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-question-policy-'));
    const outsidePath = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-question-outside-'));
    temporaryDirectories.push(repositoryPath, outsidePath);
    const literalPercentPath = path.join(repositoryPath, '%2Fliteral');
    const symlinkEscapePath = path.join(repositoryPath, 'escape');
    await fs.mkdir(literalPercentPath, { recursive: true });
    await fs.symlink(outsidePath, symlinkEscapePath, 'dir');

    const project = {
      id: '44444444-4444-4444-8444-444444444444',
      label: 'Question Header Policy',
      repository_path: repositoryPath,
      remote_url: null,
      default_branch: 'main',
      status: 'active',
    };
    const harness = await createHarness({
      signedInRole: 'developer',
      projects: [project],
      accessRows: [{ user_id: USER_IDS.developer, project_id: project.id, is_default: true, github_account_id: null }],
      branchRows: [{
        user_id: USER_IDS.developer,
        project_id: project.id,
        branch_name: 'main',
        workspace_path: repositoryPath,
        is_default: true,
      }],
    });
    const login = await passwordLogin(harness, { role: 'developer' });
    const principal = await harness.runtime.resolvePrincipal(makeRequest({ cookie: login.cookie }));
    const assignment = principal.assignments[0];
    const worktreePath = path.join(assignment.worktreeContainerPath, 'sdk-feature');

    for (const directoryHeader of [
      repositoryPath,
      encodeURIComponent(repositoryPath),
      encodeURIComponent(worktreePath),
      literalPercentPath,
    ]) {
      const request = makeRequest({
        cookie: login.cookie,
        method: 'POST',
        path: '/question/que_test/reply',
        csrf: true,
      });
      request.headers['x-opencode-directory'] = directoryHeader;
      const response = makeResponse();
      const next = vi.fn(() => response.json({ allowed: true }));

      await harness.runtime.authController.requireAuth(request, response, next);

      expect(response.statusCode, directoryHeader).toBe(200);
      expect(next, directoryHeader).toHaveBeenCalledOnce();
      expect(request.headers['x-opencode-directory']).toBe(
        await harness.runtime.translateDirectoryValue(
          principal,
          directoryHeader === literalPercentPath
            ? directoryHeader
            : decodeURIComponent(directoryHeader),
        ),
      );
    }

    const traversalPath = path.join(repositoryPath, '..', path.basename(outsidePath));
    for (const directoryHeader of [
      '%E0%A4%A',
      encodeURIComponent(outsidePath),
      encodeURIComponent(traversalPath),
      encodeURIComponent(symlinkEscapePath),
    ]) {
      const request = makeRequest({
        cookie: login.cookie,
        method: 'POST',
        path: '/question/que_test/reply',
        csrf: true,
      });
      request.headers['x-opencode-directory'] = directoryHeader;
      const response = makeResponse();
      const next = vi.fn();

      await harness.runtime.authController.requireAuth(request, response, next);

      expect(response.statusCode, directoryHeader).toBe(403);
      expect(response.payload).toEqual({ error: 'Directory is outside your assigned workspace' });
      expect(next, directoryHeader).not.toHaveBeenCalled();
    }
  });

  it('updates managed project metadata for administrators and projects it into settings', async () => {
    const project = {
      id: '33333333-3333-4333-8333-333333333333',
      label: 'Before',
      repository_path: '/tmp/devryan-managed-project',
      remote_url: null,
      default_branch: 'main',
      status: 'active',
      icon: null,
      color: null,
      icon_background: null,
      icon_image: null,
    };
    const harness = await createHarness({
      signedInRole: 'admin',
      projects: [project],
      accessRows: [{ user_id: USER_IDS.admin, project_id: project.id, is_default: true, github_account_id: null }],
      branchRows: [{
        user_id: USER_IDS.admin,
        project_id: project.id,
        branch_name: 'main',
        workspace_path: project.repository_path,
        is_default: true,
      }],
    });
    const login = await passwordLogin(harness, { role: 'admin' });
    const handlers = new Map();
    const app = Object.fromEntries(['get', 'post', 'put', 'patch', 'delete'].map((method) => [
      method,
      (route, handler) => handlers.set(`${method.toUpperCase()} ${route}`, handler),
    ]));
    harness.runtime.registerRoutes(app, {
      readSettingsFromDiskMigrated: async () => ({ themeId: 'host-theme' }),
    });

    const principal = await harness.runtime.resolvePrincipal(makeRequest({ cookie: login.cookie }));
    const updateResponse = makeResponse();
    await handlers.get('PUT /api/admin/projects/:projectId')({
      body: { label: 'After', icon: 'code', color: 'blue', iconBackground: '#ffffff' },
      params: { projectId: project.id },
      principal,
    }, updateResponse);
    expect(updateResponse.statusCode).toBe(200);

    const refreshedPrincipal = await harness.runtime.resolvePrincipal(makeRequest({ cookie: login.cookie }));
    const settingsResponse = makeResponse();
    await handlers.get('GET /api/config/settings')({ principal: refreshedPrincipal }, settingsResponse, vi.fn());
    expect(settingsResponse.payload.projects).toEqual([expect.objectContaining({
      id: project.id,
      label: 'After',
      path: project.repository_path,
      icon: 'code',
      color: 'blue',
      iconBackground: '#ffffff',
      branches: [{ name: 'main', directory: project.repository_path, isDefault: true }],
    })]);

    const forbiddenResponse = makeResponse();
    await handlers.get('PUT /api/admin/projects/:projectId')({
      body: { label: 'Forbidden' },
      params: { projectId: project.id },
      principal: {
        ...principal,
        role: 'developer',
        policy: {
          ...principal.policy,
          settingsPages: [],
          settingsPermissions: { users: { read: false, edit: false } },
          manageUsers: false,
        },
      },
    }, forbiddenResponse);
    expect(forbiddenResponse.statusCode).toBe(403);
  });

  it('preserves a valid local session when token refresh has a transient outage', async () => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const harness = await createHarness({ tokenExpiresAt: Math.floor(now / 1000) - 1 });
    const login = await passwordLogin(harness);
    now += 6_000;
    harness.setRefreshUnavailable(true);

    const statusResponse = makeResponse();
    await harness.runtime.authController.handleSessionStatus(makeRequest({ cookie: login.cookie }), statusResponse);

    expect(statusResponse.statusCode).toBe(503);
    expect(statusResponse.payload).toMatchObject({ code: 'identity_unavailable', localResetAvailable: true });
    expect(statusResponse.getHeader('set-cookie')).toBeUndefined();
    const vault = await createSessionVault({ dataDirectory: harness.directory });
    const token = decodeURIComponent(login.cookie.slice('oc_app_session='.length));
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    expect(vault.findByTokenHash(tokenHash)).not.toBeNull();
  });

  it('uses remembered-administrator offline grace without discarding the session', async () => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const harness = await createHarness({ signedInRole: 'admin' });
    const login = await passwordLogin(harness, { role: 'admin', trustDevice: true });
    now += 6_000;
    harness.setAppSessionUnavailable(true);

    const statusResponse = makeResponse();
    await harness.runtime.authController.handleSessionStatus(makeRequest({ cookie: login.cookie }), statusResponse);

    expect(statusResponse.statusCode).toBe(200);
    expect(statusResponse.payload).toMatchObject({
      authenticated: true,
      offlineGrace: true,
      principal: { role: 'admin' },
    });
    expect(statusResponse.getHeader('set-cookie')).toBeUndefined();
  });

  it('clears local state deterministically when remote revocation fails', async () => {
    const harness = await createHarness();
    const login = await passwordLogin(harness);
    const closeConnection = vi.fn();
    const connectionPrincipal = await harness.runtime.resolvePrincipal(makeRequest({ cookie: login.cookie }));
    harness.runtime.registerConnection(connectionPrincipal, closeConnection);
    harness.setAppSessionUnavailable(true);

    const logoutResponse = makeResponse();
    await harness.runtime.authController.handleLogout(makeRequest({
      method: 'DELETE',
      cookie: login.cookie,
    }), logoutResponse);

    expect(logoutResponse.statusCode).toBe(503);
    expect(logoutResponse.payload).toMatchObject({
      localSessionCleared: true,
      localVaultCleared: true,
      remoteRevoked: false,
      code: 'identity_unavailable',
    });
    expect(String(logoutResponse.getHeader('set-cookie'))).toContain('Max-Age=0');
    expect(closeConnection).toHaveBeenCalledOnce();
    const vault = await createSessionVault({ dataDirectory: harness.directory });
    const token = decodeURIComponent(login.cookie.slice('oc_app_session='.length));
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    expect(vault.findByTokenHash(tokenHash)).toBeNull();
  });

  it('prepares a fresh tunnel login without aborting owned work', async () => {
    const harness = await createHarness();
    const login = await passwordLogin(harness);
    const closeConnection = vi.fn();
    const terminateOwnedTerminals = vi.fn();
    const principal = await harness.runtime.resolvePrincipal(makeRequest({ cookie: login.cookie }));
    harness.runtime.registerConnection(principal, closeConnection);
    harness.runtime.setTerminalOwnerTerminator(terminateOwnedTerminals);
    const response = makeResponse();

    await harness.runtime.authController.prepareFreshTunnelLogin(
      makeRequest({ cookie: login.cookie, loopback: false }),
      response,
    );

    expect(String(response.getHeader('set-cookie'))).toContain('oc_app_session=');
    expect(String(response.getHeader('set-cookie'))).toContain('Max-Age=0');
    expect(closeConnection).toHaveBeenCalledOnce();
    expect(terminateOwnedTerminals).not.toHaveBeenCalled();
    const vault = await createSessionVault({ dataDirectory: harness.directory });
    const token = decodeURIComponent(login.cookie.slice('oc_app_session='.length));
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    expect(vault.findByTokenHash(tokenHash)).toBeNull();
  });

  it('leaves the browser session intact when fresh-login revocation cannot be confirmed', async () => {
    const harness = await createHarness();
    const login = await passwordLogin(harness);
    const closeConnection = vi.fn();
    const principal = await harness.runtime.resolvePrincipal(makeRequest({ cookie: login.cookie }));
    harness.runtime.registerConnection(principal, closeConnection);
    harness.setAppSessionUnavailable(true);
    const response = makeResponse();

    await expect(harness.runtime.authController.prepareFreshTunnelLogin(
      makeRequest({ cookie: login.cookie, loopback: false }),
      response,
    )).rejects.toMatchObject({ code: 'fresh_login_cleanup_failed' });

    expect(response.getHeader('set-cookie')).toBeUndefined();
    expect(closeConnection).not.toHaveBeenCalled();
    const vault = await createSessionVault({ dataDirectory: harness.directory });
    const token = decodeURIComponent(login.cookie.slice('oc_app_session='.length));
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    expect(vault.findByTokenHash(tokenHash)).not.toBeNull();
  });

  it('returns 401 and expires the cookie for a revoked session', async () => {
    const harness = await createHarness();
    const login = await passwordLogin(harness);
    const logoutResponse = makeResponse();
    await harness.runtime.authController.handleLogout(makeRequest({
      method: 'POST',
      cookie: login.cookie,
    }), logoutResponse);
    expect(logoutResponse.statusCode).toBe(200);

    const statusResponse = makeResponse();
    await harness.runtime.authController.handleSessionStatus(makeRequest({ cookie: login.cookie }), statusResponse);
    expect(statusResponse.statusCode).toBe(401);
    expect(statusResponse.payload).toMatchObject({ authenticated: false, locked: true });
    expect(String(statusResponse.getHeader('set-cookie'))).toContain('Max-Age=0');
  });

  it('advertises unique agent fixtures only on loopback in developer-first order', async () => {
    const harness = await createHarness();
    const loopbackResponse = makeResponse();
    await harness.runtime.authController.handleSessionStatus(makeRequest(), loopbackResponse);
    expect(loopbackResponse.statusCode).toBe(401);
    expect(loopbackResponse.payload.agentTestIdentities).toEqual([
      { role: 'developer', label: 'Test Developer' },
      { role: 'admin', label: 'Test Administrator' },
    ]);

    const remoteResponse = makeResponse();
    await harness.runtime.authController.handleSessionStatus(makeRequest({ loopback: false }), remoteResponse);
    expect(remoteResponse.statusCode).toBe(401);
    expect(remoteResponse.payload).not.toHaveProperty('agentTestIdentities');
  });

  it('logs in by role through the audited agent-session flow and rejects remote callers', async () => {
    const harness = await createHarness();
    const response = makeResponse();
    await harness.runtime.authController.handleAgentTestSession(makeRequest({
      method: 'POST',
      body: { role: 'developer' },
    }), response);

    expect(response.statusCode).toBe(200);
    expect(response.payload.principal).toMatchObject({ role: 'developer', scope: 'managed' });
    expect(harness.getMintedEmail()).toBe('developer@example.test');
    expect(harness.auditEvents).toContainEqual(expect.objectContaining({
      action: 'auth.agent_test_login',
      actor_role: 'developer',
      metadata: expect.objectContaining({ agentTestRole: 'developer' }),
    }));

    const remoteResponse = makeResponse();
    await harness.runtime.authController.handleAgentTestSession(makeRequest({
      loopback: false,
      method: 'POST',
      body: { role: 'admin' },
    }), remoteResponse);
    expect(remoteResponse.statusCode).toBe(403);
    expect(remoteResponse.payload.error).toContain('loopback-only');
  });

  it('records only accepted human prompts, deduplicates retries by message id, and gates detailed analytics to admins', async () => {
    const harness = await createHarness();
    const handlers = new Map();
    const app = Object.fromEntries(['get', 'post', 'put', 'patch', 'delete', 'use'].map((method) => [
      method,
      (route, handler) => handlers.set(`${method.toUpperCase()} ${route}`, handler),
    ]));
    harness.runtime.registerRoutes(app);
    const principal = {
      scope: 'managed',
      id: USER_IDS.developer,
      role: 'developer',
      assignments: [{
        projectId: '33333333-3333-4333-8333-333333333333',
        label: 'Test',
        branchName: 'main',
        publicDirectory: '/repo',
        repositoryPath: '/repo',
        isDefault: true,
      }],
    };
    const promptHandler = handlers.get('POST /api/session/:sessionID/prompt_async');
    const request = {
      body: {
        messageID: 'msg_retry',
        model: { providerID: 'openai', modelID: 'gpt-5' },
        agent: 'builder',
        parts: [{ type: 'text', text: 'Human prompt' }, { type: 'text', text: 'hidden', synthetic: true }],
      },
      headers: { 'x-devryan-prompt-origin': 'human', 'x-opencode-directory': '/repo' },
      method: 'POST',
      params: { sessionID: 'ses_1' },
      path: '/session/ses_1/prompt_async',
      principal,
      url: '/session/ses_1/prompt_async',
    };

    const failed = makeResponse();
    await promptHandler(request, failed, () => failed.status(503).json({ error: 'not accepted' }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(harness.auditEvents.some((event) => event.action === 'prompt.sent')).toBe(false);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const accepted = makeResponse();
      await promptHandler(request, accepted, () => accepted.status(202).json({ accepted: true }));
    }
    for (let attempt = 0; attempt < 50 && harness.auditEvents.filter((event) => event.action === 'prompt.sent').length < 1; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const prompts = harness.auditEvents.filter((event) => event.action === 'prompt.sent');
    expect(prompts).toHaveLength(1);
    expect(new Set(prompts.map((event) => event.event_id)).size).toBe(1);
    expect(prompts[0].metadata).toMatchObject({
      promptText: 'Human prompt', agent: 'builder', providerId: 'openai', modelId: 'gpt-5',
    });
    expect(JSON.stringify(prompts)).not.toContain('hidden');

    const denied = makeResponse();
    await handlers.get('GET /api/admin/users/:userId/analytics/daily')({
      principal, params: { userId: USER_IDS.developer }, query: { date: '2026-08-05', timeZone: 'UTC' },
    }, denied);
    expect(denied.statusCode).toBe(403);
    expect(denied.payload.error).toContain('Administrator');
  });

  it('accepts bounded interaction batches without copied content or caller-selected identities', async () => {
    const harness = await createHarness();
    const handlers = new Map();
    const app = Object.fromEntries(['get', 'post', 'put', 'patch', 'delete', 'use'].map((method) => [
      method,
      (route, handler) => handlers.set(`${method.toUpperCase()} ${route}`, handler),
    ]));
    harness.runtime.registerRoutes(app);
    const principal = {
      scope: 'managed', id: USER_IDS.developer, role: 'developer', assignments: [{
        projectId: '33333333-3333-4333-8333-333333333333', label: 'Test', branchName: 'main',
        publicDirectory: '/repo', repositoryPath: '/repo', isDefault: true,
      }],
    };
    const response = makeResponse();
    await handlers.get('POST /api/analytics/events')({
      body: { events: [
        {
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', type: 'file.opened',
          occurredAt: new Date().toISOString(), directory: '/repo', sourceSurface: 'files', path: 'package.json',
        },
        {
          id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', type: 'clipboard.copied',
          occurredAt: new Date().toISOString(), directory: '/repo', sourceSurface: 'editor',
          copyKind: 'text', characterCount: 12, text: 'must be rejected',
        },
      ] },
      principal,
    }, response, vi.fn());
    expect(response.payload.results).toEqual([
      { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', accepted: true },
      { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', accepted: false, error: 'Event includes an unsupported field' },
    ]);
    const opened = await waitForAudit(harness, 'file.opened');
    expect(opened).toMatchObject({
      actor_user_id: USER_IDS.developer,
      target_user_id: USER_IDS.developer,
      metadata: expect.objectContaining({ filePath: 'package.json', sourceSurface: 'files' }),
    });
    expect(JSON.stringify(harness.auditEvents)).not.toContain('must be rejected');
  });
});
