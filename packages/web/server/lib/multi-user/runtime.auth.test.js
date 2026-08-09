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

const deferred = () => {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

const waitForCondition = async (predicate) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('Timed out waiting for test condition');
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
  activityRows = [],
  githubAccounts = [],
  userPolicies = [],
  githubUniqueViolationAccountId = null,
  missingGithubAccountColumn = false,
  missingGithubReassignmentFunction = false,
  missingAnalyticsRetentionFunctions = false,
  activityPurgeResult = { deletedCount: 0, protectedCount: 0 },
  dependencyUnavailableAtStartup = false,
  dependencyFailureStatusAtStartup = 0,
  localOwnershipRows = [],
  onManagedProjectMetadataChanged = vi.fn(),
  onManagedSessionOwnershipCommitted = vi.fn(),
  ownershipWriteFailures = 0,
  ownershipWriteGate = null,
} = {}) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-runtime-auth-'));
  temporaryDirectories.push(directory);
  await fs.writeFile(path.join(directory, 'supabase.json'), JSON.stringify({
    url: 'https://project.supabase.test',
    publishableKey: 'sb_publishable_public',
    secretKey: 'sb_secret_private',
  }), { mode: 0o600 });
  if (localOwnershipRows.length > 0) {
    const ownershipDirectory = path.join(directory, 'multi-user');
    await fs.mkdir(ownershipDirectory, { recursive: true, mode: 0o700 });
    await fs.writeFile(
      path.join(ownershipDirectory, 'session-ownership.json'),
      JSON.stringify({ version: 1, rows: localOwnershipRows }),
      { mode: 0o600 },
    );
  }

  const sessions = new Map();
  const auditEvents = [];
  let appSessionUnavailable = false;
  let refreshUnavailable = false;
  let ownershipArchiveUnavailable = false;
  let openCodeDeleteUnavailable = false;
  let dependencyUnavailable = dependencyUnavailableAtStartup;
  let remainingOwnershipWriteFailures = ownershipWriteFailures;
  let ownershipWriteAttemptCount = 0;
  let openCodeSessionCreateCount = 0;
  let mintedEmail = '';
  const analyticsRetentionLocks = new Map();
  const openCodeDeleteRequests = [];
  const mutableProfiles = profiles.map((profile) => ({ ...profile }));
  const mutableOwnershipRows = ownershipRows.map((row) => ({ ...row }));
  const mutableOpenCodeSessions = openCodeSessions.map((session) => structuredClone(session));
  const mutableActivityRows = activityRows.map((row) => structuredClone(row));
  const projectsById = new Map(projects.map((project) => [project.id, { ...project }]));
  const githubAccountsById = new Map(githubAccounts.map((account) => [account.accountId, structuredClone(account)]));

  const profileById = (id) => mutableProfiles.find((profile) => profile.id === id) || null;
  const fetchImpl = vi.fn(async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : null;

    if (url.hostname === 'opencode.test') {
      if (url.pathname === '/session') {
        if (method === 'POST') {
          openCodeSessionCreateCount += 1;
          const session = {
            id: `created-session-${openCodeSessionCreateCount}`,
            title: body?.title || `New session - ${new Date().toISOString()}`,
            directory: body?.directory || '',
            ...(body?.parentID ? { parentID: body.parentID } : {}),
            time: { created: Date.now(), updated: Date.now() },
          };
          mutableOpenCodeSessions.push(session);
          return jsonResponse(session);
        }
        return jsonResponse(mutableOpenCodeSessions);
      }
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
          openCodeDeleteRequests.push({ sessionId, url: url.toString() });
          if (openCodeDeleteUnavailable) return jsonResponse({ message: 'delete unavailable' }, 503);
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

    if (dependencyUnavailable) {
      const error = new TypeError('fetch failed');
      error.cause = Object.assign(new Error(`getaddrinfo ENOTFOUND ${url.hostname}`), { code: 'ENOTFOUND' });
      throw error;
    }
    if (dependencyFailureStatusAtStartup > 0) {
      return jsonResponse({ message: 'invalid control-plane configuration' }, dependencyFailureStatusAtStartup);
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
    if (url.pathname === '/rest/v1/rpc/devryan_lock_user_analytics_retention') {
      if (missingAnalyticsRetentionFunctions) {
        return jsonResponse({
          code: 'PGRST202',
          message: 'Could not find the function public.devryan_lock_user_analytics_retention in the schema cache',
        }, 404);
      }
      const profile = profileById(body?.p_user_id);
      const lockable = profile?.role === 'developer' || profile?.role === 'senior_developer';
      if (lockable && !analyticsRetentionLocks.has(profile.id)) {
        analyticsRetentionLocks.set(profile.id, new Date().toISOString());
      }
      return jsonResponse({
        locked: lockable,
        protectedAt: lockable ? analyticsRetentionLocks.get(profile.id) : null,
      });
    }
    if (url.pathname === '/rest/v1/rpc/devryan_purge_unprotected_activity_logs') {
      if (missingAnalyticsRetentionFunctions) {
        return jsonResponse({
          code: 'PGRST202',
          message: 'Could not find the function public.devryan_purge_unprotected_activity_logs in the schema cache',
        }, 404);
      }
      return jsonResponse(activityPurgeResult);
    }
    if (!url.pathname.startsWith('/rest/v1/')) return jsonResponse({ message: 'not found' }, 404);

    const table = decodeURIComponent(url.pathname.slice('/rest/v1/'.length));
    if (table === 'opencode_session_ownership') {
      const sessionFilter = url.searchParams.get('session_id');
      const matching = mutableOwnershipRows.filter((row) => (
        !sessionFilter || row.session_id === sessionFilter.replace(/^eq\./, '')
      ));
      if (method === 'POST') {
        ownershipWriteAttemptCount += 1;
        if (ownershipWriteGate) await ownershipWriteGate.promise;
        if (remainingOwnershipWriteFailures > 0) {
          remainingOwnershipWriteFailures -= 1;
          const error = new Error('Session ownership request timed out');
          error.name = 'TimeoutError';
          throw error;
        }
        if (!mutableOwnershipRows.some((row) => row.session_id === body.session_id)) {
          mutableOwnershipRows.push({ ...body, archived_at: body.archived_at || null });
        }
        return jsonResponse([]);
      }
      if (method === 'DELETE') {
        for (let index = mutableOwnershipRows.length - 1; index >= 0; index -= 1) {
          if (!sessionFilter || mutableOwnershipRows[index].session_id === sessionFilter.replace(/^eq\./, '')) {
            mutableOwnershipRows.splice(index, 1);
          }
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
      if (method === 'GET') {
        const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));
        const limit = Math.max(1, Number(url.searchParams.get('limit') || 1_000));
        return jsonResponse(mutableActivityRows.slice(offset, offset + limit));
      }
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
    onManagedProjectMetadataChanged,
    onManagedSessionOwnershipCommitted,
    sessionOwnershipRetryOptions: {
      attempts: 4,
      timeoutMs: 5,
      delaysMs: [0, 0, 0],
    },
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
    analyticsRetentionLocks,
    directory,
    fetchImpl,
    getMintedEmail: () => mintedEmail,
    getOpenCodeSessionCreateCount: () => openCodeSessionCreateCount,
    getOwnershipWriteAttemptCount: () => ownershipWriteAttemptCount,
    getProfile: (userId) => profileById(userId),
    getOwnership: (sessionId) => mutableOwnershipRows.find((row) => row.session_id === sessionId) || null,
    getOpenCodeSession: (sessionId) => mutableOpenCodeSessions.find((session) => session.id === sessionId) || null,
    getGitHubAccount: (accountId) => githubAccountsById.get(accountId) || null,
    runtime,
    onManagedProjectMetadataChanged,
    onManagedSessionOwnershipCommitted,
    openCodeDeleteRequests,
    projectsById,
    setAppSessionUnavailable(value) { appSessionUnavailable = value; },
    setOwnershipArchiveUnavailable(value) { ownershipArchiveUnavailable = value; },
    setOpenCodeDeleteUnavailable(value) { openCodeDeleteUnavailable = value; },
    setRefreshUnavailable(value) { refreshUnavailable = value; },
    setDependencyUnavailable(value) { dependencyUnavailable = value; },
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
  it('filters managed-task events by root-session ownership', async () => {
    const repositoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-managed-task-events-'));
    temporaryDirectories.push(repositoryPath);
    const project = {
      id: '33333333-3333-4333-8333-333333333333',
      label: 'Managed Task Project',
      repository_path: repositoryPath,
      remote_url: null,
      default_branch: 'main',
      status: 'active',
    };
    const ownership = (sessionId, userId) => ({
      session_id: sessionId,
      user_id: userId,
      project_id: project.id,
      branch_name: 'main',
      public_directory: '/projects/managed-task/main',
      archived_at: null,
    });
    const harness = await createHarness({
      projects: [project],
      accessRows: [
        { user_id: USER_IDS.developer, project_id: project.id, is_default: true, github_account_id: null },
        { user_id: USER_IDS.admin, project_id: project.id, is_default: true, github_account_id: null },
      ],
      branchRows: [
        { user_id: USER_IDS.developer, project_id: project.id, branch_name: 'main', workspace_path: repositoryPath, is_default: true },
        { user_id: USER_IDS.admin, project_id: project.id, branch_name: 'main', workspace_path: repositoryPath, is_default: true },
      ],
      ownershipRows: [
        ownership('developer-root', USER_IDS.developer),
        ownership('foreign-root', USER_IDS.admin),
      ],
    });
    const login = await passwordLogin(harness);
    const principal = await harness.runtime.resolvePrincipal(makeRequest({ cookie: login.cookie }));
    const filterGlobalEvent = (payload) => harness.runtime.filterEventForPrincipal(principal, {
      payload,
      directory: 'global',
    });
    const managedTaskEvent = (task) => ({
      type: 'openchamber:managed-task',
      properties: { owner: 'devryan', task },
    });

    const running = managedTaskEvent({
      taskId: 'dvr_task_running',
      rootSessionId: 'developer-root',
      status: 'running',
    });
    const terminal = managedTaskEvent({
      taskId: 'dvr_task_terminal',
      rootSessionId: 'developer-root',
      status: 'completed',
      resultEnvelope: { taskId: 'dvr_task_terminal', status: 'completed' },
    });
    const acknowledged = managedTaskEvent({
      taskId: 'dvr_task_acknowledged',
      rootSessionId: 'developer-root',
      status: 'completed',
      acknowledgedAt: 1_000,
    });

    await expect(Promise.all([
      filterGlobalEvent(running),
      filterGlobalEvent(terminal),
      filterGlobalEvent(acknowledged),
    ])).resolves.toEqual([true, true, true]);

    await expect(filterGlobalEvent({
      type: 'openchamber:managed-task-removed',
      properties: {
        owner: 'devryan',
        taskId: 'dvr_task_removed',
        rootSessionId: 'developer-root',
      },
    })).resolves.toBe(true);
    await expect(filterGlobalEvent({
      type: 'openchamber:managed-task-removed',
      properties: {
        owner: 'devryan',
        taskId: 'dvr_task_foreign_removed',
        rootSessionId: 'foreign-root',
      },
    })).resolves.toBe(false);

    const deniedSyntheticEvents = [
      managedTaskEvent({ taskId: 'dvr_task_foreign', rootSessionId: 'foreign-root', status: 'running' }),
      {
        type: 'openchamber:managed-task',
        sessionID: 'developer-root',
        properties: {
          owner: 'another-runtime',
          task: { taskId: 'dvr_task_wrong_owner', rootSessionId: 'developer-root', status: 'running' },
        },
      },
      {
        type: 'openchamber:managed-task',
        sessionID: 'developer-root',
        properties: { owner: 'devryan', task: { taskId: 'dvr_task_missing_root', status: 'running' } },
      },
      {
        type: 'openchamber:managed-task-removed',
        sessionID: 'developer-root',
        properties: { owner: 'devryan', taskId: 'dvr_task_missing_removed_root' },
      },
      { type: 'openchamber:synthetic-event', properties: { owner: 'devryan' } },
    ];
    for (const event of deniedSyntheticEvents) {
      await expect(filterGlobalEvent(event)).resolves.toBe(false);
    }
    await expect(harness.runtime.filterEventForPrincipal(principal, {
      payload: {
        type: 'openchamber:managed-task',
        properties: {
          owner: 'another-runtime',
          task: { taskId: 'dvr_task_assigned_directory', rootSessionId: 'developer-root', status: 'running' },
        },
      },
      directory: repositoryPath,
    })).resolves.toBe(false);

    await expect(filterGlobalEvent({ type: 'openchamber:heartbeat' })).resolves.toBe(true);
    await expect(filterGlobalEvent({ type: 'server.connected' })).resolves.toBe(true);
    await expect(filterGlobalEvent({
      type: 'session.status',
      properties: { sessionID: 'developer-root' },
    })).resolves.toBe(true);
    await expect(filterGlobalEvent({
      type: 'session.status',
      properties: { sessionID: 'foreign-root' },
    })).resolves.toBe(false);
  });

  it('keeps one root session provisional while retrying ownership against the same id', async () => {
    const repositoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-session-create-'));
    temporaryDirectories.push(repositoryPath);
    const project = {
      id: '33333333-3333-4333-8333-333333333333',
      label: 'Session Create Project',
      repository_path: repositoryPath,
      remote_url: null,
      default_branch: 'main',
      status: 'active',
    };
    const ownershipWriteGate = deferred();
    const harness = await createHarness({
      signedInRole: 'admin',
      projects: [project],
      accessRows: [{ user_id: USER_IDS.admin, project_id: project.id, is_default: true, github_account_id: null }],
      branchRows: [{
        user_id: USER_IDS.admin,
        project_id: project.id,
        branch_name: 'main',
        workspace_path: repositoryPath,
        is_default: true,
      }],
      ownershipWriteFailures: 3,
      ownershipWriteGate,
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
    const principal = {
      scope: 'managed',
      id: USER_IDS.admin,
      role: 'admin',
      assignments: [{
        projectId: project.id,
        branchName: 'main',
        publicDirectory: '/projects/session-create/main',
        repositoryPath,
        isDefault: true,
      }],
    };
    const response = makeResponse();
    const createPromise = handlers.get('POST /api/session')({
      ...makeRequest({
        body: { directory: repositoryPath },
        method: 'POST',
        path: '/api/session',
        csrf: true,
      }),
      originalUrl: '/api/session',
      principal,
    }, response, vi.fn());

    await waitForCondition(() => (
      harness.getOpenCodeSessionCreateCount() === 1
      && harness.getOwnershipWriteAttemptCount() === 1
    ));
    const provisional = harness.getOpenCodeSession('created-session-1');
    await expect(harness.runtime.filterEventForPrincipal(principal, {
      payload: { type: 'session.created', properties: { info: provisional } },
      directory: repositoryPath,
    })).resolves.toBe(false);

    const listResponse = makeResponse();
    await handlers.get('GET /api/session')({
      ...makeRequest({ path: '/api/session' }),
      originalUrl: '/api/session',
      principal,
    }, listResponse, vi.fn());
    expect(listResponse.payload).toEqual([]);

    ownershipWriteGate.resolve();
    await createPromise;

    expect(response.statusCode).toBe(200);
    expect(response.payload?.id).toBe('created-session-1');
    expect(harness.getOpenCodeSessionCreateCount()).toBe(1);
    expect(harness.getOwnershipWriteAttemptCount()).toBe(4);
    expect(harness.getOwnership('created-session-1')).toEqual(expect.objectContaining({
      user_id: USER_IDS.admin,
      project_id: project.id,
    }));
    await expect(harness.runtime.ownsSession(principal, 'created-session-1')).resolves.toBe(true);
    expect(harness.onManagedSessionOwnershipCommitted).toHaveBeenCalledTimes(1);
    expect(harness.onManagedSessionOwnershipCommitted).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'created-session-1' }),
    );
  });

  it('rolls back one hidden root session after ownership retries are exhausted', async () => {
    const repositoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-session-create-failure-'));
    temporaryDirectories.push(repositoryPath);
    const project = {
      id: '33333333-3333-4333-8333-333333333333',
      label: 'Session Create Failure Project',
      repository_path: repositoryPath,
      remote_url: null,
      default_branch: 'main',
      status: 'active',
    };
    const harness = await createHarness({
      signedInRole: 'admin',
      projects: [project],
      accessRows: [{ user_id: USER_IDS.admin, project_id: project.id, is_default: true, github_account_id: null }],
      branchRows: [{
        user_id: USER_IDS.admin,
        project_id: project.id,
        branch_name: 'main',
        workspace_path: repositoryPath,
        is_default: true,
      }],
      ownershipWriteFailures: 4,
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
    const principal = {
      scope: 'managed',
      id: USER_IDS.admin,
      role: 'admin',
      assignments: [{
        projectId: project.id,
        branchName: 'main',
        publicDirectory: '/projects/session-create-failure/main',
        repositoryPath,
        isDefault: true,
      }],
    };
    const response = makeResponse();

    await handlers.get('POST /api/session')({
      ...makeRequest({
        body: { directory: repositoryPath },
        method: 'POST',
        path: '/api/session',
        csrf: true,
      }),
      originalUrl: '/api/session',
      principal,
    }, response, vi.fn());

    expect(response.statusCode).toBe(503);
    expect(response.payload).toEqual({
      error: 'Identity service unavailable',
      code: 'identity_unavailable',
      retryable: false,
    });
    expect(harness.getOpenCodeSessionCreateCount()).toBe(1);
    expect(harness.getOwnershipWriteAttemptCount()).toBe(4);
    expect(harness.getOpenCodeSession('created-session-1')).toBeNull();
    expect(harness.getOwnership('created-session-1')).toBeNull();
    expect(harness.onManagedSessionOwnershipCommitted).not.toHaveBeenCalled();
    expect(harness.auditEvents).not.toContainEqual(expect.objectContaining({
      action: 'session.created',
      session_id: 'created-session-1',
    }));
  });

  it('allows owned-plan routes for developers without opening generic filesystem access', async () => {
    const repositoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-plan-policy-'));
    const outsidePath = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-plan-policy-outside-'));
    temporaryDirectories.push(repositoryPath, outsidePath);
    const project = {
      id: '33333333-3333-4333-8333-333333333333',
      label: 'Plan Project',
      repository_path: repositoryPath,
      remote_url: null,
      default_branch: 'main',
      status: 'active',
    };
    const harness = await createHarness({
      projects: [project],
      accessRows: [{ user_id: USER_IDS.developer, project_id: project.id, is_default: true, github_account_id: null }],
      branchRows: [{
        user_id: USER_IDS.developer,
        project_id: project.id,
        branch_name: 'main',
        workspace_path: repositoryPath,
        is_default: true,
      }],
      ownershipRows: [
        {
          session_id: 'ses-owned',
          user_id: USER_IDS.developer,
          project_id: project.id,
          branch_name: 'main',
          public_directory: repositoryPath,
          archived_at: null,
        },
        {
          session_id: 'ses-foreign',
          user_id: USER_IDS.admin,
          project_id: project.id,
          branch_name: 'main',
          public_directory: repositoryPath,
          archived_at: null,
        },
        {
          session_id: 'ses-archived',
          user_id: USER_IDS.developer,
          project_id: project.id,
          branch_name: 'main',
          public_directory: repositoryPath,
          archived_at: new Date().toISOString(),
        },
        {
          session_id: 'ses-revoked',
          user_id: USER_IDS.developer,
          project_id: '44444444-4444-4444-8444-444444444444',
          branch_name: 'main',
          public_directory: repositoryPath,
          archived_at: null,
        },
      ],
    });
    const login = await passwordLogin(harness);
    const principal = await harness.runtime.resolvePrincipal(makeRequest({ cookie: login.cookie }));

    await expect(harness.runtime.resolveOwnedSessionPlanContext(
      principal,
      'ses-owned',
      repositoryPath,
    )).resolves.toEqual({
      directory: repositoryPath,
      projectId: project.id,
      branchName: 'main',
    });
    await expect(harness.runtime.resolveOwnedSessionPlanContext(
      principal,
      'ses-owned',
      outsidePath,
    )).resolves.toBeNull();
    await expect(harness.runtime.resolveOwnedSessionPlanContext(principal, 'ses-foreign')).resolves.toBeNull();
    await expect(harness.runtime.resolveOwnedSessionPlanContext(principal, 'ses-archived')).resolves.toBeNull();
    await expect(harness.runtime.resolveOwnedSessionPlanContext(principal, 'ses-revoked')).resolves.toBeNull();

    const allowedResponse = makeResponse();
    const allowedNext = vi.fn(() => allowedResponse.json({ ok: true }));
    await harness.runtime.authController.requireAuth(makeRequest({
      cookie: login.cookie,
      method: 'POST',
      path: '/session/ses-owned/plan-revisions/msg-plan-1',
      csrf: true,
      body: {
        directory: repositoryPath,
        sessionCreated: 123,
        sessionSlug: 'Plan',
        markdown: '# Plan',
      },
    }), allowedResponse, allowedNext);
    expect(allowedNext).toHaveBeenCalledOnce();
    expect(allowedResponse.statusCode).toBe(200);

    for (const method of ['GET', 'PUT']) {
      const response = makeResponse();
      const next = vi.fn(() => response.json({ ok: true }));
      await harness.runtime.authController.requireAuth(makeRequest({
        cookie: login.cookie,
        method,
        path: '/session/ses-owned/plan-revisions/msg-plan-1',
        csrf: method === 'PUT',
        body: method === 'PUT' ? {
          directory: repositoryPath,
          sessionCreated: 123,
          sessionSlug: 'Plan',
          markdown: '# Edited plan',
        } : {},
      }), response, next);
      expect(next).toHaveBeenCalledOnce();
      expect(response.statusCode).toBe(200);
    }

    const fsResponse = makeResponse();
    await harness.runtime.authController.requireAuth(
      makeRequest({ cookie: login.cookie, path: '/fs/home' }),
      fsResponse,
      vi.fn(),
    );
    expect(fsResponse.statusCode).toBe(403);
    expect(fsResponse.payload.error).toBe('File access is disabled by policy');

    const outsideResponse = makeResponse();
    await harness.runtime.authController.requireAuth(makeRequest({
      cookie: login.cookie,
      method: 'POST',
      path: '/session/ses-owned/plan-revisions/msg-plan-1',
      csrf: true,
      body: {
        directory: outsidePath,
        sessionCreated: 123,
        sessionSlug: 'Plan',
        markdown: '# Plan',
      },
    }), outsideResponse, vi.fn());
    expect(outsideResponse.statusCode).toBe(403);
    expect(outsideResponse.payload.error).toMatch(/outside your assigned workspace/i);
  });

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

  it('allows capability-gated Browser runtime mutations without opening host configuration', async () => {
    const harness = await createHarness();
    const login = await passwordLogin(harness);

    for (const requestPath of [
      '/browser/targets',
      '/browser/instances/register',
      '/browser/local-instances/status',
    ]) {
      const response = makeResponse();
      const next = vi.fn(() => response.json({ allowed: true }));
      await harness.runtime.authController.requireAuth(makeRequest({
        cookie: login.cookie,
        method: 'POST',
        path: requestPath,
        csrf: true,
      }), response, next);

      expect(response.statusCode, requestPath).toBe(200);
      expect(next, requestPath).toHaveBeenCalledOnce();
    }

    const deniedResponse = makeResponse();
    await harness.runtime.authController.requireAuth(makeRequest({
      cookie: login.cookie,
      method: 'POST',
      path: '/browser/config',
      csrf: true,
    }), deniedResponse, vi.fn());
    expect(deniedResponse.statusCode).toBe(403);
    expect(deniedResponse.payload.error).toBe('Host configuration is restricted to administrators');
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

  it('deletes owned legacy archived sessions by ownership without forwarding a directory scope', async () => {
    const repositoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-delete-current-'));
    const legacyDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-delete-legacy-'));
    temporaryDirectories.push(repositoryPath, legacyDirectory);
    const project = {
      id: '33333333-3333-4333-8333-333333333333',
      label: 'Delete Project',
      repository_path: repositoryPath,
      remote_url: null,
      default_branch: 'main',
      status: 'active',
    };
    const ownership = (sessionId, userId) => ({
      session_id: sessionId,
      user_id: userId,
      project_id: project.id,
      branch_name: 'main',
      public_directory: '/projects/delete/main',
      archived_at: null,
    });
    const harness = await createHarness({
      projects: [project],
      accessRows: [{ user_id: USER_IDS.developer, project_id: project.id, is_default: true, github_account_id: null }],
      branchRows: [{
        user_id: USER_IDS.developer,
        project_id: project.id,
        branch_name: 'main',
        workspace_path: repositoryPath,
        is_default: true,
      }],
      ownershipRows: [
        ownership('legacy-archived', USER_IDS.developer),
        ownership('current-archived', USER_IDS.developer),
        ownership('foreign-archived', USER_IDS.admin),
      ],
      openCodeSessions: [
        { id: 'legacy-archived', directory: legacyDirectory, time: { updated: 300, archived: 310 } },
        { id: 'current-archived', directory: repositoryPath, time: { updated: 200, archived: 210 } },
        { id: 'foreign-archived', directory: legacyDirectory, time: { updated: 100, archived: 110 } },
      ],
    });
    const { cookie } = await passwordLogin(harness);
    const handlers = new Map();
    const app = Object.fromEntries(['get', 'post', 'put', 'patch', 'delete', 'use'].map((method) => [
      method,
      (route, handler) => handlers.set(`${method.toUpperCase()} ${route}`, handler),
    ]));
    harness.runtime.registerRoutes(app, {
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
    });
    const deleteHandler = handlers.get('DELETE /api/session/:sessionID');

    const runDelete = async (sessionID, directory) => {
      const request = makeRequest({ cookie, method: 'DELETE', path: `/session/${sessionID}`, csrf: true });
      request.params = { sessionID };
      request.url = `/session/${sessionID}?directory=${encodeURIComponent(directory)}`;
      request.originalUrl = `/api/session/${sessionID}?directory=${encodeURIComponent(directory)}`;
      request.headers['x-opencode-directory'] = directory;
      request.body = { directory };
      const response = makeResponse();
      await harness.runtime.authController.requireAuth(request, response, () => deleteHandler(request, response, vi.fn()));
      return { request, response };
    };

    const legacy = await runDelete('legacy-archived', legacyDirectory);
    expect(legacy.response.statusCode).toBe(200);
    expect(legacy.request.url).toBe('/session/legacy-archived');
    expect(legacy.request.originalUrl).toBe('/api/session/legacy-archived');
    expect(legacy.request.body).toEqual({});
    expect(legacy.request.headers).not.toHaveProperty('x-opencode-directory');
    expect(harness.openCodeDeleteRequests[0]).toEqual({
      sessionId: 'legacy-archived',
      url: 'http://opencode.test/session/legacy-archived',
    });
    expect(harness.analyticsRetentionLocks.has(USER_IDS.developer)).toBe(true);
    expect(harness.getOwnership('legacy-archived')?.archived_at).toEqual(expect.any(String));

    const current = await runDelete('current-archived', repositoryPath);
    expect(current.response.statusCode).toBe(200);
    expect(harness.openCodeDeleteRequests[1]?.url).toBe('http://opencode.test/session/current-archived');

    const foreign = await runDelete('foreign-archived', legacyDirectory);
    expect(foreign.response.statusCode).toBe(404);
    expect(foreign.response.payload).toEqual({ error: 'Session not found' });
    expect(harness.openCodeDeleteRequests).toHaveLength(2);

    const otherRoute = makeRequest({ cookie, method: 'GET', path: '/session/legacy-archived/message' });
    otherRoute.url = `/session/legacy-archived/message?directory=${encodeURIComponent(legacyDirectory)}`;
    otherRoute.originalUrl = `/api/session/legacy-archived/message?directory=${encodeURIComponent(legacyDirectory)}`;
    const denied = makeResponse();
    await harness.runtime.authController.requireAuth(otherRoute, denied, vi.fn());
    expect(denied.statusCode).toBe(403);
    expect(denied.payload.error).toBe('Directory is outside your assigned workspace');
  });

  it('locks analytics before upstream deletion and fails closed when the migration is missing', async () => {
    const repositoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-delete-migration-'));
    temporaryDirectories.push(repositoryPath);
    const project = {
      id: '33333333-3333-4333-8333-333333333333', label: 'Delete Project', repository_path: repositoryPath,
      remote_url: null, default_branch: 'main', status: 'active',
    };
    const harness = await createHarness({
      missingAnalyticsRetentionFunctions: true,
      projects: [project],
      accessRows: [{ user_id: USER_IDS.developer, project_id: project.id, is_default: true, github_account_id: null }],
      branchRows: [{
        user_id: USER_IDS.developer, project_id: project.id, branch_name: 'main', workspace_path: repositoryPath, is_default: true,
      }],
      ownershipRows: [{
        session_id: 'migration-blocked', user_id: USER_IDS.developer, project_id: project.id,
        branch_name: 'main', public_directory: '/projects/delete/main', archived_at: null,
      }],
      openCodeSessions: [{ id: 'migration-blocked', directory: repositoryPath, time: { updated: 100, archived: 110 } }],
    });
    const { cookie } = await passwordLogin(harness);
    const handlers = new Map();
    const app = Object.fromEntries(['get', 'post', 'put', 'patch', 'delete', 'use'].map((method) => [
      method,
      (route, handler) => handlers.set(`${method.toUpperCase()} ${route}`, handler),
    ]));
    harness.runtime.registerRoutes(app, {
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
    });
    const request = makeRequest({ cookie, method: 'DELETE', path: '/session/migration-blocked', csrf: true });
    request.params = { sessionID: 'migration-blocked' };
    request.originalUrl = '/api/session/migration-blocked';
    const response = makeResponse();
    await harness.runtime.authController.requireAuth(
      request,
      response,
      () => handlers.get('DELETE /api/session/:sessionID')(request, response, vi.fn()),
    );

    expect(response.statusCode).toBe(503);
    expect(response.payload).toEqual({
      error: 'Database migration required',
      code: 'schema_migration_required',
      requiredMigration: '20260807100000',
    });
    expect(harness.openCodeDeleteRequests).toHaveLength(0);
    expect(harness.getOpenCodeSession('migration-blocked')).not.toBeNull();
    expect(harness.getOwnership('migration-blocked')?.archived_at).toBeNull();
    const audit = await waitForAudit(harness, 'session.deleted', 'migration-blocked');
    expect(audit).toEqual(expect.objectContaining({
      success: false,
      metadata: expect.objectContaining({ analyticsRetentionLocked: false, upstreamDeleted: false }),
    }));
  });

  it('keeps the developer retention lock when a later upstream delete fails', async () => {
    const repositoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-delete-upstream-'));
    temporaryDirectories.push(repositoryPath);
    const project = {
      id: '33333333-3333-4333-8333-333333333333', label: 'Delete Project', repository_path: repositoryPath,
      remote_url: null, default_branch: 'main', status: 'active',
    };
    const harness = await createHarness({
      projects: [project],
      accessRows: [{ user_id: USER_IDS.developer, project_id: project.id, is_default: true, github_account_id: null }],
      branchRows: [{
        user_id: USER_IDS.developer, project_id: project.id, branch_name: 'main', workspace_path: repositoryPath, is_default: true,
      }],
      ownershipRows: [{
        session_id: 'upstream-failed', user_id: USER_IDS.developer, project_id: project.id,
        branch_name: 'main', public_directory: '/projects/delete/main', archived_at: null,
      }],
      openCodeSessions: [{ id: 'upstream-failed', directory: repositoryPath, time: { updated: 100, archived: 110 } }],
    });
    harness.setOpenCodeDeleteUnavailable(true);
    const handlers = new Map();
    const app = Object.fromEntries(['get', 'post', 'put', 'patch', 'delete', 'use'].map((method) => [
      method,
      (route, handler) => handlers.set(`${method.toUpperCase()} ${route}`, handler),
    ]));
    harness.runtime.registerRoutes(app, {
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
    });
    const response = makeResponse();
    await handlers.get('DELETE /api/session/:sessionID')({
      body: undefined,
      method: 'DELETE',
      originalUrl: '/api/session/upstream-failed',
      params: { sessionID: 'upstream-failed' },
      principal: {
        scope: 'managed', id: USER_IDS.developer, role: 'developer',
        assignments: [{ projectId: project.id, branchName: 'main', repositoryPath, isDefault: true }],
      },
    }, response, vi.fn());

    expect(response.statusCode).toBe(503);
    expect(harness.analyticsRetentionLocks.has(USER_IDS.developer)).toBe(true);
    expect(harness.getOpenCodeSession('upstream-failed')).not.toBeNull();
    expect(harness.getOwnership('upstream-failed')?.archived_at).toBeNull();
    const audit = await waitForAudit(harness, 'session.deleted', 'upstream-failed');
    expect(audit).toEqual(expect.objectContaining({
      success: false,
      metadata: expect.objectContaining({ analyticsRetentionLocked: true, upstreamDeleted: false }),
    }));
  });

  it('purges only unprotected activity and reports deleted and preserved counts', async () => {
    const harness = await createHarness({
      signedInRole: 'admin',
      activityPurgeResult: { deletedCount: 17, protectedCount: 23 },
    });
    const login = await passwordLogin(harness, { role: 'admin' });
    const principal = await harness.runtime.resolvePrincipal(makeRequest({ cookie: login.cookie }));
    const handlers = new Map();
    const app = Object.fromEntries(['get', 'post', 'put', 'patch', 'delete', 'use'].map((method) => [
      method,
      (route, handler) => handlers.set(`${method.toUpperCase()} ${route}`, handler),
    ]));
    harness.runtime.registerRoutes(app);
    const response = makeResponse();
    await handlers.get('DELETE /api/admin/activity')({
      body: { confirm: true },
      principal,
    }, response);
    expect(response.payload).toEqual({ purged: true, deletedCount: 17, protectedCount: 23 });
    const rpcCall = harness.fetchImpl.mock.calls.find(([input]) => (
      String(input).includes('/rest/v1/rpc/devryan_purge_unprotected_activity_logs')
    ));
    expect(JSON.parse(String(rpcCall?.[1]?.body))).toEqual({
      p_preserve_event_id: expect.any(String),
    });
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

  it('allows worktree reads while denying developer manual worktree and branch creation by default', async () => {
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
      ['POST', '/git/checkout'],
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

    const branchTargetResponse = makeResponse();
    const branchTargetNext = vi.fn(() => branchTargetResponse.json({ allowed: true }));
    await harness.runtime.authController.requireAuth(makeRequest({
      cookie: login.cookie,
      method: 'POST',
      path: `/projects/${project.id}/branch-target`,
      csrf: true,
      body: { branchName: 'main' },
    }), branchTargetResponse, branchTargetNext);
    expect(branchTargetResponse.statusCode).toBe(200);
    expect(branchTargetNext).toHaveBeenCalledOnce();

    const deniedRetryResponse = makeResponse();
    await harness.runtime.authController.requireAuth(makeRequest({
      cookie: login.cookie,
      method: 'POST',
      path: '/git/worktrees/operations/operation-1/retry',
      csrf: true,
    }), deniedRetryResponse, vi.fn());
    expect(deniedRetryResponse.statusCode).toBe(403);
    expect(deniedRetryResponse.payload).toEqual({
      error: 'Worktree creation is disabled by policy',
      code: 'WORKTREE_CREATION_DISABLED',
    });

    for (const request of [
      { path: '/git/branches', body: { name: 'feature' } },
    ]) {
      const deniedCreateResponse = makeResponse();
      const deniedCreateNext = vi.fn();
      await harness.runtime.authController.requireAuth(makeRequest({
        cookie: login.cookie,
        method: 'POST',
        path: request.path,
        csrf: true,
        body: request.body,
      }), deniedCreateResponse, deniedCreateNext);
      expect(deniedCreateResponse.statusCode, request.path).toBe(403);
      expect(deniedCreateResponse.payload.error, request.path).toBe('Branch creation is disabled by policy');
      expect(deniedCreateNext, request.path).not.toHaveBeenCalled();
    }

    const existingWorktreeResponse = makeResponse();
    const existingWorktreeNext = vi.fn(() => existingWorktreeResponse.json({ allowed: true }));
    await harness.runtime.authController.requireAuth(makeRequest({
      cookie: login.cookie,
      method: 'POST',
      path: '/git/worktrees',
      csrf: true,
      body: { mode: 'existing', existingBranch: 'main' },
    }), existingWorktreeResponse, existingWorktreeNext);
    expect(existingWorktreeResponse.statusCode).toBe(403);
    expect(existingWorktreeResponse.payload).toEqual({
      error: 'Worktree creation is disabled by policy',
      code: 'WORKTREE_CREATION_DISABLED',
    });
    expect(existingWorktreeNext).not.toHaveBeenCalled();

    const deniedRenameResponse = makeResponse();
    const deniedRenameNext = vi.fn();
    await harness.runtime.authController.requireAuth(makeRequest({
      cookie: login.cookie,
      method: 'PUT',
      path: '/git/branches/rename',
      csrf: true,
      body: {
        directory: repositoryPath,
        oldName: 'main',
        newName: 'renamed-main',
      },
    }), deniedRenameResponse, deniedRenameNext);
    expect(deniedRenameResponse.statusCode).toBe(403);
    expect(deniedRenameResponse.payload.error).toBe('Git operation is not allowed by policy');
    expect(deniedRenameNext).not.toHaveBeenCalled();

    for (const requestPath of ['/git/worktrees', '/git/branches', '/git/remote-branches']) {
      const deniedDeleteResponse = makeResponse();
      const deniedDeleteNext = vi.fn();
      await harness.runtime.authController.requireAuth(makeRequest({
        cookie: login.cookie,
        method: 'DELETE',
        path: requestPath,
        csrf: true,
        body: { directory: repositoryPath },
      }), deniedDeleteResponse, deniedDeleteNext);
      expect(deniedDeleteResponse.statusCode, requestPath).toBe(403);
      expect(deniedDeleteResponse.payload.error, requestPath).toBe('Git operation is not allowed by policy');
      expect(deniedDeleteNext, requestPath).not.toHaveBeenCalled();
    }

    const deniedResponse = makeResponse();
    await harness.runtime.authController.requireAuth(makeRequest({
      cookie: login.cookie,
      path: '/git/identities',
    }), deniedResponse, vi.fn());
    expect(deniedResponse.statusCode).toBe(403);
  });

  it('allows an existing-branch worktree override without granting branch creation', async () => {
    const repositoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-worktree-override-'));
    temporaryDirectories.push(repositoryPath);
    const project = {
      id: '34343434-3434-4434-8434-343434343434',
      label: 'Worktree Override',
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
      userPolicies: [{
        user_id: USER_IDS.developer,
        settings_pages: null,
        settings_permission_overrides: {},
        capabilities: { createWorktrees: true },
        settings_overrides: {},
        feature_overrides: {},
      }],
    });
    const login = await passwordLogin(harness, { role: 'developer' });

    const existingResponse = makeResponse();
    const existingNext = vi.fn(() => existingResponse.json({ created: true }));
    await harness.runtime.authController.requireAuth(makeRequest({
      cookie: login.cookie,
      method: 'POST',
      path: '/git/worktrees',
      csrf: true,
      body: { mode: 'existing', existingBranch: 'main' },
    }), existingResponse, existingNext);
    expect(existingResponse.statusCode).toBe(200);
    expect(existingNext).toHaveBeenCalledOnce();

    const newBranchResponse = makeResponse();
    await harness.runtime.authController.requireAuth(makeRequest({
      cookie: login.cookie,
      method: 'POST',
      path: '/git/worktrees',
      csrf: true,
      body: { mode: 'new', branchName: 'feature', startRef: 'main' },
    }), newBranchResponse, vi.fn());
    expect(newBranchResponse.statusCode).toBe(403);
    expect(newBranchResponse.payload.error).toBe('Branch creation is disabled by policy');
  });

  it('allows a developer branch creation when the per-user capability is enabled', async () => {
    const harness = await createHarness({
      signedInRole: 'developer',
      userPolicies: [{
        user_id: USER_IDS.developer,
        settings_pages: null,
        settings_permission_overrides: {},
        capabilities: { createBranches: true },
        settings_overrides: {},
        feature_overrides: {},
      }],
    });
    const login = await passwordLogin(harness, { role: 'developer' });
    const response = makeResponse();
    const next = vi.fn(() => response.json({ allowed: true }));

    await harness.runtime.authController.requireAuth(makeRequest({
      cookie: login.cookie,
      method: 'POST',
      path: '/git/branches',
      csrf: true,
      body: { name: 'feature' },
    }), response, next);

    expect(response.statusCode).toBe(200);
    expect(next).toHaveBeenCalledOnce();
  });

  it('retains worktree maintenance deletion for managed administrators', async () => {
    const harness = await createHarness({ signedInRole: 'admin' });
    const login = await passwordLogin(harness, { role: 'admin' });
    const response = makeResponse();
    const next = vi.fn(() => response.json({ allowed: true }));
    await harness.runtime.authController.requireAuth(makeRequest({
      cookie: login.cookie,
      method: 'DELETE',
      path: '/git/worktrees',
      csrf: true,
    }), response, next);
    expect(response.statusCode).toBe(200);
    expect(next).toHaveBeenCalledOnce();
  });

  it('keeps commit-message generation outside the worktree mutation lock without weakening managed authorization', async () => {
    const repositoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-commit-message-lock-'));
    temporaryDirectories.push(repositoryPath);
    const project = {
      id: '55555555-5555-4555-8555-555555555555',
      label: 'Commit Message Lock',
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

    const heldMutationResponse = makeResponse();
    const heldMutationNext = vi.fn();
    await harness.runtime.authController.requireAuth(makeRequest({
      cookie: login.cookie,
      method: 'POST',
      path: '/git/commit',
      csrf: true,
      body: { directory: repositoryPath, message: 'test: hold mutation lock' },
    }), heldMutationResponse, heldMutationNext);
    expect(heldMutationNext).toHaveBeenCalledOnce();

    const draftResponse = makeResponse();
    const draftNext = vi.fn(() => draftResponse.json({ allowed: true }));
    await harness.runtime.authController.requireAuth(makeRequest({
      cookie: login.cookie,
      method: 'POST',
      path: '/git/commit-message/draft',
      csrf: true,
      body: { directory: repositoryPath, selectedFiles: ['src/app.ts'] },
    }), draftResponse, draftNext);
    expect(draftResponse.statusCode).toBe(200);
    expect(draftNext).toHaveBeenCalledOnce();

    const queuedMutationResponse = makeResponse();
    const queuedMutationNext = vi.fn(() => queuedMutationResponse.json({ allowed: true }));
    const queuedMutation = harness.runtime.authController.requireAuth(makeRequest({
      cookie: login.cookie,
      method: 'POST',
      path: '/git/stage',
      csrf: true,
      body: { directory: repositoryPath, files: ['src/app.ts'] },
    }), queuedMutationResponse, queuedMutationNext);
    await new Promise((resolve) => setImmediate(resolve));
    expect(queuedMutationNext).not.toHaveBeenCalled();

    heldMutationResponse.json({ committed: true });
    await queuedMutation;
    expect(queuedMutationNext).toHaveBeenCalledOnce();

    const missingCsrfResponse = makeResponse();
    await harness.runtime.authController.requireAuth(makeRequest({
      cookie: login.cookie,
      method: 'POST',
      path: '/git/commit-message/draft',
      body: { directory: repositoryPath, selectedFiles: ['src/app.ts'] },
    }), missingCsrfResponse, vi.fn());
    expect(missingCsrfResponse.statusCode).toBe(403);
    expect(missingCsrfResponse.payload.error).toBe('Missing CSRF request header');
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
    expect(harness.onManagedProjectMetadataChanged).toHaveBeenCalledTimes(1);
    expect(harness.onManagedProjectMetadataChanged).toHaveBeenLastCalledWith(project.id);

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

    const managedProject = await harness.runtime.resolveManagedProject({ principal: refreshedPrincipal }, project.id);
    await managedProject.persistIconImage({ mime: 'image/png', updatedAt: 1234, source: 'custom' });
    expect(harness.onManagedProjectMetadataChanged).toHaveBeenCalledTimes(2);
    expect(harness.onManagedProjectMetadataChanged).toHaveBeenLastCalledWith(project.id);
    const clearedProject = await managedProject.persistIconImage(null);
    expect(clearedProject.iconImage).toBeNull();
    expect(harness.onManagedProjectMetadataChanged).toHaveBeenCalledTimes(3);

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
    expect(harness.onManagedProjectMetadataChanged).toHaveBeenCalledTimes(3);
  });

  it('starts in a fail-closed degraded state and preserves the local ownership index during an outage', async () => {
    const ownership = {
      session_id: 'session-offline',
      user_id: USER_IDS.developer,
      project_id: 'project-offline',
      branch_name: 'main',
      public_directory: '/project',
      created_at: new Date().toISOString(),
      archived_at: null,
    };
    const harness = await createHarness({
      dependencyUnavailableAtStartup: true,
      localOwnershipRows: [ownership],
      ownershipRows: [ownership],
    });

    expect(harness.runtime.getControlPlaneStatus()).toMatchObject({
      state: 'degraded',
      lastErrorCode: 'ENOTFOUND',
      lastSuccessAt: null,
    });
    await expect(harness.runtime.resolveOwnedSessionPlanContext({
      id: USER_IDS.developer,
      scope: 'managed',
      assignments: [{
        projectId: ownership.project_id,
        branchName: ownership.branch_name,
        repositoryPath: '/tmp/project-offline',
      }],
    }, ownership.session_id)).resolves.toEqual({
      directory: '/tmp/project-offline',
      projectId: ownership.project_id,
      branchName: ownership.branch_name,
    });

    const remoteStatus = makeResponse();
    await harness.runtime.authController.handleSessionStatus(
      makeRequest({ loopback: false }),
      remoteStatus,
    );
    expect(remoteStatus.statusCode).toBe(503);
    expect(remoteStatus.payload).toMatchObject({
      authenticated: false,
      code: 'identity_unavailable',
    });

    harness.setDependencyUnavailable(false);
    await harness.runtime.retryControlPlaneSync();
    expect(harness.runtime.getControlPlaneStatus()).toMatchObject({
      state: 'ready',
      lastErrorCode: null,
    });
  });

  it('does not hide non-transient control-plane configuration failures at startup', async () => {
    await expect(createHarness({ dependencyFailureStatusAtStartup: 401 })).rejects.toMatchObject({
      name: 'SupabaseRequestError',
      status: 401,
    });
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

  it('returns a structured retryable error for management routes during offline grace and recovers', async () => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const harness = await createHarness({ signedInRole: 'admin' });
    const login = await passwordLogin(harness, { role: 'admin', trustDevice: true });
    now += 6_000;
    harness.setAppSessionUnavailable(true);

    for (const request of [
      makeRequest({ cookie: login.cookie, path: '/admin/users' }),
      makeRequest({ cookie: login.cookie, method: 'POST', path: '/admin/users', csrf: true }),
    ]) {
      const response = makeResponse();
      const next = vi.fn();
      await harness.runtime.authController.requireAuth(request, response, next);

      expect(next).not.toHaveBeenCalled();
      expect(response.statusCode).toBe(503);
      expect(response.payload).toEqual({
        error: 'Account and host management are unavailable during offline grace',
        code: 'offline_grace_restricted',
        retryable: true,
      });
    }

    harness.setAppSessionUnavailable(false);
    now += 6_000;
    const recoveredResponse = makeResponse();
    const recoveredNext = vi.fn(() => recoveredResponse.json({ ok: true }));
    await harness.runtime.authController.requireAuth(
      makeRequest({ cookie: login.cookie, path: '/admin/users' }),
      recoveredResponse,
      recoveredNext,
    );

    expect(recoveredNext).toHaveBeenCalledOnce();
    expect(recoveredResponse.statusCode).toBe(200);
    expect(recoveredResponse.payload).toEqual({ ok: true });
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

  it('keeps earlier prompts visible and includes session deletion in a human developer analytics feed', async () => {
    const harness = await createHarness({
      profiles: [
        fixtureProfile('developer', { account_kind: 'human' }),
        fixtureProfile('admin', { account_kind: 'human' }),
      ],
      activityRows: [
        {
          id: 1,
          event_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          actor_user_id: USER_IDS.developer,
          target_user_id: USER_IDS.developer,
          action: 'prompt.sent',
          success: true,
          metadata: { promptText: 'Retained prompt' },
          created_at: '2026-08-07T09:00:00.000Z',
        },
        {
          id: 2,
          event_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          actor_user_id: USER_IDS.developer,
          target_user_id: null,
          action: 'session.deleted',
          success: false,
          metadata: {
            upstreamDeleted: true,
            ownershipTombstoned: false,
            analyticsRetentionLocked: true,
          },
          created_at: '2026-08-07T10:00:00.000Z',
        },
      ],
    });
    const handlers = new Map();
    const app = Object.fromEntries(['get', 'post', 'put', 'patch', 'delete', 'use'].map((method) => [
      method,
      (route, handler) => handlers.set(`${method.toUpperCase()} ${route}`, handler),
    ]));
    harness.runtime.registerRoutes(app);
    const admin = { scope: 'managed', id: USER_IDS.admin, role: 'admin' };
    const query = { start: '2026-08-07', end: '2026-08-07', timeZone: 'UTC', limit: '50' };

    const changes = makeResponse();
    await handlers.get('GET /api/admin/users/:userId/analytics/events')({
      principal: admin,
      params: { userId: USER_IDS.developer },
      query: { ...query, category: 'changes' },
    }, changes);
    expect(changes.payload.events).toEqual([
      expect.objectContaining({ action: 'session.deleted', success: false }),
    ]);

    const prompts = makeResponse();
    await handlers.get('GET /api/admin/users/:userId/analytics/events')({
      principal: admin,
      params: { userId: USER_IDS.developer },
      query: { ...query, category: 'prompts' },
    }, prompts);
    expect(prompts.payload.events).toEqual([
      expect.objectContaining({ action: 'prompt.sent', metadata: expect.objectContaining({ promptText: 'Retained prompt' }) }),
    ]);
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
