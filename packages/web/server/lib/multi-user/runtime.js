import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { resolveMultiUserConfig } from './config.js';
import {
  ensureOpenCodeProjectId,
  getBranches,
  getOpenCodeDataPath,
  getRemoteUrl,
} from '../git/service.js';
import {
  buildBranchOptions,
  ensureBranchTarget,
  normalizeLogicalBranchName,
} from './branch-target.js';
import {
  clearGitHubAuthById as clearStoredGitHubAuthById,
  getAllGitHubAuthAccounts as getAllStoredGitHubAuthAccounts,
  getGitHubAuthById as getStoredGitHubAuthById,
} from '../github/auth.js';
import {
  ROLE_NAMES,
  ROLE_POLICY_DEFAULTS,
  buildUserPolicyResetRow,
  buildEffectiveSettings,
  canEditSettingsPage,
  canReadSettingsPage,
  normalizeRolePolicy,
  publicPrincipal,
  settingsPageForRequest,
  settingsPermissionsFromLegacyPages,
  validateSettingsChanges,
  validateSettingsPermissionsPayload,
} from './policy.js';
import { runWithRequestPrincipal } from './request-context.js';
import { createSupabaseServerClient, SupabaseRequestError } from './supabase-client.js';
import { createSessionVault } from './vault.js';
import { createSessionOwnershipIndex } from './session-ownership-index.js';
import { createAuditOutbox } from './audit-outbox.js';
import {
  ANALYTICS_ACTIONS,
  ANALYTICS_EVENT_BATCH_LIMIT,
  ANALYTICS_PAGE_LIMIT,
  aggregateDailyAnalytics,
  aggregateRangeAnalytics,
  analyticsRowBeforeCursor,
  buildSafeFieldDeltas,
  decodeAnalyticsCursor,
  encodeAnalyticsCursor,
  extractHumanPrompt,
  isSettingsChangeAction,
  sanitizeActivityForReviewer,
  validateAnalyticsDay,
  validateAnalyticsRange,
  validateInteractionEvent,
} from './analytics.js';
import { emptySessionFolders, normalizeSessionFoldersPayload } from './session-folders.js';
import { projectOpenCodeActivity } from './activity-projection.js';
import {
  listVisibleSessionPage,
  normalizeSessionPageLimit,
  selectUniqueOwnershipCandidate,
} from './session-visibility.js';
import {
  AUTH_ERROR_CODES,
  authFailurePayload,
  buildAgentTestIdentities,
  createUserPolicyReader,
  GITHUB_ACCOUNT_REASSIGNMENT_MIGRATION,
  isDefinitiveRefreshRejection,
  isMissingGithubAccountReassignmentFunctionError,
  isMissingUserProfileGithubAccountError,
  isSettingsPermissionSchemaError,
  selectAgentTestProfile,
  USER_PROFILE_GITHUB_ACCOUNT_MIGRATION,
} from './auth-compat.js';
import {
  AGENT_TEST_ACCOUNT_KIND,
  HUMAN_ACCOUNT_KIND,
  buildUserManagementProfileQuery,
} from './user-profile-visibility.js';
import {
  isPathContained,
  publicizeValue,
  resolveAssignmentForValue,
  translateDirectoryHeaderValue,
  translateDirectoryValue,
} from './path-translation.js';

const APP_SESSION_COOKIE = 'oc_app_session';
const ACCESS_INVITE_COOKIE = 'oc_access_invite';
const APP_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const REMEMBERED_ADMIN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const LOOPBACK_OFFLINE_GRACE_MS = 24 * 60 * 60 * 1000;
const VAULT_VALIDATION_CHECKPOINT_MS = 5 * 60 * 1000;
const PRINCIPAL_CACHE_MS = 5_000;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 8;
const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const USER_CAPABILITY_KEYS = new Set([
  'files', 'terminal', 'manageProjects', 'manageUsers', 'manageGlobalSettings',
  'manageGit', 'push', 'github',
]);

const sha256 = (value) => crypto.createHash('sha256').update(String(value || '')).digest('hex');
const timingSafeTextEqual = (left, right) => {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.byteLength === b.byteLength && crypto.timingSafeEqual(a, b);
};

const parseCookies = (header) => {
  const result = {};
  for (const segment of String(header || '').split(';')) {
    const index = segment.indexOf('=');
    if (index <= 0) continue;
    const key = segment.slice(0, index).trim();
    const value = segment.slice(index + 1).trim();
    try { result[key] = decodeURIComponent(value); } catch { result[key] = value; }
  }
  return result;
};

const isSecureRequest = (req) => {
  if (req.secure) return true;
  const forwarded = typeof req.headers?.['x-forwarded-proto'] === 'string'
    ? req.headers['x-forwarded-proto'].split(',')[0].trim().toLowerCase()
    : '';
  return forwarded === 'https';
};

const setNamedCookie = (req, res, name, value, ttlMs) => {
  const attributes = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(ttlMs / 1000))}`,
    `Expires=${ttlMs === 0 ? 'Thu, 01 Jan 1970 00:00:00 GMT' : new Date(Date.now() + ttlMs).toUTCString()}`,
  ];
  if (isSecureRequest(req)) attributes.push('Secure');
  const cookie = attributes.join('; ');
  const existing = res.getHeader('Set-Cookie');
  if (Array.isArray(existing)) res.setHeader('Set-Cookie', [...existing, cookie]);
  else if (typeof existing === 'string' && existing) res.setHeader('Set-Cookie', [existing, cookie]);
  else res.setHeader('Set-Cookie', cookie);
};

const setCookie = (req, res, value, ttlMs) => setNamedCookie(req, res, APP_SESSION_COOKIE, value, ttlMs);
const setInviteCookie = (req, res, value, ttlMs) => setNamedCookie(req, res, ACCESS_INVITE_COOKIE, value, ttlMs);

const requestIp = (req) => {
  const forwarded = req.headers?.['x-forwarded-for'];
  const value = typeof forwarded === 'string'
    ? forwarded.split(',')[0].trim()
    : req.ip || req.socket?.remoteAddress || '';
  return String(value).replace(/^::ffff:/, '');
};

const isLoopbackRequest = (req) => {
  const ip = String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  const rawHost = String(req.headers?.host || '').trim().toLowerCase();
  const host = rawHost.startsWith('[')
    ? rawHost.slice(1, rawHost.indexOf(']') > 0 ? rawHost.indexOf(']') : undefined)
    : rawHost.split(':')[0];
  return ['127.0.0.1', '::1', 'localhost'].includes(ip)
    && ['127.0.0.1', '::1', 'localhost'].includes(host);
};

const normalizeEmail = (value) => String(value || '').trim().toLowerCase();
const normalizeDisplayName = (value, fallback) => String(value || '').trim().slice(0, 120) || fallback;
const normalizeOptionalMetadata = (value, maxLength = 120) => {
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().slice(0, maxLength);
  return normalized || null;
};
const validEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;
const validUuid = (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const validRole = (value) => ROLE_NAMES.includes(value);
const validPassword = (value) => typeof value === 'string' && value.length >= 4 && value.length <= 256;
const generatePassword = () => `${crypto.randomBytes(18).toString('base64url')}!aA7`;
const escapeFilterValue = (value) => String(value).replace(/[(),]/g, '');
const normalizeGitHubRemoteUrl = (value) => {
  const remote = String(value || '').trim();
  if (/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(?:\.git)?$/i.test(remote)) return remote;
  const scp = remote.match(/^git@github\.com:([\w.-]+\/[\w.-]+(?:\.git)?)$/i);
  if (scp) return `https://github.com/${scp[1]}`;
  const ssh = remote.match(/^ssh:\/\/git@github\.com\/([\w.-]+\/[\w.-]+(?:\.git)?)$/i);
  if (ssh) return `https://github.com/${ssh[1]}`;
  return null;
};

const createVerifiedGitHubAccountId = (getGitHubAuthById) => (value) => {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') {
    throw Object.assign(new Error('GitHub account id must be a string or null'), { statusCode: 400 });
  }
  const accountId = value.trim();
  const githubAuth = getGitHubAuthById(accountId);
  if (!githubAuth?.accessToken || !githubAuth?.user?.login || !githubAuth?.user?.id) {
    throw Object.assign(new Error('Assigned GitHub account is unavailable or lacks a verified identity'), { statusCode: 400 });
  }
  return accountId;
};

const jsonError = (res, status, error, extras = {}) => res.status(status).json({ error, ...extras });

const settingsPermissionWriteError = (res, error) => {
  if (!isSettingsPermissionSchemaError(error)) {
    return jsonError(res, error?.statusCode || error?.status || 500, error?.message || 'Policy update failed');
  }
  const failure = authFailurePayload(error);
  return jsonError(res, failure.status, failure.error, {
    code: failure.code,
    requiredMigration: failure.requiredMigration,
  });
};

const extractSessionId = (payload) => {
  if (!payload || typeof payload !== 'object') return '';
  const candidates = [
    payload.sessionID,
    payload.sessionId,
    payload.properties?.sessionID,
    payload.properties?.sessionId,
    payload.properties?.info?.sessionID,
    payload.properties?.info?.sessionId,
    payload.properties?.message?.sessionID,
    payload.properties?.part?.sessionID,
  ];
  return candidates.find((value) => typeof value === 'string' && value.trim())?.trim() || '';
};

const restrictedGitRoute = (req) => {
  if (req.method === 'GET') {
    if (req.path === '/worktree-root' || /^\/worktrees(?:\/|$)/.test(req.path)) return false;
    return /^\/(?:identities|global-identity|current-identity|has-local-identity|discover-credentials|stashes|worktrees|worktree-root)(?:\/|$)/.test(req.path);
  }
  if (req.method === 'POST' && [
    '/worktrees',
    '/worktrees/validate',
    '/worktrees/preview',
    '/branches',
    '/checkout',
  ].includes(req.path)) return false;
  if (req.method === 'POST' && /^\/worktrees\/operations\/[^/]+\/retry$/.test(req.path)) return false;
  if (req.method === 'DELETE' && req.path === '/worktrees') return false;
  return /^\/(?:identities|global-identity|discover-credentials|set-identity|branches|checkout|worktrees|remote-branches|remotes|stash|stashes|templates|canonicalize-worktree-state)(?:\/|$)/.test(req.path);
};

const hostGlobalMutation = (req) => {
  if (!STATE_CHANGING_METHODS.has(req.method)) return false;
  if (req.path === '/config/settings') return false;
  if (/^\/projects\/[^/]+\/(?:branch-target|scheduled-tasks(?:\/[^/]+)?(?:\/run)?)$/.test(req.path)) return false;
  return /^\/(?:config|auth|provider|mcp|openchamber\/tunnel|projects|diagnostics|evidence|desktop|browser)/.test(req.path);
};

const hostGlobalRead = (requestPath) => {
  if (/^\/(?:auth|provider|mcp|magic-prompts|openchamber\/tunnel)(?:\/|$)/.test(requestPath)) return true;
  if (requestPath === '/openchamber/events' || requestPath === '/openchamber/scheduled-tasks/status') return false;
  if (/^\/projects\/[^/]+\/icon$/.test(requestPath)) return false;
  if (/^\/projects\/[^/]+\/(?:branch-target|scheduled-tasks(?:\/[^/]+)?(?:\/run)?)$/.test(requestPath)) return false;
  if (/^\/projects(?:\/|$)/.test(requestPath)) return true;
  if (!requestPath.startsWith('/config/')) return false;
  return !/^\/config\/(?:settings|themes|providers)(?:\/|$)/.test(requestPath)
    && requestPath !== '/config/agents';
};

const getDefaultAssignment = (principal) => (
  principal?.assignments?.find((entry) => entry.isDefault)
  || principal?.assignments?.[0]
  || null
);

const rewriteUrlQuery = async (req, principal, { translatePathFields = true } = {}) => {
  const rawUrl = typeof req.url === 'string' ? req.url : '';
  if (!rawUrl.includes('?')) return;
  const parsed = new URL(rawUrl, 'http://127.0.0.1');
  const keys = ['directory', 'cwd', 'root', 'workingDirectory', ...(translatePathFields ? ['path', 'oldPath', 'newPath'] : [])];
  for (const key of keys) {
    if (!parsed.searchParams.has(key)) continue;
    const translated = await translateDirectoryValue(principal, parsed.searchParams.get(key));
    if (!translated) throw Object.assign(new Error('Directory is outside your assigned workspace'), { statusCode: 403 });
    parsed.searchParams.set(key, translated);
  }
  req.url = `${parsed.pathname}${parsed.search}`;
  if (typeof req.originalUrl === 'string') {
    const original = new URL(req.originalUrl, 'http://127.0.0.1');
    for (const key of keys) {
      if (!original.searchParams.has(key)) continue;
      const translated = await translateDirectoryValue(principal, original.searchParams.get(key));
      if (!translated) throw Object.assign(new Error('Directory is outside your assigned workspace'), { statusCode: 403 });
      original.searchParams.set(key, translated);
    }
    req.originalUrl = `${original.pathname}${original.search}`;
  }
};

const rewriteBodyPaths = async (body, principal, { translatePathFields = true } = {}) => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return;
  const keys = [
    'directory', 'cwd', 'root', 'workingDirectory', 'projectPath',
    ...(translatePathFields ? ['path', 'oldPath', 'newPath'] : []),
  ];
  for (const key of keys) {
    if (typeof body[key] !== 'string') continue;
    const translated = await translateDirectoryValue(principal, body[key]);
    if (!translated) throw Object.assign(new Error('Path is outside your assigned workspace'), { statusCode: 403 });
    body[key] = translated;
  }
};

const responseAuditSummary = (payload) => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {};
  const summary = {};
  for (const key of ['sha', 'hash', 'commitHash', 'headSha', 'number', 'merged', 'ready']) {
    const value = payload[key];
    if (typeof value === 'string' && value.length <= 160) summary[key] = value;
    else if (typeof value === 'number' || typeof value === 'boolean') summary[key] = value;
  }
  return summary;
};

const wrapJsonResponse = (req, res) => {
  // Non-admin responses still strip server-only assignment fields. Path
  // publicizing is identity-preserving for real repositories and worktrees.
  if (req.principal?.scope !== 'managed' || req.principal?.role === 'admin' || res.locals?.multiUserJsonWrapped) return;
  res.locals.multiUserJsonWrapped = true;
  const originalJson = res.json.bind(res);
  res.json = (payload) => {
    res.locals.multiUserResponseAudit = responseAuditSummary(payload);
    return originalJson(publicizeValue(req.principal, payload));
  };
};

const localAdminPrincipal = Object.freeze({
  id: 'local-admin',
  email: null,
  displayName: 'Local Administrator',
  role: 'admin',
  scope: 'local-admin',
  policy: ROLE_POLICY_DEFAULTS.admin,
  assignments: [],
});

export async function createMultiUserRuntime({
  dataDirectory,
  fetchImpl = fetch,
  logger = console,
  githubAuthStore = {},
} = {}) {
  const config = resolveMultiUserConfig({ dataDirectory });

  const getGitHubAuthById = githubAuthStore.getGitHubAuthById || getStoredGitHubAuthById;
  const getAllGitHubAuthAccounts = githubAuthStore.getAllGitHubAuthAccounts || getAllStoredGitHubAuthAccounts;
  const clearGitHubAuthById = githubAuthStore.clearGitHubAuthById || clearStoredGitHubAuthById;
  const verifiedGitHubAccountId = createVerifiedGitHubAccountId(getGitHubAuthById);

  const wrapLegacyAuthController = (legacy) => ({
    ...legacy,
    multiUser: false,
    async resolvePrincipal(req, res) {
      if (!legacy.enabled) return isLoopbackRequest(req) ? localAdminPrincipal : null;
      const token = await legacy.ensureSessionToken(req, res);
      return token ? localAdminPrincipal : null;
    },
    async requireAuth(req, res, next) {
      if (!legacy.enabled && !isLoopbackRequest(req)) {
        return jsonError(res, 401, 'Local administrator access is loopback-only');
      }
      return legacy.requireAuth(req, res, () => {
        req.principal = localAdminPrincipal;
        return runWithRequestPrincipal(localAdminPrincipal, next);
      });
    },
    async handleSessionStatus(req, res) {
      if (!legacy.enabled) {
        if (!isLoopbackRequest(req)) return jsonError(res, 401, 'Local administrator access is loopback-only');
        return res.json({ authenticated: true, disabled: true, principal: publicPrincipal(localAdminPrincipal), mode: 'local' });
      }
      const token = await legacy.ensureSessionToken(req, res);
      if (!token) return legacy.handleSessionStatus(req, res);
      return res.json({ authenticated: true, principal: publicPrincipal(localAdminPrincipal), mode: 'local' });
    },
    async ensureSessionToken(req, res) {
      if (!legacy.enabled) {
        if (isLoopbackRequest(req)) req.principal = localAdminPrincipal;
        return isLoopbackRequest(req) ? 'local-admin' : null;
      }
      const token = await legacy.ensureSessionToken(req, res);
      if (token || !legacy.enabled) req.principal = localAdminPrincipal;
      return token;
    },
    authorizeSystemRequest(req, res, next) {
      return this.requireAuth(req, res, next);
    },
  });

  if (!config.enabled) {
    return {
      enabled: false,
      config,
      localAdminPrincipal,
      wrapLegacyAuthController,
      registerRoutes() {},
      filterEventForPrincipal: () => true,
      recordOpenCodeActivity: async () => false,
      canSessionTokenHashAccess: async () => true,
      getPublicPrincipal: publicPrincipal,
    };
  }

  const supabase = createSupabaseServerClient({ ...config, fetchImpl });
  const readUserPolicy = createUserPolicyReader({ supabase, logger });
  const vault = await createSessionVault({ dataDirectory: config.dataDirectory });
  const ownershipIndex = await createSessionOwnershipIndex({ dataDirectory: config.dataDirectory });
  const durableOwnershipRows = await supabase.rest('opencode_session_ownership');
  await ownershipIndex.rebuild(durableOwnershipRows);
  const principalCache = new Map();
  const loginAttempts = new Map();
  const connectionsByUser = new Map();
  const connectionsBySession = new Map();
  const mutationTails = new Map();
  const projectedActivityKeys = new Map();
  let claimInProgress = false;
  let abortOwnedSessions = async () => {};
  let terminateOwnedTerminals = async () => {};
  let reconcileSessionOwnership = async () => ({ repaired: 0, ambiguous: 0 });
  let ensureOwnedSession = async () => false;
  let loopbackPasskeyController = null;
  const auditOutbox = await createAuditOutbox({
    dataDirectory: config.dataDirectory,
    supabase,
    logger,
  });

  const registerConnection = (principal, close) => {
    if (principal?.scope !== 'managed' || typeof close !== 'function') return () => {};
    const record = { close, userId: principal.id, appSessionId: principal.appSessionId || null };
    const userConnections = connectionsByUser.get(record.userId) || new Set();
    userConnections.add(record);
    connectionsByUser.set(record.userId, userConnections);
    if (record.appSessionId) {
      const sessionConnections = connectionsBySession.get(record.appSessionId) || new Set();
      sessionConnections.add(record);
      connectionsBySession.set(record.appSessionId, sessionConnections);
    }
    return () => {
      userConnections.delete(record);
      if (userConnections.size === 0) connectionsByUser.delete(record.userId);
      if (record.appSessionId) {
        const sessionConnections = connectionsBySession.get(record.appSessionId);
        sessionConnections?.delete(record);
        if (sessionConnections?.size === 0) connectionsBySession.delete(record.appSessionId);
      }
    };
  };

  const revokeConnections = ({ userId = null, appSessionId = null } = {}) => {
    const records = appSessionId
      ? [...(connectionsBySession.get(appSessionId) || [])]
      : [...(connectionsByUser.get(userId) || [])];
    for (const record of records) {
      try { record.close(); } catch { /* connection is already closed */ }
    }
  };

  const revokeConnectionsAfterResponse = (res, targets) => {
    const targetList = Array.isArray(targets) ? targets : [targets];
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      for (const target of targetList) revokeConnections(target);
    };
    res.once('finish', close);
    res.once('close', close);
  };

  const acquireMutationKey = async (key) => {
    const previous = mutationTails.get(key) || Promise.resolve();
    let openGate;
    const gate = new Promise((resolve) => { openGate = resolve; });
    const tail = previous.catch(() => undefined).then(() => gate);
    mutationTails.set(key, tail);
    await previous.catch(() => undefined);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      openGate();
      queueMicrotask(() => {
        if (mutationTails.get(key) === tail) mutationTails.delete(key);
      });
    };
  };

  const githubAssignmentConflict = (owner = null) => Object.assign(
    new Error(owner?.display_name
      ? `GitHub account is already assigned to ${owner.display_name}`
      : 'GitHub account is already assigned to another user'),
    {
      statusCode: 409,
      code: 'GITHUB_ACCOUNT_ALREADY_ASSIGNED',
      assignedUserId: owner?.id || null,
    },
  );

  const isGitHubAssignmentUniqueViolation = (error) => (
    error instanceof SupabaseRequestError
    && error?.payload?.code === '23505'
    && String(error?.payload?.constraint || error?.message || '').includes('user_profiles_github_account_id_idx')
  );

  const normalizeGitHubAssignmentError = (error) => (
    isGitHubAssignmentUniqueViolation(error) ? githubAssignmentConflict() : error
  );

  const findGitHubAccountOwner = async (accountId, excludedUserId = null) => {
    if (!accountId) return null;
    const owner = await supabase.rest('user_profiles', {
      query: {
        github_account_id: `eq.${escapeFilterValue(accountId)}`,
        select: 'id,email,display_name,github_account_id',
        limit: 1,
      },
      maybeSingle: true,
    });
    return owner && owner.id !== excludedUserId ? owner : null;
  };

  const assertGitHubAccountAvailable = async (accountId, userId = null) => {
    const owner = await findGitHubAccountOwner(accountId, userId);
    if (owner) throw githubAssignmentConflict(owner);
  };

  const acquireRequestMutation = async (principal, req) => {
    if (!STATE_CHANGING_METHODS.has(req.method)) return () => {};
    const requestPath = typeof req.path === 'string'
      ? req.path
      : new URL(req.url || '/', 'http://127.0.0.1').pathname.replace(/^\/api/, '') || '/';
    if (!/^\/(?:git(?:\/|$)|github\/pr(?:\/|$)|fs\/(?:write|delete)(?:\/|$))/.test(requestPath)) return () => {};
    const parsed = new URL(req.url || '/', 'http://127.0.0.1');
    const directory = req.body?.directory
      || req.body?.cwd
      || req.body?.path
      || parsed.searchParams.get('directory')
      || req.headers?.['x-opencode-directory'];
    const assignment = resolveAssignmentForValue(principal, directory);
    if (!assignment) return () => {};
    const keys = [`worktree:${path.resolve(assignment.repositoryPath)}`];
    if (/^\/git\/(?:fetch|pull|push)(?:\/|$)/.test(requestPath)) {
      keys.push(`repository:${assignment.projectId}`);
    }
    const releases = [];
    for (const key of [...new Set(keys)].sort()) releases.push(await acquireMutationKey(key));
    return () => {
      for (const release of releases.reverse()) release();
    };
  };

  const audit = async (principal, action, details = {}) => {
    const eventId = details.eventId || crypto.randomUUID();
    const record = {
      actor_user_id: principal?.scope === 'managed' ? principal.id : null,
      actor_role: principal?.role || null,
      action,
      target_type: details.targetType || null,
      target_id: details.targetId || null,
      target_user_id: details.targetUserId || (details.targetType === 'user' ? details.targetId || null : null),
      project_id: details.projectId || null,
      session_id: details.sessionId || null,
      request_id: details.requestId || null,
      success: details.success !== false,
      metadata: details.metadata && typeof details.metadata === 'object' ? details.metadata : {},
      ...(details.occurredAt ? { created_at: details.occurredAt } : {}),
    };
    if (details.deferred) await auditOutbox.enqueueDeferred(eventId, record);
    else await auditOutbox.enqueue(eventId, record);
    return eventId;
  };

  const recordOpenCodeActivity = async (payload) => {
    const sessionId = extractSessionId(payload);
    if (!sessionId) return false;
    const ownership = await ownershipIndex.get(sessionId);
    if (!ownership?.user_id || ownership.archived_at) return false;
    const principal = await loadPrincipal(ownership.user_id);
    const assignment = principal?.assignments?.find((entry) => (
      entry.projectId === ownership.project_id && entry.branchName === ownership.branch_name
    ));
    const projected = projectOpenCodeActivity({ payload, ownership, assignment });
    if (!projected || projectedActivityKeys.has(projected.dedupeKey)) return false;
    projectedActivityKeys.set(projected.dedupeKey, Date.now());
    if (projectedActivityKeys.size > 10_000) {
      const oldest = projectedActivityKeys.keys().next().value;
      if (oldest) projectedActivityKeys.delete(oldest);
    }
    try {
      await audit(principal, projected.action, projected.details);
      return true;
    } catch (error) {
      projectedActivityKeys.delete(projected.dedupeKey);
      throw error;
    }
  };

  const registerMutationAudit = async (principal, req, res) => {
    if (principal?.scope !== 'managed' || !STATE_CHANGING_METHODS.has(req.method)) return;
    const requestPath = typeof req.path === 'string'
      ? req.path
      : new URL(req.url || '/', 'http://127.0.0.1').pathname.replace(/^\/api/, '') || '/';
    const segments = requestPath.split('/').filter(Boolean);
    const domain = segments[0];
    if (!['git', 'github', 'terminal', 'fs'].includes(domain)) return;
    const allowedOperations = {
      git: new Set(['fetch', 'pull', 'push', 'stage', 'unstage', 'commit', 'revert', 'merge', 'rebase', 'stash', 'checkout', 'branches', 'worktrees', 'apply-hunk', 'remotes', 'remote-branches']),
      fs: new Set(['write', 'delete', 'rename', 'mkdir', 'exec', 'clone']),
    };
    const requestedOperation = String(segments[1] || '').toLowerCase();
    let operation;
    if (domain === 'terminal') {
      if (req.method === 'POST' && requestedOperation === 'create') operation = 'open';
      else if (req.method === 'DELETE' && segments.length === 2) operation = 'close';
      else return;
    } else if (domain === 'github') {
      if (requestedOperation === 'pr' && /^[a-z-]+$/.test(segments[2] || '')) operation = `pr.${segments[2]}`;
      else if (requestedOperation === 'auth') operation = 'auth';
      else return;
    } else {
      if (!allowedOperations[domain]?.has(requestedOperation)) return;
      operation = requestedOperation;
    }
    const parsed = new URL(req.url || '/', 'http://127.0.0.1');
    const directory = req.body?.directory
      || req.body?.cwd
      || parsed.searchParams.get('directory')
      || req.headers?.['x-opencode-directory'];
    const assignment = resolveAssignmentForValue(principal, directory);
    const sessionId = extractSessionId(req.body);
    const requestId = typeof req.headers?.['x-request-id'] === 'string'
      ? req.headers['x-request-id'].slice(0, 200)
      : null;
    const actionRoot = `${domain}.${operation}`;
    const toRelativePath = (value) => {
      if (!assignment || typeof value !== 'string' || !value.trim()) return null;
      const candidate = value.trim();
      if (!path.isAbsolute(candidate)) {
        const normalized = path.posix.normalize(candidate.split(path.sep).join('/'));
        return normalized === '..' || normalized.startsWith('../') ? null : normalized;
      }
      const relative = path.relative(assignment.repositoryPath, candidate);
      if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
      return relative.split(path.sep).join('/') || '.';
    };
    const pathCandidates = [
      req.body?.path,
      req.body?.oldPath,
      req.body?.newPath,
      ...((Array.isArray(req.body?.files) ? req.body.files : [])),
      parsed.searchParams.get('path'),
    ];
    const relativePaths = [...new Set(pathCandidates.map(toRelativePath).filter(Boolean))].slice(0, 100);
    const requestMetadata = {
      method: req.method,
      ...(assignment?.branchName ? { branch: assignment.branchName } : {}),
      ...(relativePaths.length > 0 ? { paths: relativePaths } : {}),
      ...(domain === 'github' && Number.isFinite(req.body?.number) ? { pullRequestNumber: req.body.number } : {}),
      ...(domain === 'github' && typeof req.body?.base === 'string' ? { base: req.body.base.slice(0, 160) } : {}),
      ...(domain === 'github' && typeof req.body?.head === 'string' ? { head: req.body.head.slice(0, 160) } : {}),
    };
    const requestedEventId = await audit(principal, `${actionRoot}.requested`, {
      targetType: `${domain}_operation`,
      projectId: assignment?.projectId || null,
      sessionId: sessionId || null,
      requestId,
      metadata: requestMetadata,
    });
    let outcomeRecorded = false;
    const recordOutcome = () => {
      if (outcomeRecorded) return;
      outcomeRecorded = true;
      void audit(principal, `${actionRoot}.completed`, {
        targetType: `${domain}_operation`,
        projectId: assignment?.projectId || null,
        sessionId: sessionId || null,
        requestId,
        success: res.statusCode < 400,
        metadata: {
          ...requestMetadata,
          statusCode: res.statusCode,
          requestedEventId,
          ...(res.locals.multiUserResponseAudit || {}),
        },
      }).catch((error) => logger.error?.('[MultiUser] Failed to persist mutation outcome audit:', error));
    };
    res.once('finish', recordOutcome);
    res.once('close', recordOutcome);
  };

  const loadPrincipal = async (userId, appSession = null) => {
    const profile = await supabase.rest('user_profiles', {
      query: { id: `eq.${escapeFilterValue(userId)}`, limit: 1 },
      maybeSingle: true,
    });
    if (!profile || profile.status !== 'active') return null;
    const [rolePolicy, userPolicy, accessRows, branchRows] = await Promise.all([
      supabase.rest('role_policies', { query: { role: `eq.${profile.role}`, limit: 1 }, maybeSingle: true }),
      readUserPolicy(userId),
      supabase.rest('user_project_access', { query: { user_id: `eq.${userId}` } }),
      supabase.rest('user_project_branches', { query: { user_id: `eq.${userId}` } }),
    ]);
    const projectIds = Array.from(new Set((accessRows || []).map((row) => row.project_id).filter(Boolean)));
    const projects = projectIds.length > 0
      ? await supabase.rest('managed_projects', {
          query: { id: `in.(${projectIds.map(escapeFilterValue).join(',')})`, status: 'eq.active' },
        })
      : [];
    const projectById = new Map((projects || []).map((row) => [row.id, row]));
    const worktreeContainerByProject = new Map();
    const assignments = [];
    for (const access of accessRows || []) {
      const project = projectById.get(access.project_id);
      if (!project) continue;
      let worktreeContainerPath = worktreeContainerByProject.get(project.id);
      if (!worktreeContainerPath) {
        const openCodeProjectId = await ensureOpenCodeProjectId(project.repository_path)
          .catch(() => project.id);
        worktreeContainerPath = path.join(getOpenCodeDataPath(), 'worktree', openCodeProjectId);
        worktreeContainerByProject.set(project.id, worktreeContainerPath);
      }
      const grants = (branchRows || []).filter((row) => row.project_id === project.id);
      for (const branch of grants) {
        assignments.push({
          projectId: project.id,
          label: project.label,
          icon: project.icon ?? null,
          color: project.color ?? null,
          iconBackground: project.icon_background ?? null,
          iconImage: project.icon_image ?? null,
          branchName: branch.branch_name,
          publicDirectory: project.repository_path,
          repositoryPath: project.repository_path,
          worktreeContainerPath,
          githubAccountId: profile.github_account_id || null,
          remoteUrl: project.remote_url || null,
          isDefault: appSession?.active_project_id
            ? appSession.active_project_id === project.id && appSession.active_branch === branch.branch_name
            : (access.is_default && branch.is_default),
        });
      }
    }
    return {
      id: profile.id,
      email: profile.email,
      displayName: profile.display_name,
      role: profile.role,
      scope: 'managed',
      status: profile.status,
      githubAccountId: profile.github_account_id || null,
      policy: normalizeRolePolicy(profile.role, rolePolicy, userPolicy),
      settingsOverrides: userPolicy?.settings_overrides || {},
      assignments,
      appSessionId: appSession?.id || null,
    };
  };

  const projectFromAssignment = (assignment, metadata = {}) => ({
    id: assignment.projectId,
    label: metadata.label ?? assignment.label,
    path: assignment.repositoryPath,
    icon: metadata.icon ?? assignment.icon ?? null,
    color: metadata.color ?? assignment.color ?? null,
    iconBackground: metadata.icon_background ?? assignment.iconBackground ?? null,
    iconImage: metadata.icon_image ?? assignment.iconImage ?? null,
  });

  const resolveManagedProject = async (req, projectId) => {
    const principal = req?.principal;
    if (principal?.scope !== 'managed') return null;
    const assignment = (principal.assignments || []).find((entry) => entry.projectId === projectId);
    if (!assignment) return null;
    const canMutate = principal.role === 'admin';
    return {
      project: projectFromAssignment(assignment),
      canMutate,
      canDiscover: canMutate,
      async persistIconImage(iconImage) {
        if (!canMutate) {
          throw Object.assign(new Error('Project metadata can only be changed by an administrator'), { statusCode: 403 });
        }
        const updated = await supabase.rest('managed_projects', {
          method: 'PATCH',
          query: { id: `eq.${escapeFilterValue(projectId)}`, status: 'eq.active' },
          body: { icon_image: iconImage },
          prefer: 'return=representation',
          maybeSingle: true,
        });
        if (!updated) {
          throw Object.assign(new Error('Managed project not found'), { statusCode: 404 });
        }
        principalCache.clear();
        return projectFromAssignment(assignment, updated);
      },
    };
  };

  const sessionTokenFromRequest = (req) => parseCookies(req.headers?.cookie)[APP_SESSION_COOKIE] || '';
  const inviteTokenFromRequest = (req) => parseCookies(req.headers?.cookie)[ACCESS_INVITE_COOKIE] || '';
  const clearAppSessionCookie = (req, res) => setCookie(req, res, '', 0);
  const clearInviteCookie = (req, res) => setInviteCookie(req, res, '', 0);

  const resolveRememberedOfflinePrincipal = (req, tokenHash) => {
    if (!isLoopbackRequest(req)) return null;
    const stored = vault.findByTokenHash(tokenHash);
    const value = stored?.value;
    const now = Date.now();
    if (
      !value?.rememberedLoopbackAdmin
      || value?.principalSnapshot?.role !== 'admin'
      || value?.principalSnapshot?.status !== 'active'
      || Number(value.appExpiresAt || 0) <= now
      || now - Number(value.lastValidatedAt || 0) > LOOPBACK_OFFLINE_GRACE_MS
    ) return null;
    return {
      ...value.principalSnapshot,
      appSessionId: stored.sessionId,
      offlineGrace: true,
    };
  };

  const resolvePrincipal = async (req, res = null) => {
    const token = sessionTokenFromRequest(req);
    if (!token) return null;
    const tokenHash = sha256(token);
    const cached = principalCache.get(tokenHash);
    if (cached && cached.cacheUntil > Date.now()) {
      req.principal = cached.principal;
      return cached.principal;
    }
    let appSession;
    try {
      appSession = await supabase.rest('app_sessions', {
        query: {
          session_token_hash: `eq.${tokenHash}`,
          revoked_at: 'is.null',
          expires_at: `gt.${new Date().toISOString()}`,
          limit: 1,
        },
        maybeSingle: true,
      });
    } catch (error) {
      const offlinePrincipal = resolveRememberedOfflinePrincipal(req, tokenHash);
      if (!offlinePrincipal) throw error;
      principalCache.set(tokenHash, { principal: offlinePrincipal, cacheUntil: Date.now() + PRINCIPAL_CACHE_MS });
      req.principal = offlinePrincipal;
      return offlinePrincipal;
    }
    if (!appSession) {
      const stored = vault.findByTokenHash(tokenHash);
      if (stored?.sessionId) {
        await vault.delete(stored.sessionId).catch((error) => {
          logger.warn?.('[MultiUser] Failed to remove an expired session from the local vault:', error?.message || error);
        });
        revokeConnections({ appSessionId: stored.sessionId });
      }
      if (res) clearAppSessionCookie(req, res);
      principalCache.delete(tokenHash);
      return null;
    }

    let storedTokens = vault.get(appSession.id);
    if (storedTokens?.refreshToken && Number(storedTokens.expiresAt || 0) * 1000 < Date.now() + 120_000) {
      try {
        const refreshed = await supabase.refreshSession(storedTokens.refreshToken);
        const refreshedTokens = {
          ...storedTokens,
          accessToken: refreshed.access_token,
          refreshToken: refreshed.refresh_token,
          expiresAt: refreshed.expires_at || Math.floor(Date.now() / 1000) + Number(refreshed.expires_in || 3600),
        };
        await vault.set(appSession.id, refreshedTokens);
        storedTokens = refreshedTokens;
      } catch (error) {
        const offlinePrincipal = resolveRememberedOfflinePrincipal(req, tokenHash);
        if (offlinePrincipal && !isDefinitiveRefreshRejection(error)) {
          principalCache.set(tokenHash, { principal: offlinePrincipal, cacheUntil: Date.now() + PRINCIPAL_CACHE_MS });
          req.principal = offlinePrincipal;
          return offlinePrincipal;
        }
        if (!isDefinitiveRefreshRejection(error)) throw error;
        await supabase.rest('app_sessions', {
          method: 'PATCH',
          query: { id: `eq.${appSession.id}` },
          body: { revoked_at: new Date().toISOString() },
          prefer: 'return=minimal',
        }).catch(() => {});
        await vault.delete(appSession.id).catch((vaultError) => {
          logger.warn?.('[MultiUser] Failed to remove a rejected session from the local vault:', vaultError?.message || vaultError);
        });
        revokeConnections({ appSessionId: appSession.id });
        principalCache.delete(tokenHash);
        if (res) clearAppSessionCookie(req, res);
        return null;
      }
    }

    const principal = await loadPrincipal(appSession.user_id, appSession);
    if (!principal) {
      await supabase.rest('app_sessions', {
        method: 'PATCH',
        query: { id: `eq.${appSession.id}` },
        body: { revoked_at: new Date().toISOString() },
        prefer: 'return=minimal',
      }).catch(() => {});
      await vault.delete(appSession.id).catch((error) => {
        logger.warn?.('[MultiUser] Failed to remove an inactive session from the local vault:', error?.message || error);
      });
      revokeConnections({ appSessionId: appSession.id });
      principalCache.delete(tokenHash);
      if (res) clearAppSessionCookie(req, res);
      return null;
    }
    const validatedAt = Date.now();
    if (!storedTokens || validatedAt - Number(storedTokens.lastValidatedAt || 0) >= VAULT_VALIDATION_CHECKPOINT_MS) {
      await vault.set(appSession.id, {
        ...(storedTokens || {}),
        sessionTokenHash: tokenHash,
        appExpiresAt: new Date(appSession.expires_at).getTime(),
        rememberedLoopbackAdmin: storedTokens?.rememberedLoopbackAdmin === true,
        lastValidatedAt: validatedAt,
        principalSnapshot: principal,
      }).catch((error) => logger.warn?.('[MultiUser] Failed to checkpoint validated session:', error?.message || error));
    }
    principalCache.set(tokenHash, { principal, cacheUntil: Date.now() + PRINCIPAL_CACHE_MS });
    req.principal = principal;
    void supabase.rest('app_sessions', {
      method: 'PATCH', query: { id: `eq.${appSession.id}` },
      body: { last_seen_at: new Date().toISOString() }, prefer: 'return=minimal',
    }).catch(() => {});
    return principal;
  };

  const profilesExist = async () => {
    const rows = await supabase.rest('user_profiles', { query: { select: 'id', limit: 1 } });
    return Array.isArray(rows) && rows.length > 0;
  };

  const listActiveAgentTestProfiles = () => supabase.rest('user_profiles', {
    query: {
      account_kind: `eq.${AGENT_TEST_ACCOUNT_KIND}`,
      status: 'eq.active',
      select: 'id,email,display_name,role,status,account_kind',
      order: 'created_at.asc',
    },
  });

  const revokeUserAppSessions = async (userId) => {
    const sessions = await supabase.rest('app_sessions', {
      query: { user_id: `eq.${escapeFilterValue(userId)}`, revoked_at: 'is.null', select: 'id' },
    }).catch(() => []);
    await supabase.rest('app_sessions', {
      method: 'PATCH', query: { user_id: `eq.${escapeFilterValue(userId)}`, revoked_at: 'is.null' },
      body: { revoked_at: new Date().toISOString() }, prefer: 'return=minimal',
    });
    for (const session of sessions || []) await vault.delete(session.id).catch(() => {});
    await Promise.all([abortOwnedSessions(userId), terminateOwnedTerminals(userId)]);
    principalCache.clear();
  };

  const loginKey = (req, email) => sha256(`${requestIp(req)}|${normalizeEmail(email)}`);
  const checkLoginLimit = (req, email) => {
    const key = loginKey(req, email);
    const now = Date.now();
    const current = loginAttempts.get(key);
    if (!current || now - current.startedAt > LOGIN_WINDOW_MS) return { allowed: true, key };
    if (current.lockedUntil > now) return { allowed: false, key, retryAfter: Math.ceil((current.lockedUntil - now) / 1000) };
    return { allowed: current.count < LOGIN_MAX_ATTEMPTS, key, retryAfter: 60 };
  };
  const failLogin = (key) => {
    const now = Date.now();
    const current = loginAttempts.get(key);
    const count = current && now - current.startedAt <= LOGIN_WINDOW_MS ? current.count + 1 : 1;
    loginAttempts.set(key, {
      count,
      startedAt: current?.startedAt || now,
      lockedUntil: count >= LOGIN_MAX_ATTEMPTS ? now + LOGIN_LOCK_MS : 0,
    });
  };

  const createAppSession = async ({ req, res, authSession, userId }) => {
    const rawToken = crypto.randomBytes(32).toString('base64url');
    const tokenHash = sha256(rawToken);
    const appSessionId = crypto.randomUUID();
    const principal = await loadPrincipal(userId);
    if (!principal) throw new Error('Account is not active');
    const rememberedLoopbackAdmin = req.body?.trustDevice === true
      && isLoopbackRequest(req)
      && principal.role === 'admin';
    const ttlMs = rememberedLoopbackAdmin ? REMEMBERED_ADMIN_TTL_MS : APP_SESSION_TTL_MS;
    const appExpiresAt = Date.now() + ttlMs;
    const active = getDefaultAssignment(principal);
    await supabase.rest('app_sessions', {
      method: 'POST',
      body: {
        id: appSessionId,
        user_id: userId,
        active_project_id: active?.projectId || null,
        active_branch: active?.branchName || null,
        session_token_hash: tokenHash,
        user_agent_hash: sha256(req.headers?.['user-agent'] || ''),
        ip_hash: sha256(requestIp(req)),
        expires_at: new Date(appExpiresAt).toISOString(),
      },
      prefer: 'return=minimal',
    });
    const finalPrincipal = await loadPrincipal(userId, {
      id: appSessionId,
      active_project_id: active?.projectId,
      active_branch: active?.branchName,
    });
    if (!finalPrincipal) {
      await supabase.rest('app_sessions', {
        method: 'PATCH', query: { id: `eq.${appSessionId}` },
        body: { revoked_at: new Date().toISOString() }, prefer: 'return=minimal',
      }).catch(() => {});
      throw new Error('Account is not active');
    }
    try {
      await vault.set(appSessionId, {
        accessToken: authSession.access_token,
        refreshToken: authSession.refresh_token,
        expiresAt: authSession.expires_at || Math.floor(Date.now() / 1000) + Number(authSession.expires_in || 3600),
        sessionTokenHash: tokenHash,
        appExpiresAt,
        rememberedLoopbackAdmin,
        lastValidatedAt: Date.now(),
        principalSnapshot: finalPrincipal,
      });
    } catch (error) {
      await supabase.rest('app_sessions', {
        method: 'PATCH', query: { id: `eq.${appSessionId}` },
        body: { revoked_at: new Date().toISOString() }, prefer: 'return=minimal',
      }).catch(() => {});
      throw error;
    }
    setCookie(req, res, rawToken, ttlMs);
    return finalPrincipal;
  };

  const archiveSessionOwnership = async ({ userId, projectId, branchNames = null }) => {
    const archivedAt = new Date().toISOString();
    const query = {
      user_id: `eq.${escapeFilterValue(userId)}`,
      project_id: `eq.${escapeFilterValue(projectId)}`,
      archived_at: 'is.null',
    };
    if (Array.isArray(branchNames) && branchNames.length > 0) {
      query.branch_name = `in.(${branchNames.map(escapeFilterValue).join(',')})`;
    }
    await supabase.rest('opencode_session_ownership', {
      method: 'PATCH',
      query,
      body: { archived_at: archivedAt },
      prefer: 'return=minimal',
    });
    await ownershipIndex.archiveWhere((row) => (
      row.user_id === userId
      && row.project_id === projectId
      && (!Array.isArray(branchNames) || branchNames.includes(row.branch_name))
    ), archivedAt);
  };

  const assignProject = async ({ userId, projectId, branchName, isDefault = true }) => {
    const [project, targetProfile] = await Promise.all([
      supabase.rest('managed_projects', {
        query: { id: `eq.${projectId}`, status: 'eq.active', limit: 1 }, maybeSingle: true,
      }),
      supabase.rest('user_profiles', {
        query: { id: `eq.${userId}`, limit: 1 }, maybeSingle: true,
      }),
    ]);
    if (!project) throw Object.assign(new Error('Managed project not found'), { statusCode: 404 });
    if (!targetProfile) throw Object.assign(new Error('User not found'), { statusCode: 404 });
    const branchOptions = buildBranchOptions(await getBranches(project.repository_path));
    const canonicalBranchName = normalizeLogicalBranchName(branchName);
    if (!branchOptions.some((option) => option.name === canonicalBranchName)) {
      throw Object.assign(new Error(`Branch is unavailable: ${canonicalBranchName || branchName}`), { statusCode: 400 });
    }
    const githubAccountId = verifiedGitHubAccountId(targetProfile.github_account_id);
    const [previousAccess, previousBranches] = await Promise.all([
      supabase.rest('user_project_access', { query: { user_id: `eq.${userId}` } }),
      supabase.rest('user_project_branches', { query: { user_id: `eq.${userId}` } }),
    ]);
    const previousTarget = (previousAccess || []).find((row) => row.project_id === projectId) || null;
    const accessIsDefault = isDefault || previousTarget?.is_default === true;
    try {
      if (isDefault) {
        await supabase.rest('user_project_access', {
          method: 'PATCH', query: { user_id: `eq.${userId}` }, body: { is_default: false }, prefer: 'return=minimal',
        });
        await supabase.rest('user_project_branches', {
          method: 'PATCH', query: { user_id: `eq.${userId}` }, body: { is_default: false }, prefer: 'return=minimal',
        });
      }
      await supabase.rest('user_project_access', {
        method: 'POST',
        body: { user_id: userId, project_id: projectId, github_account_id: githubAccountId, is_default: accessIsDefault },
        prefer: 'resolution=merge-duplicates,return=minimal',
      });
      await supabase.rest('user_project_branches', {
        method: 'POST',
        body: {
          user_id: userId,
          project_id: projectId,
          branch_name: canonicalBranchName,
          workspace_path: project.repository_path,
          is_default: isDefault,
        },
        prefer: 'resolution=merge-duplicates,return=minimal',
      });
    } catch (error) {
      if (!previousTarget) {
        await supabase.rest('user_project_access', {
          method: 'DELETE',
          query: { user_id: `eq.${userId}`, project_id: `eq.${projectId}` },
          prefer: 'return=minimal',
        }).catch(() => {});
      } else {
        await supabase.rest('user_project_access', {
          method: 'POST', body: previousTarget,
          prefer: 'resolution=merge-duplicates,return=minimal',
        }).catch(() => {});
      }
      if (isDefault) {
        for (const row of (previousAccess || []).filter((entry) => entry.is_default)) {
          await supabase.rest('user_project_access', {
            method: 'PATCH',
            query: { user_id: `eq.${userId}`, project_id: `eq.${row.project_id}` },
            body: { is_default: true }, prefer: 'return=minimal',
          }).catch(() => {});
        }
        for (const row of (previousBranches || []).filter((entry) => entry.is_default)) {
          await supabase.rest('user_project_branches', {
            method: 'PATCH',
            query: {
              user_id: `eq.${userId}`,
              project_id: `eq.${row.project_id}`,
              branch_name: `eq.${row.branch_name}`,
            },
            body: { is_default: true }, prefer: 'return=minimal',
          }).catch(() => {});
        }
      }
      throw error;
    }
    principalCache.clear();
    return { project, branchName: canonicalBranchName };
  };

  const archiveAndDeleteBranchGrants = async ({ userId, project, rows }) => {
    const branchRows = Array.isArray(rows) ? rows : [];
    if (branchRows.length === 0) return [];
    await supabase.rest('user_project_branches', {
      method: 'DELETE',
      query: {
        user_id: `eq.${escapeFilterValue(userId)}`,
        project_id: `eq.${escapeFilterValue(project.id)}`,
        branch_name: `in.(${branchRows.map((row) => escapeFilterValue(row.branch_name)).join(',')})`,
      },
      prefer: 'return=minimal',
    });
    await archiveSessionOwnership({
      userId,
      projectId: project.id,
      branchNames: branchRows.map((row) => row.branch_name),
    });
    return [];
  };

  const archiveAndDeleteProjectAccess = async ({ userId, project }) => {
    const branchRows = await supabase.rest('user_project_branches', {
      query: { user_id: `eq.${escapeFilterValue(userId)}`, project_id: `eq.${escapeFilterValue(project.id)}` },
    });
    await supabase.rest('user_project_access', {
      method: 'DELETE',
      query: { user_id: `eq.${escapeFilterValue(userId)}`, project_id: `eq.${escapeFilterValue(project.id)}` },
      prefer: 'return=minimal',
    });

    await archiveSessionOwnership({ userId, projectId: project.id });
    const remainingAccess = await supabase.rest('user_project_access', {
      query: { user_id: `eq.${escapeFilterValue(userId)}`, order: 'created_at.asc' },
    });
    if ((remainingAccess || []).length > 0 && !remainingAccess.some((row) => row.is_default)) {
      const replacement = remainingAccess[0];
      await supabase.rest('user_project_access', {
        method: 'PATCH',
        query: { user_id: `eq.${escapeFilterValue(userId)}`, project_id: `eq.${escapeFilterValue(replacement.project_id)}` },
        body: { is_default: true },
        prefer: 'return=minimal',
      });
      const replacementBranches = await supabase.rest('user_project_branches', {
        query: {
          user_id: `eq.${escapeFilterValue(userId)}`,
          project_id: `eq.${escapeFilterValue(replacement.project_id)}`,
          order: 'created_at.asc',
        },
      });
      if ((replacementBranches || []).length > 0 && !replacementBranches.some((row) => row.is_default)) {
        await supabase.rest('user_project_branches', {
          method: 'PATCH',
          query: {
            user_id: `eq.${escapeFilterValue(userId)}`,
            project_id: `eq.${escapeFilterValue(replacement.project_id)}`,
            branch_name: `eq.${escapeFilterValue(replacementBranches[0].branch_name)}`,
          },
          body: { is_default: true },
          prefer: 'return=minimal',
        });
      }
    }
    return { branchCount: (branchRows || []).length };
  };

  const createManagedUser = async ({ email, displayName, role, password, projectId, branchName, githubAccountId }) => {
    const normalizedEmail = normalizeEmail(email);
    if (!validEmail(normalizedEmail)) throw Object.assign(new Error('A valid email is required'), { statusCode: 400 });
    if (!validRole(role)) throw Object.assign(new Error('Invalid role'), { statusCode: 400 });
    const profileGitHubAccountId = verifiedGitHubAccountId(githubAccountId);
    const releaseGitHubMutation = profileGitHubAccountId
      ? await acquireMutationKey(`github-account:${profileGitHubAccountId}`)
      : () => {};
    const temporaryPassword = password || generatePassword();
    try {
      if (!validPassword(temporaryPassword)) throw Object.assign(new Error('Password must be at least 4 characters'), { statusCode: 400 });
      await assertGitHubAccountAvailable(profileGitHubAccountId);
      const authUser = await supabase.createAuthUser({
        email: normalizedEmail,
        password: temporaryPassword,
        metadata: { display_name: normalizeDisplayName(displayName, normalizedEmail) },
      });
      const userId = authUser?.id || authUser?.user?.id;
      if (!userId) throw new Error('Supabase did not return a user id');
      try {
        await supabase.rest('user_profiles', {
          method: 'POST',
          body: {
            id: userId,
            email: normalizedEmail,
            display_name: normalizeDisplayName(displayName, normalizedEmail),
            account_kind: HUMAN_ACCOUNT_KIND,
            role,
            status: role === 'admin' ? 'active' : 'suspended',
            github_account_id: profileGitHubAccountId,
          },
          prefer: 'return=minimal',
        });
        if (projectId && branchName) {
          await assignProject({ userId, projectId, branchName, isDefault: true });
          await supabase.rest('user_profiles', {
            method: 'PATCH',
            query: { id: `eq.${userId}` },
            body: { status: 'active' },
            prefer: 'return=minimal',
          });
        }
      } catch (error) {
        await supabase.deleteAuthUser(userId).catch(() => {});
        throw normalizeGitHubAssignmentError(error);
      }
      return {
        userId,
        email: normalizedEmail,
        displayName: normalizeDisplayName(displayName, normalizedEmail),
        role,
        status: role === 'admin' || (projectId && branchName) ? 'active' : 'suspended',
        githubAccountId: profileGitHubAccountId,
        temporaryPassword,
      };
    } finally {
      releaseGitHubMutation();
    }
  };

  const authorizeManagedRequest = async (req) => {
    const principal = req.principal;
    if (principal?.scope !== 'managed') return;
    const requestPath = typeof req.path === 'string'
      ? req.path
      : new URL(req.url || '/', 'http://127.0.0.1').pathname.replace(/^\/api/, '') || '/';
    const getHeader = (name) => typeof req.get === 'function'
      ? req.get(name)
      : req.headers?.[name.toLowerCase()];
    if (STATE_CHANGING_METHODS.has(req.method) && requestPath.startsWith('/') && getHeader('x-devryan-csrf') !== '1') {
      throw Object.assign(new Error('Missing CSRF request header'), { statusCode: 403 });
    }
    const offlineHostConfig = /^\/config\/(?:agents|commands|mcp|skills|plugins|opencode|models|providers)(?:\/|$)/.test(requestPath)
      || (requestPath.startsWith('/config/') && STATE_CHANGING_METHODS.has(req.method));
    if (principal.offlineGrace && (
      offlineHostConfig
      || /^\/(?:admin(?:\/|$)|github\/auth(?:\/|$)|auth(?:\/|$)|provider(?:\/|$)|mcp(?:\/|$)|projects(?:\/|$)|openchamber\/tunnel(?:\/|$)|diagnostics(?:\/|$))/.test(requestPath)
    )) {
      throw Object.assign(new Error('Account and host management are unavailable during offline grace'), { statusCode: 503 });
    }
    if (requestPath.startsWith('/terminal') && !principal.policy.terminal) {
      throw Object.assign(new Error('Terminal access is disabled by policy'), { statusCode: 403 });
    }
    if (/^\/(?:fs|find\/file|file)(?:\/|$)/.test(requestPath) && !principal.policy.files) {
      throw Object.assign(new Error('File access is disabled by policy'), { statusCode: 403 });
    }
    if (/^\/fs\/(?:exec|clone)(?:\/|$)/.test(requestPath) && principal.role !== 'admin') {
      throw Object.assign(new Error('Host filesystem operations are restricted to administrators'), { statusCode: 403 });
    }
    if (/^\/(?:diagnostics|evidence|memory-debug|desktop|browser-cdp)(?:\/|$)/.test(requestPath) && principal.role !== 'admin') {
      const settingsPage = settingsPageForRequest(requestPath, req.method);
      if (!settingsPage || !canReadSettingsPage(principal, settingsPage)) {
        throw Object.assign(new Error('Administrator access required'), { statusCode: 403 });
      }
    }
    const settingsPage = settingsPageForRequest(requestPath, req.method);
    if (settingsPage && !canReadSettingsPage(principal, settingsPage)) {
      throw Object.assign(new Error(`Read access to ${settingsPage} settings is disabled by policy`), { statusCode: 403 });
    }
    if (settingsPage && STATE_CHANGING_METHODS.has(req.method) && !canEditSettingsPage(principal, settingsPage)) {
      throw Object.assign(new Error(`Edit access to ${settingsPage} settings is disabled by policy`), { statusCode: 403 });
    }
    const projectIconMatch = requestPath.match(/^\/projects\/([^/]+)\/icon(?:\/|$)/);
    if (projectIconMatch && !(principal.assignments || []).some((entry) => entry.projectId === projectIconMatch[1])) {
      throw Object.assign(new Error('Project not found'), { statusCode: 404 });
    }
    if (!settingsPage && principal.role !== 'admin' && hostGlobalRead(requestPath)) {
      throw Object.assign(new Error('Host configuration is restricted to administrators'), { statusCode: 403 });
    }
    if (requestPath.startsWith('/github')) {
      const isAssignedIdentityStatus = req.method === 'GET' && requestPath === '/github/auth/status';
      if (!principal.policy.github && !isAssignedIdentityStatus) {
        throw Object.assign(new Error('GitHub access is disabled by policy'), { statusCode: 403 });
      }
      const githubPath = requestPath.slice('/github'.length) || '/';
      const isAccountManagement = /^\/auth(?:\/|$)/.test(githubPath)
        && (STATE_CHANGING_METHODS.has(req.method) || /^\/auth\/(?:start|complete|activate|gh-cli)/.test(githubPath));
      if (isAccountManagement && principal.role !== 'admin') {
        throw Object.assign(new Error('GitHub account management is restricted to administrators'), { statusCode: 403 });
      }
    }
    if (requestPath.startsWith('/git')) {
      const gitReq = { ...req, path: requestPath.slice('/git'.length) || '/' };
      if (!principal.policy.manageGit || (principal.role !== 'admin' && restrictedGitRoute(gitReq))) {
        throw Object.assign(new Error('Git operation is not allowed by policy'), { statusCode: 403 });
      }
      if (gitReq.path === '/push' && !principal.policy.push) {
        throw Object.assign(new Error('Push is disabled by policy'), { statusCode: 403 });
      }
      if (principal.role !== 'admin' && gitReq.method === 'POST' && gitReq.path === '/worktrees') {
        const requestedBase = String(req.body?.mode === 'existing' ? req.body?.existingBranch : req.body?.startRef || '').trim();
        const logicalBase = normalizeLogicalBranchName(requestedBase);
        const granted = new Set((principal.assignments || []).map((entry) => normalizeLogicalBranchName(entry.branchName)));
        if (logicalBase && logicalBase !== 'HEAD' && !granted.has(logicalBase)) {
          throw Object.assign(new Error('Worktrees can only be created from an assigned branch'), { statusCode: 403 });
        }
      }
    }
    if (!settingsPage && hostGlobalMutation({ ...req, path: requestPath }) && !principal.policy.manageGlobalSettings) {
      throw Object.assign(new Error('Host configuration is restricted to administrators'), { statusCode: 403 });
    }
    const translatePathFields = !/^\/(?:git|github)(?:\/|$)/.test(requestPath);
    await rewriteUrlQuery(req, principal, { translatePathFields });
    await rewriteBodyPaths(req.body, principal, { translatePathFields });
    const headerDirectory = req.headers?.['x-opencode-directory'];
    if (typeof headerDirectory === 'string' && headerDirectory.trim()) {
      const translated = await translateDirectoryHeaderValue(principal, headerDirectory);
      if (!translated) throw Object.assign(new Error('Directory is outside your assigned workspace'), { statusCode: 403 });
      req.headers['x-opencode-directory'] = translated;
    } else if (!req.url.includes('directory=') && !req.body?.directory) {
      const active = getDefaultAssignment(principal);
      if (active && /^\/(?:session|config\/providers|git|fs|event)(?:\/|$)/.test(requestPath)) {
        req.headers['x-opencode-directory'] = active.repositoryPath;
      }
    }
  };

  const getRequestAssignment = (principal, req) => {
    const parsed = new URL(req.url || '/', 'http://127.0.0.1');
    const directory = req.body?.directory
      || req.body?.cwd
      || parsed.searchParams.get('directory')
      || req.headers?.['x-opencode-directory'];
    return resolveAssignmentForValue(principal, directory);
  };

  const authController = {
    enabled: true,
    multiUser: true,
    resolvePrincipal,
    async requireAuth(req, res, next) {
      if (req.method === 'OPTIONS') return next();
      try {
        const principal = await resolvePrincipal(req, res);
        if (!principal) return jsonError(res, 401, 'Authentication required', { authenticated: false, locked: true, mode: 'multi-user' });
        req.principal = principal;
        await authorizeManagedRequest(req);
        const requestPath = typeof req.path === 'string'
          ? req.path
          : new URL(req.url || '/', 'http://127.0.0.1').pathname.replace(/^\/api/, '') || '/';
        if (req.method === 'POST' && requestPath === '/git/worktrees') {
          res.once('finish', () => {
            if (res.statusCode < 400) principalCache.clear();
          });
        }
        wrapJsonResponse(req, res);
        await registerMutationAudit(principal, req, res);
        const releaseMutation = await acquireRequestMutation(principal, req);
        const unregisterConnection = registerConnection(principal, () => {
          if (!res.destroyed) res.destroy(new Error('Access revoked'));
        });
        const cleanup = () => {
          unregisterConnection();
          releaseMutation();
        };
        res.once('finish', cleanup);
        res.once('close', cleanup);
        return runWithRequestPrincipal(principal, next, {
          assignment: getRequestAssignment(principal, req),
        });
      } catch (error) {
        if (error?.statusCode) return jsonError(res, error.statusCode, error.message);
        const failure = authFailurePayload(error);
        return jsonError(res, failure.status, failure.error, {
          authenticated: false,
          mode: 'multi-user',
          code: failure.code,
          ...(failure.requiredMigration ? { requiredMigration: failure.requiredMigration } : {}),
        });
      }
    },
    async handleSessionStatus(req, res) {
      try {
        const principal = await resolvePrincipal(req, res);
        const loopback = isLoopbackRequest(req);
        if (principal) return res.json({
          authenticated: true,
          mode: 'multi-user',
          principal: publicPrincipal(principal),
          rememberAvailable: loopback && principal.role === 'admin',
          offlineGrace: principal.offlineGrace === true,
        });
        const [hasProfiles, agentTestProfiles] = await Promise.all([
          profilesExist(),
          loopback ? listActiveAgentTestProfiles() : Promise.resolve([]),
        ]);
        return jsonError(res, 401, 'Authentication required', {
          authenticated: false,
          locked: true,
          mode: 'multi-user',
          claimAvailable: loopback && !hasProfiles,
          invitePending: Boolean(inviteTokenFromRequest(req)),
          rememberAvailable: loopback,
          ...(loopback ? { agentTestIdentities: buildAgentTestIdentities(agentTestProfiles) } : {}),
        });
      } catch (error) {
        const failure = authFailurePayload(error);
        logger.warn?.(`[MultiUser] Session status failed (${failure.code})`);
        return jsonError(res, failure.status, failure.error, {
          authenticated: false,
          mode: 'multi-user',
          code: failure.code,
          ...(failure.requiredMigration ? { requiredMigration: failure.requiredMigration } : {}),
          localResetAvailable: isLoopbackRequest(req) && Boolean(sessionTokenFromRequest(req)),
        });
      }
    },
    async handleSessionCreate(req, res) {
      const email = normalizeEmail(req.body?.email);
      const rate = checkLoginLimit(req, email);
      if (!rate.allowed) return jsonError(res, 429, 'Too many login attempts', { retryAfter: rate.retryAfter });
      try {
        if (!validEmail(email) || typeof req.body?.password !== 'string') throw new Error('Invalid credentials');
        const authSession = await supabase.signInWithPassword({ email, password: req.body.password });
        const userId = authSession?.user?.id;
        if (!userId) throw new Error('Invalid credentials');
        const principal = await createAppSession({ req, res, authSession, userId });
        loginAttempts.delete(rate.key);
        await audit(principal, 'auth.login', { metadata: { sessionTtlHours: 12 } });
        return res.json({ authenticated: true, mode: 'multi-user', principal: publicPrincipal(principal) });
      } catch (error) {
        failLogin(rate.key);
        if (error instanceof SupabaseRequestError && error.status === 429) {
          return jsonError(res, 429, 'Too many login attempts', { retryAfter: 60 });
        }
        if (error?.code === AUTH_ERROR_CODES.schemaMigrationRequired
          || isSettingsPermissionSchemaError(error)) {
          const failure = authFailurePayload(error);
          return jsonError(res, failure.status, failure.error, {
            code: failure.code,
            requiredMigration: failure.requiredMigration,
          });
        }
        const isCredentialRejection = error?.message === 'Invalid credentials'
          || error?.message === 'Account is not active'
          || (error instanceof SupabaseRequestError && error.status >= 400 && error.status < 500);
        if (isCredentialRejection) return jsonError(res, 401, 'Invalid credentials');
        const failure = authFailurePayload(error);
        return jsonError(res, failure.status, failure.error, { code: failure.code });
      }
    },
    // Loopback-only, password-free login for the reserved agent_test fixture
    // accounts, so coding agents can perform visual verification without ever
    // handling credentials. Normal policy/assignment/audit enforcement applies.
    async handleAgentTestSession(req, res) {
      if (!isLoopbackRequest(req)) return jsonError(res, 403, 'Agent-test sessions are loopback-only');
      const email = normalizeEmail(req.body?.email);
      const role = typeof req.body?.role === 'string' ? req.body.role.trim().toLowerCase() : '';
      if (email && !validEmail(email)) return jsonError(res, 400, 'A valid email is required');
      try {
        const profiles = await listActiveAgentTestProfiles();
        const profile = selectAgentTestProfile(profiles, { role, email });
        const authSession = await supabase.mintAgentTestSession(profile.email);
        const userId = authSession?.user?.id;
        if (!userId || userId !== profile.id) throw new Error('Agent-test login failed');
        const principal = await createAppSession({ req, res, authSession, userId });
        await audit(principal, 'auth.agent_test_login', {
          metadata: { sessionTtlHours: 12, agentTestRole: profile.role },
        });
        return res.json({ authenticated: true, mode: 'multi-user', principal: publicPrincipal(principal) });
      } catch (error) {
        if (Number.isFinite(error?.statusCode) && error.statusCode < 500) {
          return jsonError(res, error.statusCode, error.message);
        }
        const failure = authFailurePayload(error);
        logger.warn?.(`[MultiUser] Agent-test login failed (${failure.code})`);
        return jsonError(res, failure.status, failure.error, {
          code: failure.code,
          ...(failure.requiredMigration ? { requiredMigration: failure.requiredMigration } : {}),
        });
      }
    },
    async handleClaim(req, res) {
      if (claimInProgress) return jsonError(res, 409, 'Initial administrator claim is already in progress');
      claimInProgress = true;
      try {
        if (!isLoopbackRequest(req)) return jsonError(res, 403, 'Initial administrator claim is loopback-only');
        if (await profilesExist()) return jsonError(res, 409, 'Initial administrator has already been claimed');
        const created = await createManagedUser({
          email: req.body?.email,
          displayName: req.body?.displayName,
          role: 'admin',
          password: req.body?.password,
        });
        await reconcileSessionOwnership({ force: true }).catch((error) => {
          logger.warn?.('[MultiUser] Initial administrator was created; session reconciliation was deferred:', error?.message || error);
        });
        await audit(null, 'admin.claimed', { targetType: 'user', targetId: created.userId });
        return res.status(201).json({ created: true, user: { ...created, temporaryPassword: undefined } });
      } catch (error) {
        return jsonError(res, error?.statusCode || 500, error?.message || 'Failed to claim administrator');
      } finally {
        claimInProgress = false;
      }
    },
    async handleInviteAccept(req, res) {
      const token = inviteTokenFromRequest(req) || String(req.body?.token || '').trim();
      const email = normalizeEmail(req.body?.email);
      const rate = checkLoginLimit(req, email);
      if (!rate.allowed) return jsonError(res, 429, 'Too many attempts', { retryAfter: rate.retryAfter });
      const claimId = crypto.randomUUID();
      let claimedInvite = null;
      let inviteConsumed = false;
      try {
        const invite = await supabase.rest('access_invites', {
          query: {
            token_hash: `eq.${sha256(token)}`,
            consumed_at: 'is.null', revoked_at: 'is.null',
            expires_at: `gt.${new Date().toISOString()}`, limit: 1,
          },
          maybeSingle: true,
        });
        if (!invite || !timingSafeTextEqual(normalizeEmail(invite.email), email)) throw new Error('Invalid invite');
        const profile = await supabase.rest('user_profiles', {
          query: { email: `eq.${escapeFilterValue(email)}`, limit: 1 },
          maybeSingle: true,
        });
        if (!profile || profile.role === 'admin' || profile.status === 'archived') throw new Error('Invalid invite');
        const authSession = await supabase.signInWithPassword({ email, password: req.body?.password });
        if (!authSession?.user?.id || authSession.user.id !== profile.id) throw new Error('Invalid invite');
        const now = new Date();
        claimedInvite = await supabase.rest('access_invites', {
          method: 'PATCH',
          query: {
            id: `eq.${invite.id}`,
            consumed_at: 'is.null',
            revoked_at: 'is.null',
            expires_at: `gt.${now.toISOString()}`,
            or: `(claim_id.is.null,claim_expires_at.lt.${now.toISOString()})`,
          },
          body: {
            claim_id: claimId,
            claim_expires_at: new Date(now.getTime() + 5 * 60 * 1000).toISOString(),
          },
          prefer: 'return=representation',
          maybeSingle: true,
        });
        if (!claimedInvite) throw new Error('Invalid invite');
        if (claimedInvite.project_id && claimedInvite.branch_name) {
          const inviteGitHubAccountId = verifiedGitHubAccountId(claimedInvite.github_account_id);
          await supabase.rest('user_profiles', {
            method: 'PATCH',
            query: { id: `eq.${profile.id}` },
            body: { github_account_id: inviteGitHubAccountId },
            prefer: 'return=minimal',
          });
          try {
            await assignProject({
              userId: profile.id,
              projectId: claimedInvite.project_id,
              branchName: claimedInvite.branch_name,
              isDefault: true,
            });
            await supabase.rest('user_profiles', {
              method: 'PATCH', query: { id: `eq.${profile.id}` }, body: { status: 'active' }, prefer: 'return=minimal',
            });
          } catch (error) {
            await supabase.rest('user_profiles', {
              method: 'PATCH',
              query: { id: `eq.${profile.id}` },
              body: { github_account_id: profile.github_account_id || null },
              prefer: 'return=minimal',
            }).catch(() => {});
            throw error;
          }
          principalCache.clear();
        }
        const consumed = await supabase.rest('access_invites', {
          method: 'PATCH',
          query: { id: `eq.${invite.id}`, claim_id: `eq.${claimId}`, consumed_at: 'is.null' },
          body: {
            consumed_at: new Date().toISOString(),
            consumed_by: profile.id,
            claim_id: null,
            claim_expires_at: null,
          },
          prefer: 'return=representation',
          maybeSingle: true,
        });
        if (!consumed) throw new Error('Invalid invite');
        inviteConsumed = true;
        const principal = await createAppSession({ req, res, authSession, userId: profile.id });
        clearInviteCookie(req, res);
        loginAttempts.delete(rate.key);
        await audit(principal, 'invite.accepted', { targetType: 'invite', targetId: invite.id });
        return res.json({ authenticated: true, mode: 'multi-user', principal: publicPrincipal(principal) });
      } catch {
        if (claimedInvite && !inviteConsumed) {
          await supabase.rest('access_invites', {
            method: 'PATCH',
            query: { id: `eq.${claimedInvite.id}`, claim_id: `eq.${claimId}`, consumed_at: 'is.null' },
            body: { claim_id: null, claim_expires_at: null },
            prefer: 'return=minimal',
          }).catch(() => {});
        }
        failLogin(rate.key);
        return jsonError(res, 401, 'Invite is invalid or expired');
      }
    },
    async handleConnect(req, res) {
      const token = typeof req.query?.t === 'string' ? req.query.t.trim() : '';
      if (!token) return res.status(404).type('text/plain').send('Invitation not found');
      try {
        const invite = await supabase.rest('access_invites', {
          query: {
            token_hash: `eq.${sha256(token)}`,
            consumed_at: 'is.null', revoked_at: 'is.null',
            expires_at: `gt.${new Date().toISOString()}`, limit: 1,
          },
          maybeSingle: true,
        });
        if (!invite) return res.status(404).type('text/plain').send('Invitation not found');
        const ttlMs = Math.max(1_000, Math.min(30 * 60 * 1000, new Date(invite.expires_at).getTime() - Date.now()));
        setInviteCookie(req, res, token, ttlMs);
        return res.redirect(303, '/');
      } catch {
        return res.status(503).type('text/plain').send('Identity service unavailable');
      }
    },
    async prepareFreshTunnelLogin(req, res) {
      const token = sessionTokenFromRequest(req);
      if (!token) {
        clearAppSessionCookie(req, res);
        return { appSessionId: null, remoteRevoked: true, localVaultCleared: true };
      }

      const tokenHash = sha256(token);
      const stored = vault.findByTokenHash(tokenHash);
      let session = null;
      try {
        session = await supabase.rest('app_sessions', {
          query: { session_token_hash: `eq.${tokenHash}`, limit: 1 }, maybeSingle: true,
        });
        if (session) {
          await supabase.rest('app_sessions', {
            method: 'PATCH', query: { id: `eq.${session.id}` },
            body: { revoked_at: new Date().toISOString() }, prefer: 'return=minimal',
          });
        }
      } catch (error) {
        throw Object.assign(new Error('Remote session revocation could not be confirmed'), {
          code: 'fresh_login_cleanup_failed',
          cause: error,
        });
      }

      const appSessionId = session?.id || stored?.sessionId || null;
      if (appSessionId) {
        try {
          await vault.delete(appSessionId);
        } catch (error) {
          throw Object.assign(new Error('Local session cleanup could not be completed'), {
            code: 'fresh_login_cleanup_failed',
            cause: error,
          });
        }
      }

      principalCache.delete(tokenHash);
      clearAppSessionCookie(req, res);
      if (appSessionId) revokeConnections({ appSessionId });
      return { appSessionId, remoteRevoked: true, localVaultCleared: true };
    },
    async handleLogout(req, res) {
      const token = sessionTokenFromRequest(req);
      const tokenHash = token ? sha256(token) : '';
      const stored = tokenHash ? vault.findByTokenHash(tokenHash) : null;
      let session = null;
      let remoteRevoked = true;
      let localVaultCleared = true;

      try {
        session = token ? await supabase.rest('app_sessions', {
          query: { session_token_hash: `eq.${tokenHash}`, limit: 1 }, maybeSingle: true,
        }) : null;
        if (session) {
          await supabase.rest('app_sessions', {
            method: 'PATCH', query: { id: `eq.${session.id}` },
            body: { revoked_at: new Date().toISOString() }, prefer: 'return=minimal',
          });
        }
      } catch {
        remoteRevoked = false;
        logger.warn?.('[MultiUser] Remote session revocation could not be confirmed; local session cleanup will continue.');
      }

      const appSessionId = session?.id || stored?.sessionId || null;
      const userId = session?.user_id || stored?.value?.principalSnapshot?.id || null;
      if (appSessionId) {
        try {
          await vault.delete(appSessionId);
        } catch {
          localVaultCleared = false;
          logger.warn?.('[MultiUser] Failed to remove the local session vault entry during logout.');
        }
        revokeConnections({ appSessionId });
      }
      if (userId) {
        const cleanupResults = await Promise.allSettled([
          abortOwnedSessions(userId),
          terminateOwnedTerminals(userId),
        ]);
        if (cleanupResults.some((result) => result.status === 'rejected')) {
          logger.warn?.('[MultiUser] Some user-owned runtime resources did not stop cleanly during logout.');
        }
      }
      if (tokenHash) principalCache.delete(tokenHash);
      clearAppSessionCookie(req, res);
      const payload = {
        authenticated: false,
        localSessionCleared: true,
        localVaultCleared,
        remoteRevoked,
      };
      if (!localVaultCleared) {
        return jsonError(res, 500, 'Local session cleanup was incomplete', payload);
      }
      if (!remoteRevoked) {
        return jsonError(res, 503, 'Remote session revocation could not be confirmed', {
          ...payload,
          code: AUTH_ERROR_CODES.identityUnavailable,
        });
      }
      return res.json(payload);
    },
    handlePasskeyStatus(req, res) {
      if (!isLoopbackRequest(req) || !loopbackPasskeyController?.enabled) {
        return res.json({ enabled: false, hasPasskeys: false, passkeyCount: 0, rpID: null, multiUser: true });
      }
      return loopbackPasskeyController.handlePasskeyStatus(req, res);
    },
    handlePasskeyRegistrationOptions(req, res) {
      if (!isLoopbackRequest(req) || req.principal?.role !== 'admin' || !loopbackPasskeyController?.enabled) {
        return jsonError(res, 403, 'Passkeys are available only to a loopback administrator');
      }
      return loopbackPasskeyController.handlePasskeyRegistrationOptions(req, res);
    },
    handlePasskeyRegistrationVerify(req, res) {
      if (!isLoopbackRequest(req) || req.principal?.role !== 'admin' || !loopbackPasskeyController?.enabled) {
        return jsonError(res, 403, 'Passkeys are available only to a loopback administrator');
      }
      return loopbackPasskeyController.handlePasskeyRegistrationVerify(req, res);
    },
    handlePasskeyAuthenticationOptions(req, res) {
      if (!isLoopbackRequest(req) || !loopbackPasskeyController?.enabled) {
        return jsonError(res, 403, 'Passkey login is available only on loopback');
      }
      return loopbackPasskeyController.handlePasskeyAuthenticationOptions(req, res);
    },
    async handlePasskeyAuthenticationVerify(req, res) {
      if (!isLoopbackRequest(req) || !loopbackPasskeyController?.enabled
        || typeof loopbackPasskeyController.verifyPasskeyAuthentication !== 'function') {
        return jsonError(res, 403, 'Passkey login is available only on loopback');
      }
      try {
        await loopbackPasskeyController.verifyPasskeyAuthentication(req.body);
        const admin = await supabase.rest('user_profiles', {
          query: {
            role: 'eq.admin',
            status: 'eq.active',
            order: 'created_at.asc',
            select: 'id',
            limit: 1,
          },
          maybeSingle: true,
        });
        if (!admin?.id) return jsonError(res, 403, 'No active administrator is available');
        const principal = await createAppSession({ req, res, authSession: {}, userId: admin.id });
        await audit(principal, 'auth.passkey_login', { metadata: { loopback: true } });
        return res.json({ authenticated: true, mode: 'multi-user', principal: publicPrincipal(principal) });
      } catch (error) {
        return jsonError(res, error?.statusCode || 401, error?.message || 'Passkey verification failed');
      }
    },
    handlePasskeyList(req, res) {
      if (!isLoopbackRequest(req) || req.principal?.role !== 'admin' || !loopbackPasskeyController?.enabled) {
        return jsonError(res, 403, 'Passkeys are available only to a loopback administrator');
      }
      return loopbackPasskeyController.handlePasskeyList(req, res);
    },
    handlePasskeyRevoke(req, res) {
      if (!isLoopbackRequest(req) || req.principal?.role !== 'admin' || !loopbackPasskeyController?.enabled) {
        return jsonError(res, 403, 'Passkeys are available only to a loopback administrator');
      }
      return loopbackPasskeyController.handlePasskeyRevoke(req, res);
    },
    handleResetAuth(req, res) { return this.handleLogout(req, res); },
    async ensureSessionToken(req, res) {
      const principal = await resolvePrincipal(req, res);
      if (!principal) return null;
      req.principal = principal;
      try {
        await authorizeManagedRequest(req);
      } catch {
        return null;
      }
      return sessionTokenFromRequest(req);
    },
    registerConnection,
    async authorizeSystemRequest(req, res, next) {
      const principal = await resolvePrincipal(req, res).catch(() => null);
      if (!principal) return jsonError(res, 401, 'Authentication required');
      if (principal.role !== 'admin') return jsonError(res, 403, 'Administrator access required');
      req.principal = principal;
      return runWithRequestPrincipal(principal, next);
    },
    async dispose() {
      for (const userId of [...connectionsByUser.keys()]) revokeConnections({ userId });
      principalCache.clear();
      loginAttempts.clear();
      projectedActivityKeys.clear();
      await Promise.all([ownershipIndex.drain(), auditOutbox.drain()]);
    },
  };

  const sessionOwnership = async (sessionId) => {
    return ownershipIndex.get(sessionId);
  };

  const ownsSession = async (principal, sessionId) => {
    if (principal?.scope !== 'managed') return true;
    const owner = await sessionOwnership(sessionId);
    return !owner?.archived_at && owner?.user_id === principal.id && (principal.assignments || []).some((assignment) => (
      assignment.projectId === owner.project_id && assignment.branchName === owner.branch_name
    ));
  };

  const canSessionTokenHashAccess = async (tokenHash, sessionId) => {
    if (!/^[a-f0-9]{64}$/.test(String(tokenHash || ''))) return false;
    const appSession = await supabase.rest('app_sessions', {
      query: {
        session_token_hash: `eq.${tokenHash}`,
        revoked_at: 'is.null',
        expires_at: `gt.${new Date().toISOString()}`,
        limit: 1,
      },
      maybeSingle: true,
    });
    if (!appSession) return false;
    const principal = await loadPrincipal(appSession.user_id, appSession);
    return principal ? ownsSession(principal, sessionId) : false;
  };

  // Admins may open sessions in directories with no existing grant; mirror the
  // legacy-backfill shape (find-or-create project, repo-root workspace) so
  // ownership/audit/revocation invariants still hold for those sessions.
  const ensureAdminProjectAccess = async (principal, directory) => {
    if (principal?.role !== 'admin') return null;
    const input = typeof directory === 'string' ? directory.trim() : '';
    if (!input || !path.isAbsolute(input)) return null;
    let repositoryPath;
    try {
      repositoryPath = await fs.realpath(input);
      if (!(await fs.stat(repositoryPath)).isDirectory()) return null;
    } catch {
      return null;
    }
    let project = await supabase.rest('managed_projects', {
      query: { repository_path: `eq.${repositoryPath}`, limit: 1 }, maybeSingle: true,
    });
    const branchResult = await getBranches(repositoryPath).catch(() => ({ current: null }));
    const branchName = branchResult.current || project?.default_branch || 'main';
    if (!project) {
      project = await supabase.rest('managed_projects', {
        method: 'POST',
        body: {
          label: path.basename(repositoryPath),
          repository_path: repositoryPath,
          remote_url: normalizeGitHubRemoteUrl(await getRemoteUrl(repositoryPath, 'origin').catch(() => '')),
          default_branch: branchName,
          created_by: principal.id,
        },
        prefer: 'return=representation', maybeSingle: true,
      });
    }
    if (!project) return null;
    const existingDefault = await supabase.rest('user_project_access', {
      query: { user_id: `eq.${principal.id}`, is_default: 'eq.true', select: 'project_id', limit: 1 },
      maybeSingle: true,
    });
    const existingDefaultBranch = await supabase.rest('user_project_branches', {
      query: { user_id: `eq.${principal.id}`, project_id: `eq.${project.id}`, is_default: 'eq.true', limit: 1 },
      maybeSingle: true,
    });
    await supabase.rest('user_project_access', {
      method: 'POST',
      body: {
        user_id: principal.id,
        project_id: project.id,
        github_account_id: principal.githubAccountId || null,
        is_default: !existingDefault,
      },
      prefer: 'resolution=merge-duplicates,return=minimal',
    });
    await supabase.rest('user_project_branches', {
      method: 'POST',
      body: {
        user_id: principal.id,
        project_id: project.id,
        branch_name: branchName,
        workspace_path: repositoryPath,
        is_default: existingDefaultBranch ? existingDefaultBranch.branch_name === branchName : true,
      },
      prefer: 'resolution=merge-duplicates,return=minimal',
    });
    principalCache.clear();
    return { projectId: project.id, branchName, publicDirectory: repositoryPath };
  };

  const recordSessionOwnership = async (principal, session) => {
    const sessionId = typeof session?.id === 'string' ? session.id : '';
    if (!sessionId) throw new Error('OpenCode session response did not include an id');
    const requestedDirectory = typeof session.directory === 'string' ? session.directory : '';
    let assignment = requestedDirectory
      ? resolveAssignmentForValue(principal, requestedDirectory)
      : getDefaultAssignment(principal);
    if (!assignment && requestedDirectory) {
      assignment = await ensureAdminProjectAccess(principal, requestedDirectory);
    }
    if (!assignment) throw new Error('No managed project is assigned');
    const row = {
      session_id: sessionId,
      user_id: principal.id,
      project_id: assignment.projectId,
      branch_name: assignment.branchName,
      public_directory: assignment.publicDirectory,
    };
    await ownershipIndex.set(row);
    try {
      await supabase.rest('opencode_session_ownership', {
        method: 'POST', body: row, prefer: 'resolution=merge-duplicates,return=minimal',
      });
    } catch (error) {
      await ownershipIndex.delete(sessionId).catch(() => {});
      throw error;
    }
    try {
      await audit(principal, 'session.created', {
        targetType: 'session', targetId: sessionId, sessionId, projectId: assignment.projectId,
      });
    } catch (error) {
      await supabase.rest('opencode_session_ownership', {
        method: 'DELETE', query: { session_id: `eq.${sessionId}` }, prefer: 'return=minimal',
      }).catch(() => {});
      await ownershipIndex.delete(sessionId).catch(() => {});
      throw error;
    }
  };

  const resolveScheduledTaskExecution = async ({ ownerUserId, projectId, branchName, taskId }) => {
    if (!ownerUserId) return null;
    const principal = await loadPrincipal(ownerUserId);
    if (!principal) {
      throw Object.assign(new Error('Scheduled task owner is suspended or unavailable'), { statusCode: 403 });
    }
    const logicalBranch = normalizeLogicalBranchName(branchName);
    const assignment = (principal.assignments || []).find((entry) => (
      entry.projectId === projectId
      && normalizeLogicalBranchName(entry.branchName) === logicalBranch
    ));
    if (!assignment) {
      throw Object.assign(new Error('Scheduled task branch access has been revoked'), { statusCode: 403 });
    }
    const target = await runWithRequestPrincipal(principal, () => ensureBranchTarget({
      repositoryPath: assignment.repositoryPath,
      branchName: logicalBranch,
      idempotencyKey: `scheduled_${String(taskId || 'task')}_${crypto.randomUUID().replaceAll('-', '')}`,
      ownerId: principal.id,
    }));
    if (target.status !== 'success') {
      throw Object.assign(new Error(target.message || 'Scheduled task branch target is not ready'), { statusCode: 409 });
    }
    return { principal, assignment, directory: target.directory, branchName: logicalBranch };
  };

  const recordScheduledTaskSessionOwnership = async ({ ownerUserId, projectId, branchName, sessionId }) => {
    const principal = await loadPrincipal(ownerUserId);
    if (!principal) throw new Error('Scheduled task owner is suspended or unavailable');
    const logicalBranch = normalizeLogicalBranchName(branchName);
    const assignment = (principal.assignments || []).find((entry) => (
      entry.projectId === projectId
      && normalizeLogicalBranchName(entry.branchName) === logicalBranch
    ));
    if (!assignment) throw new Error('Scheduled task branch access has been revoked');
    const row = {
      session_id: sessionId,
      user_id: principal.id,
      project_id: projectId,
      branch_name: logicalBranch,
      public_directory: assignment.publicDirectory,
    };
    await ownershipIndex.set(row);
    try {
      await supabase.rest('opencode_session_ownership', {
        method: 'POST', body: row, prefer: 'resolution=merge-duplicates,return=minimal',
      });
      await audit(principal, 'session.created', {
        targetType: 'session', targetId: sessionId, sessionId, projectId,
        metadata: { scheduledTask: true, branchName: logicalBranch },
      });
    } catch (error) {
      await supabase.rest('opencode_session_ownership', {
        method: 'DELETE', query: { session_id: `eq.${sessionId}` }, prefer: 'return=minimal',
      }).catch(() => {});
      await ownershipIndex.delete(sessionId).catch(() => {});
      throw error;
    }
    return true;
  };

  const recordChildSessionOwnership = async (principal, session, parentId) => {
    const sessionId = typeof session?.id === 'string' ? session.id : '';
    const parent = await sessionOwnership(parentId);
    if (!sessionId || !parent || parent.user_id !== principal.id) return false;
    const row = {
      session_id: sessionId,
      user_id: parent.user_id,
      project_id: parent.project_id,
      branch_name: parent.branch_name,
      public_directory: parent.public_directory,
    };
    await ownershipIndex.set(row);
    try {
      await supabase.rest('opencode_session_ownership', {
        method: 'POST', body: row, prefer: 'resolution=merge-duplicates,return=minimal',
      });
    } catch (error) {
      await ownershipIndex.delete(sessionId).catch(() => {});
      throw error;
    }
    try {
      await audit(principal, 'session.child_created', {
        targetType: 'session', targetId: sessionId, sessionId, projectId: parent.project_id,
        metadata: { parentSessionId: parentId },
      });
    } catch (error) {
      await supabase.rest('opencode_session_ownership', {
        method: 'DELETE', query: { session_id: `eq.${sessionId}` }, prefer: 'return=minimal',
      }).catch(() => {});
      await ownershipIndex.delete(sessionId).catch(() => {});
      throw error;
    }
    return true;
  };

  const filterEventForPrincipal = async (principal, { payload, directory } = {}) => {
    if (principal?.scope !== 'managed') return true;
    const info = payload?.properties?.info;
    const childId = typeof info?.id === 'string' ? info.id : '';
    const parentId = typeof info?.parentID === 'string' ? info.parentID : '';
    if (childId && parentId && !await sessionOwnership(childId)) {
      try {
        if (!await recordChildSessionOwnership(principal, info, parentId)) return false;
      } catch {
        return false;
      }
    }
    const sessionId = extractSessionId(payload);
    if (sessionId) return ownsSession(principal, sessionId);
    if (directory && directory !== 'global') return Boolean(resolveAssignmentForValue(principal, directory));
    return payload?.type === 'openchamber:heartbeat' || payload?.type === 'server.connected';
  };

  const fetchUpstreamJson = async ({ req, buildOpenCodeUrl, getOpenCodeAuthHeaders, pathname, method = req.method, body = req.body }) => {
    const sourceUrl = new URL(req.originalUrl || req.url, 'http://127.0.0.1');
    const target = new URL(buildOpenCodeUrl(pathname, ''));
    for (const [key, value] of sourceUrl.searchParams) target.searchParams.set(key, value);
    const response = await fetchImpl(target, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body !== undefined && method !== 'GET' ? { 'Content-Type': 'application/json' } : {}),
        ...getOpenCodeAuthHeaders(),
      },
      body: body !== undefined && method !== 'GET' ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(120_000),
    });
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
    return { response, payload };
  };

  const registerRoutes = (app, {
    readSettingsFromDiskMigrated,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
  } = {}) => {
    const canReviewUsers = (principal) => canReadSettingsPage(principal, 'users');
    const canManageUsers = (principal) => canEditSettingsPage(principal, 'users');
    const requireAnalyticsAdmin = (principal) => principal?.scope === 'managed' && principal.role === 'admin';
    const loadActivityPages = async (query, { pageSize = 1_000 } = {}) => {
      const rows = [];
      let offset = 0;
      while (true) {
        const page = await supabase.rest('activity_logs', {
          query: { ...query, limit: pageSize, offset },
        });
        rows.push(...(page || []));
        if (!page || page.length < pageSize) break;
        offset += page.length;
      }
      return rows;
    };
    const loadAnalyticsTarget = (userId) => supabase.rest('user_profiles', {
      query: {
        id: `eq.${escapeFilterValue(userId)}`,
        account_kind: `eq.${HUMAN_ACCOUNT_KIND}`,
        select: 'id,email,display_name,role,status',
        limit: 1,
      },
      maybeSingle: true,
    });
    const attachActivityActors = async (rows) => {
      const actorIds = [...new Set((rows || []).map((row) => row.actor_user_id).filter(Boolean))];
      if (actorIds.length === 0) return rows || [];
      const actors = await supabase.rest('user_profiles', {
        query: {
          id: `in.(${actorIds.map(escapeFilterValue).join(',')})`,
          select: 'id,display_name,role',
        },
      }).catch(() => []);
      const actorById = new Map((actors || []).map((actor) => [actor.id, actor]));
      return (rows || []).map((row) => {
        const actor = actorById.get(row.actor_user_id);
        return {
          ...row,
          actor: actor ? { id: actor.id, displayName: actor.display_name, role: actor.role } : null,
        };
      });
    };

    app.get('/api/session-folders', async (req, res, next) => {
      if (req.principal?.scope !== 'managed') return next();
      try {
        const policy = await supabase.rest('user_policies', {
          query: {
            user_id: `eq.${escapeFilterValue(req.principal.id)}`,
            select: 'session_folders',
            limit: 1,
          },
          maybeSingle: true,
        });
        return res.json(policy?.session_folders || emptySessionFolders());
      } catch (error) {
        return jsonError(res, error?.status || 500, error.message);
      }
    });

    app.post('/api/session-folders', async (req, res, next) => {
      if (req.principal?.scope !== 'managed') return next();
      try {
        const sessionFolders = normalizeSessionFoldersPayload(req.body);
        await supabase.rest('user_policies', {
          method: 'POST',
          body: { user_id: req.principal.id, session_folders: sessionFolders },
          prefer: 'resolution=merge-duplicates,return=minimal',
        });
        return res.json({ success: true });
      } catch (error) {
        return jsonError(res, error?.statusCode || error?.status || 500, error.message);
      }
    });

    app.post('/api/session/:sessionID/prompt_async', (req, res, next) => {
      const promptOrigin = req.get?.('x-devryan-prompt-origin') || req.headers?.['x-devryan-prompt-origin'];
      if (req.principal?.scope !== 'managed' || promptOrigin !== 'human') return next();
      const occurredAt = new Date().toISOString();
      const assignment = getRequestAssignment(req.principal, req);
      const prompt = extractHumanPrompt({
        body: req.body,
        sessionId: req.params.sessionID,
        assignment,
        occurredAt,
      });
      if (!prompt) return next();
      let recorded = false;
      const persistAcceptedPrompt = async () => {
        if (recorded) return;
        if (res.statusCode < 200 || res.statusCode >= 300) return;
        recorded = true;
        try {
          await audit(req.principal, prompt.action, {
            eventId: prompt.eventId,
            occurredAt: prompt.occurredAt,
            deferred: true,
            targetType: 'user',
            targetId: req.principal.id,
            projectId: prompt.projectId,
            sessionId: prompt.sessionId,
            metadata: prompt.metadata,
          });
        } catch (error) {
          recorded = false;
          throw error;
        }
      };
      if (typeof res.end === 'function') {
        const originalEnd = res.end.bind(res);
        let ending = false;
        res.end = (...args) => {
          if (ending) return res;
          ending = true;
          if (res.statusCode < 200 || res.statusCode >= 300) return originalEnd(...args);
          void persistAcceptedPrompt()
            .catch((error) => logger.error?.('[MultiUser] Failed to persist prompt analytics:', error))
            .finally(() => originalEnd(...args));
          return res;
        };
      }
      // Lightweight route-test adapters may complete through json()/send()
      // without Node's end(); production end() persists before acknowledgement.
      res.once('finish', () => {
        void persistAcceptedPrompt().catch((error) => logger.error?.('[MultiUser] Failed to persist prompt analytics:', error));
      });
      return next();
    });

    app.post('/api/analytics/events', async (req, res, next) => {
      if (req.principal?.scope !== 'managed') return next();
      const events = Array.isArray(req.body?.events) ? req.body.events : null;
      if (!events) return jsonError(res, 400, 'An events array is required');
      if (events.length === 0 || events.length > ANALYTICS_EVENT_BATCH_LIMIT) {
        return jsonError(res, 400, `Event batches must contain 1-${ANALYTICS_EVENT_BATCH_LIMIT} items`);
      }
      const now = Date.now();
      const results = [];
      for (const event of events) {
        const result = validateInteractionEvent(event, {
          now,
          resolveAssignment: (directory) => resolveAssignmentForValue(req.principal, directory),
          containsPath: isPathContained,
        });
        if (!result.accepted) {
          results.push(result);
          continue;
        }
        try {
          await audit(req.principal, result.action, {
            eventId: result.eventId,
            occurredAt: result.occurredAt,
            deferred: true,
            targetType: 'user',
            targetId: req.principal.id,
            projectId: result.assignment.projectId,
            metadata: {
              ...result.metadata,
              projectName: result.assignment.label || null,
              branchName: result.assignment.branchName || null,
            },
          });
          results.push({ id: result.id, accepted: true });
        } catch (error) {
          logger.warn?.('[MultiUser] Interaction analytics enqueue failed:', error?.message || error);
          results.push({ id: result.id, accepted: false, error: 'Event could not be stored locally' });
        }
      }
      return res.json({ results });
    });

    if (typeof buildOpenCodeUrl === 'function' && typeof getOpenCodeAuthHeaders === 'function') {
      abortOwnedSessions = async (userId) => {
        const rows = ownershipIndex.list().filter((row) => row.user_id === userId && !row.archived_at);
        const branchRows = await supabase.rest('user_project_branches', {
          query: { user_id: `eq.${escapeFilterValue(userId)}` },
        }).catch(() => []);
        const workspaceByBranch = new Map((branchRows || []).map((row) => [
          `${row.project_id}\0${row.branch_name}`,
          row.workspace_path,
        ]));
        await Promise.allSettled(rows.map(async (row) => {
          const target = new URL(buildOpenCodeUrl(`/session/${encodeURIComponent(row.session_id)}/abort`, ''));
          const workspacePath = workspaceByBranch.get(`${row.project_id}\0${row.branch_name}`);
          if (typeof workspacePath !== 'string' || !workspacePath) return;
          target.searchParams.set('directory', workspacePath);
          await fetchImpl(target, {
            method: 'POST',
            headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
            signal: AbortSignal.timeout(5_000),
          });
        }));
      };

      const canonicalDirectory = async (value) => {
        if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value)) return null;
        try {
          const resolved = await fs.realpath(value);
          return (await fs.stat(resolved)).isDirectory() ? resolved : null;
        } catch {
          return null;
        }
      };

      const fetchExperimentalSessionPage = async ({ archived, cursor = null, limit = 200, query = {} }) => {
        const target = new URL(buildOpenCodeUrl('/experimental/session', ''));
        for (const key of ['directory', 'workspace', 'roots', 'start', 'search']) {
          const value = query?.[key];
          if (typeof value === 'string' && value) target.searchParams.set(key, value);
        }
        target.searchParams.set('archived', String(Boolean(archived)));
        target.searchParams.set('limit', String(normalizeSessionPageLimit(limit)));
        if (cursor !== null) target.searchParams.set('cursor', String(cursor));
        const response = await fetchImpl(target, {
          headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
          signal: AbortSignal.timeout(15_000),
        });
        const sessions = await response.json().catch(() => []);
        if (!response.ok) throw new Error(`Failed to enumerate sessions (${response.status})`);
        const rawCursor = response.headers.get('x-next-cursor');
        const parsedCursor = rawCursor === null ? null : Number(rawCursor);
        return {
          sessions: Array.isArray(sessions) ? sessions : [],
          nextCursor: Number.isFinite(parsedCursor) ? parsedCursor : null,
        };
      };

      const enumerateExperimentalSessions = async (archived) => {
        const sessions = [];
        const seenCursors = new Set();
        let cursor = null;
        while (true) {
          const cursorKey = cursor === null ? 'initial' : String(cursor);
          if (seenCursors.has(cursorKey)) break;
          seenCursors.add(cursorKey);
          const page = await fetchExperimentalSessionPage({ archived, cursor, limit: 200 });
          sessions.push(...page.sessions);
          const fallbackCursor = page.sessions.length >= 200
            ? Number(page.sessions[page.sessions.length - 1]?.time?.updated)
            : null;
          const nextCursor = page.nextCursor ?? (Number.isFinite(fallbackCursor) ? fallbackCursor : null);
          if (nextCursor === null || (cursor !== null && nextCursor >= cursor)) break;
          cursor = nextCursor;
        }
        return sessions;
      };

      const loadOwnershipCandidates = async () => {
        const profiles = await supabase.rest('user_profiles', { query: { status: 'eq.active' } });
        const principals = (await Promise.all((profiles || []).map((profile) => (
          loadPrincipal(profile.id).catch(() => null)
        )))).filter(Boolean);
        const candidates = [];
        for (const principal of principals) {
          for (const assignment of principal.assignments || []) {
            const resolved = await canonicalDirectory(assignment.repositoryPath);
            if (!resolved) continue;
            candidates.push({
              userId: principal.id,
              projectId: assignment.projectId,
              branchName: assignment.branchName,
              publicDirectory: assignment.publicDirectory,
              canonicalDirectory: resolved,
              isDefault: assignment.isDefault === true,
            });
          }
        }
        return candidates;
      };

      const repairSessionOwnership = async (session, candidates) => {
        if (!session?.id || await sessionOwnership(session.id)) return false;
        const resolvedDirectory = await canonicalDirectory(session.directory);
        if (!resolvedDirectory) return false;
        const candidate = selectUniqueOwnershipCandidate(candidates, resolvedDirectory);
        if (!candidate) return false;
        const proposed = {
          session_id: session.id,
          user_id: candidate.userId,
          project_id: candidate.projectId,
          branch_name: candidate.branchName,
          public_directory: candidate.publicDirectory,
        };
        await supabase.rest('opencode_session_ownership', {
          method: 'POST',
          body: proposed,
          prefer: 'resolution=ignore-duplicates,return=minimal',
        });
        const durable = await supabase.rest('opencode_session_ownership', {
          query: { session_id: `eq.${escapeFilterValue(session.id)}`, limit: 1 },
          maybeSingle: true,
        });
        if (!durable || durable.archived_at || durable.user_id !== candidate.userId) return false;
        await ownershipIndex.set(durable);
        await audit(null, 'session.ownership_repaired', {
          targetType: 'session',
          targetId: session.id,
          targetUserId: candidate.userId,
          sessionId: session.id,
          projectId: candidate.projectId,
          metadata: { branchName: candidate.branchName },
        });
        return true;
      };

      let reconciliationPromise = null;
      let reconciliationCompleted = false;
      let reconciliationResult = { repaired: 0 };
      reconcileSessionOwnership = ({ force = false } = {}) => {
        if (reconciliationPromise) return reconciliationPromise;
        if (reconciliationCompleted && !force) return Promise.resolve(reconciliationResult);
        const current = (async () => {
          const [candidates, activeSessions, archivedSessions] = await Promise.all([
            loadOwnershipCandidates(),
            enumerateExperimentalSessions(false),
            enumerateExperimentalSessions(true),
          ]);
          let repaired = 0;
          for (const session of [...activeSessions, ...archivedSessions]) {
            if (await repairSessionOwnership(session, candidates)) repaired += 1;
          }
          reconciliationResult = { repaired };
          reconciliationCompleted = true;
          return reconciliationResult;
        })();
        reconciliationPromise = current;
        void current.finally(() => {
          if (reconciliationPromise === current) reconciliationPromise = null;
        }).catch(() => {});
        return current;
      };

      void reconcileSessionOwnership().catch((error) => {
        logger.warn?.('[MultiUser] Session ownership reconciliation deferred:', error?.message || error);
      });

      ensureOwnedSession = async (principal, sessionId) => {
        if (await ownsSession(principal, sessionId)) return true;
        const existing = await sessionOwnership(sessionId);
        if (existing) return false;
        await reconcileSessionOwnership({ force: true }).catch((error) => {
          logger.warn?.('[MultiUser] Session ownership reconciliation failed:', error?.message || error);
        });
        return ownsSession(principal, sessionId);
      };

      app.get('/api/experimental/session', async (req, res, next) => {
        if (req.principal?.scope !== 'managed') return next();
        try {
          await reconcileSessionOwnership().catch((error) => {
            logger.warn?.('[MultiUser] Session listing reconciliation failed:', error?.message || error);
          });
          const archived = String(req.query?.archived || '').toLowerCase() === 'true';
          const result = await listVisibleSessionPage({
            limit: req.query?.limit,
            cursor: req.query?.cursor,
            fetchPage: ({ cursor, limit }) => fetchExperimentalSessionPage({
              archived,
              cursor,
              limit,
              query: req.query,
            }),
            isVisible: (session) => ownsSession(req.principal, session.id),
          });
          if (result.nextCursor !== null) res.setHeader('X-Next-Cursor', String(result.nextCursor));
          return res.json(result.sessions);
        } catch (error) {
          return jsonError(res, 502, error.message);
        }
      });

      app.patch('/api/session/:sessionID', async (req, res, next) => {
        if (req.principal?.scope !== 'managed') return next();
        try {
          if (!await ensureOwnedSession(req.principal, req.params.sessionID)) {
            return jsonError(res, 404, 'Session not found');
          }
          const archivedAt = req.body?.time?.archived;
          const action = archivedAt === 0
            ? 'session.unarchived'
            : (Number.isFinite(archivedAt) && archivedAt > 0 ? 'session.archived' : null);
          if (action) {
            let recorded = false;
            const recordOutcome = () => {
              if (recorded) return;
              recorded = true;
              void audit(req.principal, action, {
                targetType: 'session',
                targetId: req.params.sessionID,
                sessionId: req.params.sessionID,
                success: res.statusCode < 400,
                metadata: { statusCode: res.statusCode },
              }).catch((error) => logger.error?.('[MultiUser] Failed to persist session lifecycle audit:', error));
            };
            res.once('finish', recordOutcome);
            res.once('close', recordOutcome);
          }
          res.locals.multiUserSessionAuthorized = true;
          return next();
        } catch (error) {
          return jsonError(res, error?.statusCode || 502, error.message);
        }
      });
    }

    app.get('/api/admin/users', async (req, res) => {
      if (!canReviewUsers(req.principal)) return jsonError(res, 403, 'User review access required');
      try {
        const query = buildUserManagementProfileQuery(req.principal.role);
        const users = await supabase.rest('user_profiles', { query });
        return res.json({ users });
      } catch (error) { return jsonError(res, 500, error.message); }
    });

    app.get('/api/admin/github-accounts', async (req, res) => {
      if (req.principal?.role !== 'admin') return jsonError(res, 403, 'Administrator access required');
      try {
        const [accounts, assignedProfiles] = await Promise.all([
          Promise.resolve(getAllGitHubAuthAccounts()),
          supabase.rest('user_profiles', {
            query: {
              github_account_id: 'not.is.null',
              select: 'id,email,display_name,github_account_id',
            },
          }),
        ]);
        const ownerByAccount = new Map((assignedProfiles || []).map((profile) => [profile.github_account_id, profile]));
        return res.json({
          accounts: (accounts || []).map((account) => {
            const owner = ownerByAccount.get(account.id) || null;
            return {
              ...account,
              assignedUser: owner ? {
                id: owner.id,
                email: owner.email,
                displayName: owner.display_name,
              } : null,
            };
          }),
        });
      } catch (error) {
        if (isMissingUserProfileGithubAccountError(error)) {
          return jsonError(res, 503, 'Database migration required', {
            code: AUTH_ERROR_CODES.schemaMigrationRequired,
            requiredMigration: USER_PROFILE_GITHUB_ACCOUNT_MIGRATION,
          });
        }
        return jsonError(res, error?.statusCode || error?.status || 500, error.message);
      }
    });

    app.put('/api/admin/github-accounts/:accountId/assignment', async (req, res) => {
      if (req.principal?.role !== 'admin') return jsonError(res, 403, 'Administrator access required');
      const accountId = String(req.params.accountId || '').trim();
      if (!accountId) return jsonError(res, 400, 'GitHub account id is required', { code: 'GITHUB_ACCOUNT_ID_REQUIRED' });
      if (!Object.hasOwn(req.body || {}, 'userId')) {
        return jsonError(res, 400, 'GitHub assignment userId is required', { code: 'GITHUB_ASSIGNMENT_TARGET_REQUIRED' });
      }
      const rawTargetUserId = req.body?.userId;
      if (rawTargetUserId !== null && typeof rawTargetUserId !== 'string') {
        return jsonError(res, 400, 'GitHub assignment userId must be a UUID or null', { code: 'GITHUB_ASSIGNMENT_TARGET_INVALID' });
      }
      const targetUserId = typeof rawTargetUserId === 'string' ? rawTargetUserId.trim() : null;
      if (targetUserId !== null && !validUuid(targetUserId)) {
        return jsonError(res, 400, 'GitHub assignment userId must be a UUID or null', { code: 'GITHUB_ASSIGNMENT_TARGET_INVALID' });
      }

      const releaseMutation = await acquireMutationKey(`github-account:${accountId}`);
      try {
        if (!getGitHubAuthById(accountId)) {
          return jsonError(res, 404, 'GitHub account not found', { code: 'GITHUB_ACCOUNT_NOT_FOUND' });
        }

        if (targetUserId) {
          const targetProfile = await supabase.rest('user_profiles', {
            query: {
              id: `eq.${escapeFilterValue(targetUserId)}`,
              select: 'id,email,display_name,account_kind,github_account_id',
              limit: 1,
            },
            maybeSingle: true,
          });
          if (!targetProfile) {
            return jsonError(res, 404, 'GitHub assignment target was not found', {
              code: 'GITHUB_ASSIGNMENT_TARGET_NOT_FOUND',
            });
          }
          if (targetProfile.id !== req.principal.id && targetProfile.account_kind !== HUMAN_ACCOUNT_KIND) {
            return jsonError(res, 403, 'Only visible users or the signed-in administrator may receive this GitHub account', {
              code: 'GITHUB_ASSIGNMENT_TARGET_NOT_ALLOWED',
            });
          }
          if (targetProfile.github_account_id && targetProfile.github_account_id !== accountId) {
            return jsonError(res, 409, `${targetProfile.display_name} already has another GitHub account`, {
              code: 'GITHUB_ASSIGNMENT_TARGET_CONFLICT',
              conflictingAccountId: targetProfile.github_account_id,
            });
          }
        }

        const assignment = await supabase.rpc('devryan_reassign_github_account', {
          p_account_id: accountId,
          p_target_user_id: targetUserId,
        });
        const previousAssignedUser = assignment?.previousAssignedUser || null;
        const assignedUser = assignment?.assignedUser || null;
        principalCache.clear();
        await audit(req.principal, 'github.account_assignment_changed', {
          targetType: 'github_account',
          targetId: accountId,
          metadata: {
            previousUserId: previousAssignedUser?.id || null,
            assignedUserId: assignedUser?.id || null,
          },
        });
        const affectedUserIds = [...new Set([
          previousAssignedUser?.id,
          assignedUser?.id,
        ].filter(Boolean))];
        if (affectedUserIds.length > 0) {
          revokeConnectionsAfterResponse(res, affectedUserIds.map((userId) => ({ userId })));
        }
        return res.json({ accountId, previousAssignedUser, assignedUser });
      } catch (error) {
        if (isMissingGithubAccountReassignmentFunctionError(error)) {
          return jsonError(res, 503, 'Database migration required', {
            code: AUTH_ERROR_CODES.schemaMigrationRequired,
            requiredMigration: GITHUB_ACCOUNT_REASSIGNMENT_MIGRATION,
          });
        }
        const rpcDetail = String(error?.payload?.details || error?.payload?.detail || '').trim();
        if (rpcDetail === 'GITHUB_ASSIGNMENT_TARGET_CONFLICT') {
          return jsonError(res, 409, 'GitHub assignment target already has another account', {
            code: rpcDetail,
          });
        }
        if (rpcDetail === 'GITHUB_ASSIGNMENT_TARGET_NOT_FOUND') {
          return jsonError(res, 404, 'GitHub assignment target was not found', {
            code: rpcDetail,
          });
        }
        return jsonError(res, error?.statusCode || error?.status || 500, error.message);
      } finally {
        releaseMutation();
      }
    });

    app.delete('/api/admin/github-accounts/:accountId', async (req, res) => {
      if (req.principal?.role !== 'admin') return jsonError(res, 403, 'Administrator access required');
      const accountId = String(req.params.accountId || '').trim();
      if (!accountId) return jsonError(res, 400, 'GitHub account id is required');
      const releaseMutation = await acquireMutationKey(`github-account:${accountId}`);
      try {
        if (!getGitHubAuthById(accountId)) return jsonError(res, 404, 'GitHub account not found');
        const owner = await findGitHubAccountOwner(accountId);
        if (owner) {
          return jsonError(res, 409, `GitHub account is assigned to ${owner.display_name}`, {
            code: 'GITHUB_ACCOUNT_ASSIGNED',
            assignedUser: { id: owner.id, email: owner.email, displayName: owner.display_name },
          });
        }
        if (!clearGitHubAuthById(accountId)) return jsonError(res, 404, 'GitHub account not found');
        await audit(req.principal, 'github.account_disconnected', {
          targetType: 'github_account',
          targetId: accountId,
        });
        return res.json({ removed: true });
      } catch (error) {
        return jsonError(res, error?.statusCode || error?.status || 500, error.message);
      } finally {
        releaseMutation();
      }
    });

    app.post('/api/admin/users', async (req, res) => {
      if (!canManageUsers(req.principal)) return jsonError(res, 403, 'User management edit access required');
      if (req.body?.githubAccountId && req.principal?.role !== 'admin') {
        return jsonError(res, 403, 'GitHub account assignment requires administrator access');
      }
      try {
        const created = await createManagedUser(req.body || {});
        await audit(req.principal, 'user.created', { targetType: 'user', targetId: created.userId, metadata: { role: created.role } });
        return res.status(201).json({ user: created });
      } catch (error) {
        return jsonError(res, error?.statusCode || error?.status || 500, error.message, error?.code ? {
          code: error.code,
          assignedUserId: error.assignedUserId || null,
        } : {});
      }
    });

    app.patch('/api/admin/users/:userId', async (req, res) => {
      if (!canManageUsers(req.principal)) return jsonError(res, 403, 'User management edit access required');
      let releaseGitHubMutation = () => {};
      try {
        const currentUser = await supabase.rest('user_profiles', {
          query: { id: `eq.${escapeFilterValue(req.params.userId)}`, limit: 1 }, maybeSingle: true,
        });
        if (!currentUser) return jsonError(res, 404, 'User not found');
        const changes = {};
        if (req.body?.role !== undefined) {
          if (!validRole(req.body.role)) return jsonError(res, 400, 'Invalid role');
          if (req.body.role !== currentUser.role) changes.role = req.body.role;
        }
        if (req.body?.status !== undefined) {
          if (!['active', 'suspended', 'archived'].includes(req.body.status)) return jsonError(res, 400, 'Invalid status');
          if (req.body.status !== currentUser.status) changes.status = req.body.status;
        }
        if (typeof req.body?.displayName === 'string') {
          const displayName = normalizeDisplayName(req.body.displayName, 'User');
          if (displayName !== currentUser.display_name) changes.display_name = displayName;
        }
        if (Object.prototype.hasOwnProperty.call(req.body || {}, 'githubAccountId')) {
          if (req.principal?.role !== 'admin') {
            return jsonError(res, 403, 'GitHub account assignment requires administrator access');
          }
          const githubAccountId = verifiedGitHubAccountId(req.body.githubAccountId);
          if (githubAccountId !== (currentUser.github_account_id || null)) {
            if (githubAccountId) {
              releaseGitHubMutation = await acquireMutationKey(`github-account:${githubAccountId}`);
              await assertGitHubAccountAvailable(githubAccountId, currentUser.id);
            }
            changes.github_account_id = githubAccountId;
          }
        }
        if (Object.keys(changes).length === 0) return jsonError(res, 400, 'No user profile changes supplied');
        const disablesAdmin = currentUser.role === 'admin' && (
          (changes.role && changes.role !== 'admin')
          || (changes.status && changes.status !== 'active')
        );
        if (disablesAdmin) {
          const activeAdmins = await supabase.rest('user_profiles', {
            query: { role: 'eq.admin', status: 'eq.active', select: 'id' },
          });
          if ((activeAdmins || []).length <= 1) {
            return jsonError(res, 409, 'The final enabled administrator cannot be demoted or disabled');
          }
        }
        const user = await supabase.rest('user_profiles', {
          method: 'PATCH', query: { id: `eq.${req.params.userId}` }, body: changes,
          prefer: 'return=representation', maybeSingle: true,
        });
        const securityChanged = Object.hasOwn(changes, 'role') || Object.hasOwn(changes, 'status');
        const githubChanged = Object.hasOwn(changes, 'github_account_id');
        if (securityChanged) await revokeUserAppSessions(req.params.userId);
        principalCache.clear();
        const beforeProfile = {
          displayName: currentUser.display_name,
          role: currentUser.role,
          status: currentUser.status,
          githubAccountId: currentUser.github_account_id || null,
        };
        const afterProfile = {
          ...beforeProfile,
          ...(Object.hasOwn(changes, 'display_name') ? { displayName: changes.display_name } : {}),
          ...(Object.hasOwn(changes, 'role') ? { role: changes.role } : {}),
          ...(Object.hasOwn(changes, 'status') ? { status: changes.status } : {}),
          ...(Object.hasOwn(changes, 'github_account_id') ? { githubAccountId: changes.github_account_id } : {}),
        };
        await audit(req.principal, 'user.updated', {
          targetType: 'user',
          targetId: req.params.userId,
          metadata: {
            fields: Object.keys(changes),
            changes: buildSafeFieldDeltas(beforeProfile, afterProfile),
            changedBy: req.principal.id === req.params.userId ? 'user' : 'administrator',
          },
        });
        if (securityChanged || githubChanged) revokeConnectionsAfterResponse(res, { userId: req.params.userId });
        return res.json({ user });
      } catch (caughtError) {
        const error = normalizeGitHubAssignmentError(caughtError);
        return jsonError(res, error?.statusCode || error?.status || 500, error.message, error?.code ? {
          code: error.code,
          assignedUserId: error.assignedUserId || null,
        } : {});
      } finally {
        releaseGitHubMutation();
      }
    });

    app.post('/api/admin/users/:userId/reset-password', async (req, res) => {
      if (!canManageUsers(req.principal)) return jsonError(res, 403, 'User management edit access required');
      const password = req.body?.password || generatePassword();
      if (!validPassword(password)) return jsonError(res, 400, 'Password must be at least 4 characters');
      try {
        await supabase.updateAuthUser(req.params.userId, { password });
        await revokeUserAppSessions(req.params.userId);
        await audit(req.principal, 'user.password_reset', { targetType: 'user', targetId: req.params.userId });
        revokeConnectionsAfterResponse(res, { userId: req.params.userId });
        return res.json({ reset: true, temporaryPassword: password });
      } catch (error) { return jsonError(res, error?.status || 500, error.message); }
    });

    app.get('/api/admin/users/:userId/policy', async (req, res) => {
      if (!canReviewUsers(req.principal)) return jsonError(res, 403, 'User review access required');
      try {
        const profile = await supabase.rest('user_profiles', {
          query: { id: `eq.${escapeFilterValue(req.params.userId)}`, limit: 1 }, maybeSingle: true,
        });
        if (!profile) return jsonError(res, 404, 'User not found');
        const [rolePolicy, userPolicy] = await Promise.all([
          supabase.rest('role_policies', { query: { role: `eq.${profile.role}`, limit: 1 }, maybeSingle: true }),
          readUserPolicy(req.params.userId),
        ]);
        return res.json({
          userId: profile.id,
          role: profile.role,
          inherited: !userPolicy,
          policy: userPolicy || {
            settings_pages: null,
            settings_permission_overrides: {},
            capabilities: {},
            settings_overrides: {},
          },
          inheritedPolicy: normalizeRolePolicy(profile.role, rolePolicy, null),
          effective: normalizeRolePolicy(profile.role, rolePolicy, userPolicy),
        });
      } catch (error) { return settingsPermissionWriteError(res, error); }
    });

    app.put('/api/admin/users/:userId/policy', async (req, res) => {
      if (!canManageUsers(req.principal)) return jsonError(res, 403, 'User management edit access required');
      try {
        const profile = await supabase.rest('user_profiles', {
          query: { id: `eq.${escapeFilterValue(req.params.userId)}`, limit: 1 }, maybeSingle: true,
        });
        if (!profile) return jsonError(res, 404, 'User not found');
        const legacySettingsPages = Array.isArray(req.body?.settingsPages) ? req.body.settingsPages : null;
        const permissionResult = validateSettingsPermissionsPayload(
          req.body?.settingsPermissionOverrides
            || (legacySettingsPages ? settingsPermissionsFromLegacyPages(legacySettingsPages) : {}),
          { sparse: true },
        );
        if (!permissionResult.valid) return jsonError(res, 400, permissionResult.error);
        const rolePolicy = await supabase.rest('role_policies', {
          query: { role: `eq.${profile.role}`, limit: 1 }, maybeSingle: true,
        });
        const previousPolicy = await readUserPolicy(profile.id);
        const inherited = normalizeRolePolicy(profile.role, rolePolicy, null);
        const settingsPermissionOverrides = profile.role === 'admin' ? {} : Object.fromEntries(Object.entries(permissionResult.permissions).map(([slug, permission]) => {
          const normalized = { ...permission };
          if (normalized.read === false) normalized.edit = false;
          if (normalized.edit === true && (normalized.read ?? inherited.settingsPermissions[slug]?.read) === false) {
            normalized.read = true;
          }
          return [slug, normalized];
        }));
        const effective = normalizeRolePolicy(profile.role, rolePolicy, {
          settings_permission_overrides: settingsPermissionOverrides,
          capabilities: {},
        });
        const settingsPages = ['home', ...Object.entries(effective.settingsPermissions)
          .filter(([, permission]) => permission.read)
          .map(([slug]) => slug)];
        const capabilities = Object.fromEntries(Object.entries(
          req.body?.capabilities && typeof req.body.capabilities === 'object' ? req.body.capabilities : {},
        ).filter(([key, value]) => USER_CAPABILITY_KEYS.has(key) && typeof value === 'boolean'));
        const settingsOverrides = req.body?.settingsOverrides && typeof req.body.settingsOverrides === 'object'
          && !Array.isArray(req.body.settingsOverrides)
          ? req.body.settingsOverrides
          : {};
        if (Buffer.byteLength(JSON.stringify(settingsOverrides)) > 256 * 1024) {
          return jsonError(res, 413, 'User settings override is too large');
        }
        const policy = await supabase.rest('user_policies', {
          method: 'POST',
          body: {
            user_id: profile.id,
            settings_pages: settingsPages,
            settings_permission_overrides: settingsPermissionOverrides,
            capabilities,
            settings_overrides: settingsOverrides,
          },
          prefer: 'resolution=merge-duplicates,return=representation', maybeSingle: true,
        });
        await revokeUserAppSessions(profile.id);
        await audit(req.principal, 'user.policy_updated', {
          targetType: 'user', targetId: profile.id,
          metadata: {
            settingsPermissionOverrides: Object.keys(settingsPermissionOverrides),
            capabilities: Object.keys(capabilities),
            changes: buildSafeFieldDeltas({
              settingsPermissionOverrides: previousPolicy?.settings_permission_overrides || {},
              capabilities: previousPolicy?.capabilities || {},
              settingsOverrides: previousPolicy?.settings_overrides || {},
            }, {
              settingsPermissionOverrides,
              capabilities,
              settingsOverrides,
            }),
            changedBy: req.principal.id === profile.id ? 'user' : 'administrator',
          },
        });
        revokeConnectionsAfterResponse(res, { userId: profile.id });
        return res.json({ policy });
      } catch (error) { return settingsPermissionWriteError(res, error); }
    });

    app.delete('/api/admin/users/:userId/policy', async (req, res) => {
      if (!canManageUsers(req.principal)) return jsonError(res, 403, 'User management edit access required');
      try {
        const previousPolicy = await readUserPolicy(req.params.userId);
        await supabase.rest('user_policies', {
          method: 'POST',
          body: buildUserPolicyResetRow(req.params.userId),
          prefer: 'resolution=merge-duplicates,return=minimal',
        });
        await revokeUserAppSessions(req.params.userId);
        await audit(req.principal, 'user.policy_reset', {
          targetType: 'user',
          targetId: req.params.userId,
          metadata: {
            changes: buildSafeFieldDeltas({
              settingsPermissionOverrides: previousPolicy?.settings_permission_overrides || {},
              capabilities: previousPolicy?.capabilities || {},
              settingsOverrides: previousPolicy?.settings_overrides || {},
            }, {
              settingsPermissionOverrides: {},
              capabilities: {},
              settingsOverrides: {},
            }),
            changedBy: req.principal.id === req.params.userId ? 'user' : 'administrator',
          },
        });
        revokeConnectionsAfterResponse(res, { userId: req.params.userId });
        return res.json({ reset: true });
      } catch (error) { return settingsPermissionWriteError(res, error); }
    });

    app.get('/api/admin/roles', async (req, res) => {
      if (!canReviewUsers(req.principal)) return jsonError(res, 403, 'User review access required');
      const roles = await supabase.rest('role_policies', { query: { order: 'role.asc' } }).catch(() => []);
      return res.json({ roles });
    });

    app.put('/api/admin/roles/:role', async (req, res) => {
      if (!canManageUsers(req.principal)) return jsonError(res, 403, 'User management edit access required');
      if (!validRole(req.params.role)) return jsonError(res, 400, 'Invalid role');
      try {
        const body = req.body || {};
        const permissionResult = req.params.role === 'admin'
          ? { valid: true, permissions: ROLE_POLICY_DEFAULTS.admin.settingsPermissions }
          : validateSettingsPermissionsPayload(
            body.settingsPermissions
              || settingsPermissionsFromLegacyPages(Array.isArray(body.settingsPages) ? body.settingsPages : []),
          );
        if (!permissionResult.valid) return jsonError(res, 400, permissionResult.error);
        const settingsPermissions = permissionResult.permissions;
        const settingsPages = req.params.role === 'admin'
          ? ['*']
          : ['home', ...Object.entries(settingsPermissions)
            .filter(([, permission]) => permission.read)
            .map(([slug]) => slug)];
        const row = {
          role: req.params.role,
          settings_pages: settingsPages,
          settings_permissions: settingsPermissions,
          can_use_files: req.params.role === 'admin' || body.files === true,
          can_use_terminal: req.params.role === 'admin' || body.terminal === true,
          can_manage_projects: req.params.role === 'admin' || body.manageProjects === true,
          can_manage_users: req.params.role === 'admin' || body.manageUsers === true,
          can_manage_global_settings: req.params.role === 'admin' || body.manageGlobalSettings === true,
          can_manage_git: req.params.role === 'admin' || body.manageGit === true,
          can_push: req.params.role === 'admin' || body.push === true,
          can_use_github: req.params.role === 'admin' || body.github !== false,
        };
        const role = await supabase.rest('role_policies', {
          method: 'POST', body: row, prefer: 'resolution=merge-duplicates,return=representation', maybeSingle: true,
        });
        principalCache.clear();
        const affectedUsers = await supabase.rest('user_profiles', {
          query: { role: `eq.${req.params.role}`, status: 'eq.active', select: 'id' },
        }).catch(() => []);
        await Promise.all((affectedUsers || []).map((user) => revokeUserAppSessions(user.id)));
        await audit(req.principal, 'role_policy.updated', { targetType: 'role', targetId: req.params.role });
        revokeConnectionsAfterResponse(res, (affectedUsers || []).map((user) => ({ userId: user.id })));
        return res.json({ role });
      } catch (error) { return settingsPermissionWriteError(res, error); }
    });

    app.get('/api/admin/projects', async (req, res) => {
      if (!canReviewUsers(req.principal)) return jsonError(res, 403, 'User review access required');
      const projects = await supabase.rest('managed_projects', { query: { order: 'created_at.asc' } }).catch(() => []);
      return res.json({ projects });
    });

    app.post('/api/admin/projects', async (req, res) => {
      if (!canManageUsers(req.principal)) return jsonError(res, 403, 'User management edit access required');
      try {
        const repositoryPath = path.resolve(String(req.body?.repositoryPath || ''));
        const stats = await fs.stat(repositoryPath);
        if (!stats.isDirectory()) return jsonError(res, 400, 'Repository path must be a directory');
        const discoveredRemote = typeof req.body?.remoteUrl === 'string' && req.body.remoteUrl.trim()
          ? req.body.remoteUrl.trim()
          : await getRemoteUrl(repositoryPath, 'origin');
        const project = await supabase.rest('managed_projects', {
          method: 'POST',
          body: {
            label: normalizeDisplayName(req.body?.label, path.basename(repositoryPath)),
            repository_path: repositoryPath,
            remote_url: normalizeGitHubRemoteUrl(discoveredRemote),
            default_branch: String(req.body?.defaultBranch || '').trim(),
            created_by: req.principal.id,
          },
          prefer: 'return=representation', maybeSingle: true,
        });
        await audit(req.principal, 'project.created', { targetType: 'project', targetId: project.id, projectId: project.id });
        return res.status(201).json({ project });
      } catch (error) { return jsonError(res, error?.status || 500, error.message); }
    });

    app.put('/api/admin/projects/:projectId', async (req, res) => {
      if (!canManageUsers(req.principal)) return jsonError(res, 403, 'User management edit access required');
      try {
        const patch = {};
        if (Object.prototype.hasOwnProperty.call(req.body || {}, 'label')) {
          const label = normalizeOptionalMetadata(req.body?.label);
          if (!label) return jsonError(res, 400, 'Project label is required');
          patch.label = label;
        }
        for (const [inputKey, column] of [
          ['icon', 'icon'],
          ['color', 'color'],
          ['iconBackground', 'icon_background'],
        ]) {
          if (!Object.prototype.hasOwnProperty.call(req.body || {}, inputKey)) continue;
          const value = normalizeOptionalMetadata(req.body?.[inputKey]);
          if (value === undefined) return jsonError(res, 400, `${inputKey} must be a string or null`);
          patch[column] = value;
        }
        if (Object.keys(patch).length === 0) return jsonError(res, 400, 'No project changes were provided');
        const project = await supabase.rest('managed_projects', {
          method: 'PATCH',
          query: { id: `eq.${escapeFilterValue(req.params.projectId)}`, status: 'eq.active' },
          body: patch,
          prefer: 'return=representation',
          maybeSingle: true,
        });
        if (!project) return jsonError(res, 404, 'Managed project not found');
        principalCache.clear();
        await audit(req.principal, 'project.updated', {
          targetType: 'project',
          targetId: project.id,
          projectId: project.id,
          metadata: { fields: Object.keys(patch) },
        });
        return res.json({ project });
      } catch (error) { return jsonError(res, error?.statusCode || error?.status || 500, error.message); }
    });

    app.get('/api/admin/projects/:projectId/branches', async (req, res) => {
      if (!canReviewUsers(req.principal)) return jsonError(res, 403, 'User review access required');
      try {
        const project = await supabase.rest('managed_projects', {
          query: { id: `eq.${escapeFilterValue(req.params.projectId)}`, status: 'eq.active', limit: 1 },
          maybeSingle: true,
        });
        if (!project) return jsonError(res, 404, 'Managed project not found');
        const branchOptions = buildBranchOptions(await getBranches(project.repository_path));
        return res.json({
          branches: branchOptions.map((option) => option.name),
          branchOptions,
          defaultBranch: normalizeLogicalBranchName(project.default_branch),
        });
      } catch (error) { return jsonError(res, error?.status || 500, error.message); }
    });

    app.post('/api/projects/:projectId/branch-target', async (req, res) => {
      const branchName = normalizeLogicalBranchName(req.body?.branchName);
      const idempotencyKey = String(req.body?.idempotencyKey || '').trim();
      if (!branchName || !idempotencyKey) {
        return res.status(400).json({ status: 'failure', message: 'Branch name and idempotency key are required' });
      }
      try {
        const principal = req.principal;
        const assignments = (principal.assignments || []).filter((entry) => entry.projectId === req.params.projectId);
        const assignment = assignments.find((entry) => normalizeLogicalBranchName(entry.branchName) === branchName);
        if (!assignment) {
          return res.status(403).json({ status: 'unavailable', branchName, message: 'Branch is not assigned to this account' });
        }
        const result = await ensureBranchTarget({
          repositoryPath: assignment.repositoryPath,
          branchName,
          idempotencyKey,
          ownerId: principal.id,
        });
        if (result.status === 'unavailable') return res.status(409).json(result);
        if (result.status === 'failure') return res.status(400).json(result);
        await audit(principal, 'branch_target.ensured', {
          targetType: 'project',
          targetId: assignment.projectId,
          projectId: assignment.projectId,
          metadata: { branchName, source: result.source, operationId: result.operationId || null },
        });
        return res.json(result);
      } catch (error) {
        return res.status(error?.statusCode || error?.status || 500).json({
          status: 'failure',
          branchName,
          message: error?.message || 'Failed to prepare branch target',
        });
      }
    });

    app.get('/api/admin/users/:userId/projects/:projectId', async (req, res) => {
      if (!canReviewUsers(req.principal)) return jsonError(res, 403, 'User review access required');
      try {
        const [access, branches] = await Promise.all([
          supabase.rest('user_project_access', {
            query: {
              user_id: `eq.${escapeFilterValue(req.params.userId)}`,
              project_id: `eq.${escapeFilterValue(req.params.projectId)}`,
              limit: 1,
            },
            maybeSingle: true,
          }),
          supabase.rest('user_project_branches', {
            query: {
              user_id: `eq.${escapeFilterValue(req.params.userId)}`,
              project_id: `eq.${escapeFilterValue(req.params.projectId)}`,
              order: 'created_at.asc',
            },
          }),
        ]);
        return res.json({ access, branches: branches || [] });
      } catch (error) { return jsonError(res, error?.status || 500, error.message); }
    });

    app.put('/api/admin/users/:userId/projects/:projectId', async (req, res) => {
      if (!canManageUsers(req.principal)) return jsonError(res, 403, 'User management edit access required');
      const branchName = normalizeLogicalBranchName(req.body?.branchName);
      if (!branchName) return jsonError(res, 400, 'Branch name is required');
      try {
        const assignment = await assignProject({
          userId: req.params.userId,
          projectId: req.params.projectId,
          branchName,
          isDefault: req.body?.isDefault !== false,
        });
        await supabase.rest('user_profiles', {
          method: 'PATCH', query: { id: `eq.${req.params.userId}`, status: 'neq.archived' },
          body: { status: 'active' }, prefer: 'return=minimal',
        });
        await Promise.all([abortOwnedSessions(req.params.userId), terminateOwnedTerminals(req.params.userId)]);
        await audit(req.principal, 'project.assigned', {
          targetType: 'user', targetId: req.params.userId, projectId: req.params.projectId,
          metadata: {
            branchName,
            changes: buildSafeFieldDeltas({ branches: [] }, { branches: [branchName], defaultBranch: branchName }),
            changedBy: req.principal.id === req.params.userId ? 'user' : 'administrator',
          },
        });
        revokeConnectionsAfterResponse(res, { userId: req.params.userId });
        return res.json({ assigned: true, projectId: assignment.project.id, branchName: assignment.branchName });
      } catch (error) { return jsonError(res, error?.statusCode || error?.status || 500, error.message); }
    });

    app.put('/api/admin/users/:userId/projects/:projectId/branches', async (req, res) => {
      if (!canManageUsers(req.principal)) return jsonError(res, 403, 'User management edit access required');
      const branches = [...new Set((Array.isArray(req.body?.branches) ? req.body.branches : [])
        .map(normalizeLogicalBranchName).filter(Boolean))];
      const defaultBranch = normalizeLogicalBranchName(req.body?.defaultBranch);
      if (branches.length === 0 || !branches.includes(defaultBranch)) {
        return jsonError(res, 400, 'At least one branch and a selected default branch are required');
      }
      let releaseMutation = () => {};
      try {
        const project = await supabase.rest('managed_projects', {
          query: { id: `eq.${escapeFilterValue(req.params.projectId)}`, status: 'eq.active', limit: 1 },
          maybeSingle: true,
        });
        if (!project) return jsonError(res, 404, 'Managed project not found');
        releaseMutation = await acquireMutationKey(`repository:${project.id}`);
        const existing = await supabase.rest('user_project_branches', {
          query: {
            user_id: `eq.${escapeFilterValue(req.params.userId)}`,
            project_id: `eq.${escapeFilterValue(req.params.projectId)}`,
          },
        });
        const orderedBranches = [...branches.filter((branch) => branch !== defaultBranch), defaultBranch];
        for (const branchName of orderedBranches) {
          await assignProject({
            userId: req.params.userId,
            projectId: req.params.projectId,
            branchName,
            isDefault: branchName === defaultBranch,
          });
        }
        await supabase.rest('user_profiles', {
          method: 'PATCH', query: { id: `eq.${req.params.userId}`, status: 'neq.archived' },
          body: { status: 'active' }, prefer: 'return=minimal',
        });
        const removedRows = (existing || []).filter((row) => !branches.includes(row.branch_name));
        await archiveAndDeleteBranchGrants({
          userId: req.params.userId,
          project,
          rows: removedRows,
        });
        principalCache.clear();
        await Promise.all([abortOwnedSessions(req.params.userId), terminateOwnedTerminals(req.params.userId)]);
        await audit(req.principal, 'project.branches_assigned', {
          targetType: 'user', targetId: req.params.userId, projectId: req.params.projectId,
          metadata: {
            branches,
            defaultBranch,
            removedBranches: removedRows.map((row) => row.branch_name),
            changes: buildSafeFieldDeltas({
              branches: (existing || []).map((row) => row.branch_name),
              defaultBranch: (existing || []).find((row) => row.is_default)?.branch_name || null,
            }, {
              branches,
              defaultBranch,
            }),
            changedBy: req.principal.id === req.params.userId ? 'user' : 'administrator',
          },
        });
        revokeConnectionsAfterResponse(res, { userId: req.params.userId });
        return res.json({ assigned: true, branches, defaultBranch });
      } catch (error) {
        return jsonError(res, error?.statusCode || error?.status || 500, error.message);
      } finally {
        releaseMutation();
      }
    });

    app.delete('/api/admin/users/:userId/projects/:projectId', async (req, res) => {
      if (!canManageUsers(req.principal)) return jsonError(res, 403, 'User management edit access required');
      let releaseMutation = () => {};
      try {
        const [project, access] = await Promise.all([
          supabase.rest('managed_projects', {
            query: { id: `eq.${escapeFilterValue(req.params.projectId)}`, limit: 1 }, maybeSingle: true,
          }),
          supabase.rest('user_project_access', {
            query: {
              user_id: `eq.${escapeFilterValue(req.params.userId)}`,
              project_id: `eq.${escapeFilterValue(req.params.projectId)}`,
              limit: 1,
            },
            maybeSingle: true,
          }),
        ]);
        if (!project || !access) return jsonError(res, 404, 'Project assignment not found');
        releaseMutation = await acquireMutationKey(`repository:${project.id}`);
        const removed = await archiveAndDeleteProjectAccess({ userId: req.params.userId, project });
        principalCache.clear();
        await Promise.all([abortOwnedSessions(req.params.userId), terminateOwnedTerminals(req.params.userId)]);
        await audit(req.principal, 'project.unassigned', {
          targetType: 'user',
          targetId: req.params.userId,
          projectId: project.id,
          metadata: {
            ...removed,
            changes: buildSafeFieldDeltas({ assigned: true }, { assigned: false }),
            changedBy: req.principal.id === req.params.userId ? 'user' : 'administrator',
          },
        });
        revokeConnectionsAfterResponse(res, { userId: req.params.userId });
        return res.json({ removed: true, projectId: project.id, ...removed });
      } catch (error) {
        return jsonError(res, error?.statusCode || error?.status || 500, error.message);
      } finally {
        releaseMutation();
      }
    });

    app.post('/api/admin/invites', async (req, res) => {
      if (!canManageUsers(req.principal)) return jsonError(res, 403, 'User management edit access required');
      const email = normalizeEmail(req.body?.email);
      if (!validEmail(email)) return jsonError(res, 400, 'A valid existing user email is required');
      const token = crypto.randomBytes(32).toString('base64url');
      const expiresAt = new Date(Date.now() + Math.min(7, Math.max(1, Number(req.body?.expiresInDays || 2))) * 86_400_000);
      try {
        const profile = await supabase.rest('user_profiles', {
          query: { email: `eq.${escapeFilterValue(email)}`, limit: 1 }, maybeSingle: true,
        });
        if (!profile || profile.role === 'admin' || profile.status === 'archived') {
          return jsonError(res, 400, 'Invitations can only target an existing non-admin user');
        }
        const canAssign = canManageUsers(req.principal);
        const invite = await supabase.rest('access_invites', {
          method: 'POST',
          body: {
            token_hash: sha256(token), email, display_name: req.body?.displayName || null,
            role: profile.role,
            project_id: canAssign ? req.body?.projectId || null : null,
            branch_name: canAssign ? req.body?.branchName || null : null,
            github_account_id: canAssign ? req.body?.githubAccountId || null : null,
            created_by: req.principal.id, expires_at: expiresAt.toISOString(),
          },
          prefer: 'return=representation', maybeSingle: true,
        });
        await audit(req.principal, 'invite.created', {
          targetType: 'invite',
          targetId: invite.id,
          targetUserId: profile.id,
          projectId: invite.project_id || null,
          metadata: {
            role: invite.role,
            branchName: invite.branch_name || null,
            changes: buildSafeFieldDeltas({ active: false }, { active: true, role: invite.role }),
            changedBy: req.principal.id === profile.id ? 'user' : 'administrator',
          },
        });
        return res.status(201).json({ invite: { ...invite, token, url: `/invite?t=${encodeURIComponent(token)}` } });
      } catch (error) { return jsonError(res, error?.status || 500, error.message); }
    });

    app.get('/api/admin/invites', async (req, res) => {
      if (!canReviewUsers(req.principal)) return jsonError(res, 403, 'User review access required');
      const invites = await supabase.rest('access_invites', {
        query: { order: 'created_at.desc', limit: 100 },
      }).catch(() => []);
      return res.json({
        invites: (invites || []).filter((invite) => invite.role !== 'admin'),
      });
    });

    app.delete('/api/admin/invites/:inviteId', async (req, res) => {
      if (!canManageUsers(req.principal)) return jsonError(res, 403, 'User management edit access required');
      try {
        const invite = await supabase.rest('access_invites', {
          query: { id: `eq.${escapeFilterValue(req.params.inviteId)}`, limit: 1 }, maybeSingle: true,
        });
        if (!invite || invite.role === 'admin') return jsonError(res, 404, 'Invitation not found');
        await supabase.rest('access_invites', {
          method: 'PATCH', query: { id: `eq.${invite.id}` },
          body: { revoked_at: new Date().toISOString() }, prefer: 'return=minimal',
        });
        const targetProfile = await supabase.rest('user_profiles', {
          query: { email: `eq.${escapeFilterValue(invite.email)}`, select: 'id', limit: 1 },
          maybeSingle: true,
        }).catch(() => null);
        await audit(req.principal, 'invite.revoked', {
          targetType: 'invite',
          targetId: invite.id,
          targetUserId: targetProfile?.id || null,
          projectId: invite.project_id || null,
          metadata: {
            changes: buildSafeFieldDeltas({ active: true }, { active: false }),
            changedBy: targetProfile?.id === req.principal.id ? 'user' : 'administrator',
          },
        });
        return res.json({ revoked: true });
      } catch (error) { return jsonError(res, error?.status || 500, error.message); }
    });

    app.get('/api/admin/users/:userId/analytics/daily', async (req, res) => {
      if (!requireAnalyticsAdmin(req.principal)) return jsonError(res, 403, 'Administrator access required');
      const range = validateAnalyticsDay(req.query?.date, req.query?.timeZone);
      if (!range) return jsonError(res, 400, 'A valid date and IANA time zone are required');
      try {
        const target = await loadAnalyticsTarget(req.params.userId);
        if (!target) return jsonError(res, 404, 'User not found');
        const rows = await loadActivityPages({
          or: `(actor_user_id.eq.${escapeFilterValue(target.id)},target_user_id.eq.${escapeFilterValue(target.id)})`,
          created_at: `gte.${range.start.toUTC().toISO()}`,
          and: `(created_at.lt.${range.end.toUTC().toISO()})`,
          order: 'created_at.asc,id.asc',
        });
        return res.json({
          user: { id: target.id, displayName: target.display_name },
          ...aggregateDailyAnalytics({
            rows,
            userId: target.id,
            date: req.query.date,
            timeZone: req.query.timeZone,
          }),
        });
      } catch (error) {
        return jsonError(res, error?.statusCode || error?.status || 500, error.message);
      }
    });

    app.get('/api/admin/users/:userId/analytics/range', async (req, res) => {
      if (!requireAnalyticsAdmin(req.principal)) return jsonError(res, 403, 'Administrator access required');
      const range = validateAnalyticsRange(req.query?.start, req.query?.end, req.query?.timeZone);
      if (!range) return jsonError(res, 400, 'A valid start date, end date, and IANA time zone are required');
      try {
        const target = await loadAnalyticsTarget(req.params.userId);
        if (!target) return jsonError(res, 404, 'User not found');
        const rows = await loadActivityPages({
          or: `(actor_user_id.eq.${escapeFilterValue(target.id)},target_user_id.eq.${escapeFilterValue(target.id)})`,
          created_at: `gte.${range.start.toUTC().toISO()}`,
          and: `(created_at.lt.${range.end.toUTC().toISO()})`,
          order: 'created_at.asc,id.asc',
        });
        return res.json({
          user: { id: target.id, displayName: target.display_name },
          ...aggregateRangeAnalytics({
            rows,
            userId: target.id,
            start: req.query.start,
            end: req.query.end,
            timeZone: req.query.timeZone,
          }),
        });
      } catch (error) {
        return jsonError(res, error?.statusCode || error?.status || 500, error.message);
      }
    });

    app.get('/api/admin/users/:userId/analytics/events', async (req, res) => {
      if (!requireAnalyticsAdmin(req.principal)) return jsonError(res, 403, 'Administrator access required');
      const range = validateAnalyticsRange(req.query?.start, req.query?.end, req.query?.timeZone);
      if (!range) return jsonError(res, 400, 'A valid start date, end date, and IANA time zone are required');
      const requestedLimit = Number(req.query?.limit || ANALYTICS_PAGE_LIMIT);
      const limit = Number.isFinite(requestedLimit)
        ? Math.min(100, Math.max(1, Math.trunc(requestedLimit)))
        : ANALYTICS_PAGE_LIMIT;
      const cursor = decodeAnalyticsCursor(req.query?.cursor);
      if (req.query?.cursor && !cursor) return jsonError(res, 400, 'Invalid analytics cursor');
      const category = String(req.query?.category || 'all');
      if (!['all', 'prompts', 'interactions', 'changes'].includes(category)) {
        return jsonError(res, 400, 'Invalid analytics category');
      }
      try {
        const target = await loadAnalyticsTarget(req.params.userId);
        if (!target) return jsonError(res, 404, 'User not found');
        let rows = await loadActivityPages({
          or: `(actor_user_id.eq.${escapeFilterValue(target.id)},target_user_id.eq.${escapeFilterValue(target.id)})`,
          created_at: `gte.${range.start.toUTC().toISO()}`,
          and: `(created_at.lt.${range.end.toUTC().toISO()})`,
          order: 'created_at.desc,id.desc',
        });
        rows = rows.filter((row) => {
          if (category === 'prompts') return row.action === ANALYTICS_ACTIONS.promptSent;
          if (category === 'interactions') {
            return row.action === ANALYTICS_ACTIONS.fileOpened || row.action === ANALYTICS_ACTIONS.clipboardCopied;
          }
          if (category === 'changes') return isSettingsChangeAction(row.action);
          return !String(row.action || '').startsWith('tool.') && !String(row.action || '').startsWith('assistant.');
        });
        const agent = String(req.query?.agent || '').trim().toLowerCase();
        const model = String(req.query?.model || '').trim().toLowerCase();
        const search = String(req.query?.search || '').trim().toLowerCase().slice(0, 500);
        if (agent) rows = rows.filter((row) => String(row.metadata?.agent || '').toLowerCase() === agent);
        if (model) rows = rows.filter((row) => {
          const modelText = `${row.metadata?.providerId || ''}/${row.metadata?.modelId || ''}`.toLowerCase();
          return modelText.includes(model);
        });
        if (search) rows = rows.filter((row) => [
          row.action,
          row.metadata?.promptText,
          row.metadata?.agent,
          row.metadata?.providerId,
          row.metadata?.modelId,
          row.metadata?.projectName,
          row.metadata?.branchName,
          row.metadata?.filePath,
        ].some((value) => String(value || '').toLowerCase().includes(search)));
        rows.sort((left, right) => {
          const timeDifference = Date.parse(right.created_at) - Date.parse(left.created_at);
          if (timeDifference !== 0) return timeDifference;
          return BigInt(right.id) > BigInt(left.id) ? 1 : -1;
        });
        const remaining = rows.filter((row) => analyticsRowBeforeCursor(row, cursor));
        const page = remaining.slice(0, limit);
        const events = await attachActivityActors(page);
        return res.json({
          events,
          nextCursor: remaining.length > limit ? encodeAnalyticsCursor(page.at(-1)) : null,
        });
      } catch (error) {
        return jsonError(res, error?.statusCode || error?.status || 500, error.message);
      }
    });

    app.get('/api/admin/activity', async (req, res) => {
      if (!canReviewUsers(req.principal)) return jsonError(res, 403, 'User review access required');
      const limit = Math.min(250, Math.max(1, Number(req.query?.limit || 100)));
      const activity = await supabase.rest('activity_logs', { query: { order: 'created_at.desc', limit } }).catch(() => []);
      if (req.principal.role === 'admin') return res.json({ activity });
      const nonAdminUsers = await supabase.rest('user_profiles', {
        query: { role: 'neq.admin', select: 'id' },
      }).catch(() => []);
      const visibleUserIds = new Set((nonAdminUsers || []).map((user) => user.id));
      return res.json({
        activity: sanitizeActivityForReviewer((activity || []).filter((row) => (
          (row.actor_user_id && visibleUserIds.has(row.actor_user_id))
          || (row.target_type === 'user' && visibleUserIds.has(row.target_id))
        )), { isAdmin: false }),
      });
    });

    app.get('/api/admin/activity/status', async (req, res) => {
      if (!canReviewUsers(req.principal)) return jsonError(res, 403, 'User review access required');
      return res.json(await auditOutbox.getStatus());
    });

    app.get('/api/admin/activity/export', async (req, res) => {
      if (!canReviewUsers(req.principal)) return jsonError(res, 403, 'User review access required');
      try {
        let activity = await loadActivityPages({ order: 'created_at.asc,id.asc' });
        if (req.principal.role !== 'admin') {
          const nonAdminUsers = await supabase.rest('user_profiles', {
            query: { role: 'neq.admin', select: 'id' },
          }).catch(() => []);
          const visibleUserIds = new Set((nonAdminUsers || []).map((user) => user.id));
          activity = sanitizeActivityForReviewer(activity.filter((row) => (
            (row.actor_user_id && visibleUserIds.has(row.actor_user_id))
            || (row.target_type === 'user' && visibleUserIds.has(row.target_id))
          )), { isAdmin: false });
        }
        await audit(req.principal, 'activity.exported', { metadata: { count: activity.length } });
        res.setHeader('Content-Disposition', `attachment; filename="DevRyan-activity-${new Date().toISOString().slice(0, 10)}.json"`);
        return res.json({ exportedAt: new Date().toISOString(), activity });
      } catch (error) { return jsonError(res, error?.status || 500, error.message); }
    });

    app.delete('/api/admin/activity', async (req, res) => {
      if (!canManageUsers(req.principal)) return jsonError(res, 403, 'User management edit access required');
      if (req.body?.confirm !== true) return jsonError(res, 400, 'Audit purge confirmation is required');
      try {
        const purgeEventId = await audit(req.principal, 'activity.purged');
        await supabase.rest('activity_logs', {
          method: 'DELETE', query: { event_id: `neq.${purgeEventId}` }, prefer: 'return=minimal',
        });
        return res.json({ purged: true });
      } catch (error) { return jsonError(res, error?.status || 500, error.message); }
    });

    if (typeof readSettingsFromDiskMigrated === 'function') {
      app.get('/api/config/settings', async (req, res, next) => {
        if (req.principal?.scope !== 'managed') return next();
        try {
          const hostSettings = await readSettingsFromDiskMigrated();
          return res.json(buildEffectiveSettings({
            principal: req.principal,
            hostSettings,
            userOverrides: req.principal.settingsOverrides,
          }));
        } catch (error) { return jsonError(res, 500, error.message); }
      });

      app.put('/api/config/settings', async (req, res, next) => {
        if (req.principal?.scope !== 'managed') return next();
        if (req.principal.role === 'admin') return next();
        try {
          const hostSettings = await readSettingsFromDiskMigrated();
          const currentEffective = buildEffectiveSettings({
            principal: req.principal, hostSettings, userOverrides: req.principal.settingsOverrides,
          });
          const { accepted, rejected } = validateSettingsChanges({
            principal: req.principal, changes: req.body || {}, currentEffective,
          });
          if (rejected.length > 0) return jsonError(res, 403, 'One or more settings are managed by an administrator', { fields: rejected });
          const settingsOverrides = { ...req.principal.settingsOverrides, ...accepted };
          await supabase.rest('user_policies', {
            method: 'POST',
            body: { user_id: req.principal.id, settings_overrides: settingsOverrides },
            prefer: 'resolution=merge-duplicates,return=minimal',
          });
          req.principal.settingsOverrides = settingsOverrides;
          principalCache.clear();
          const previousSettings = Object.fromEntries(Object.keys(accepted).map((field) => [field, currentEffective[field]]));
          const nextSettings = Object.fromEntries(Object.keys(accepted).map((field) => [field, accepted[field]]));
          await audit(req.principal, 'settings.updated', {
            targetType: 'user',
            targetId: req.principal.id,
            metadata: {
              fields: Object.keys(accepted),
              changes: buildSafeFieldDeltas(previousSettings, nextSettings),
              changedBy: 'user',
            },
          });
          return res.json(buildEffectiveSettings({ principal: req.principal, hostSettings, userOverrides: settingsOverrides }));
        } catch (error) { return jsonError(res, error?.statusCode || 500, error.message); }
      });
    }

    app.post('/api/opencode/directory', async (req, res, next) => {
      if (req.principal?.scope !== 'managed') return next();
      const assignment = resolveAssignmentForValue(req.principal, req.body?.path);
      if (!assignment) return jsonError(res, 403, 'Project is not assigned');
      await supabase.rest('app_sessions', {
        method: 'PATCH', query: { id: `eq.${req.principal.appSessionId}` },
        body: { active_project_id: assignment.projectId, active_branch: assignment.branchName }, prefer: 'return=minimal',
      });
      principalCache.clear();
      return res.json({ success: true, restarted: false, path: assignment.publicDirectory });
    });

    if (typeof buildOpenCodeUrl === 'function' && typeof getOpenCodeAuthHeaders === 'function') {
      app.get('/api/session', async (req, res, next) => {
        if (req.principal?.scope !== 'managed') return next();
        try {
          const { response, payload } = await fetchUpstreamJson({ req, buildOpenCodeUrl, getOpenCodeAuthHeaders, pathname: '/session' });
          if (!response.ok) return res.status(response.status).send(typeof payload === 'string' ? payload : JSON.stringify(payload));
          const sessions = Array.isArray(payload) ? payload : [];
          const visible = [];
          for (const session of sessions) {
            if (session?.id && await ownsSession(req.principal, session.id)) visible.push(session);
          }
          return res.json(visible);
        } catch (error) { return jsonError(res, 502, error.message); }
      });

      app.post('/api/session', async (req, res, next) => {
        if (req.principal?.scope !== 'managed') return next();
        try {
          const { response, payload } = await fetchUpstreamJson({ req, buildOpenCodeUrl, getOpenCodeAuthHeaders, pathname: '/session', method: 'POST' });
          if (!response.ok) return res.status(response.status).send(typeof payload === 'string' ? payload : JSON.stringify(payload));
          try {
            await recordSessionOwnership(req.principal, payload);
          } catch (error) {
            if (typeof payload?.id === 'string') {
              await fetchUpstreamJson({
                req, buildOpenCodeUrl, getOpenCodeAuthHeaders,
                pathname: `/session/${encodeURIComponent(payload.id)}`, method: 'DELETE', body: undefined,
              }).catch(() => {});
            }
            throw error;
          }
          return res.status(response.status).json(payload);
        } catch (error) { return jsonError(res, 502, error.message); }
      });

      app.get('/api/session/status', async (req, res, next) => {
        if (req.principal?.scope !== 'managed') return next();
        try {
          const { response, payload } = await fetchUpstreamJson({ req, buildOpenCodeUrl, getOpenCodeAuthHeaders, pathname: '/session/status' });
          if (!response.ok) return res.status(response.status).send(typeof payload === 'string' ? payload : JSON.stringify(payload));
          const visible = {};
          for (const [sessionId, status] of Object.entries(payload || {})) {
            if (await ownsSession(req.principal, sessionId)) visible[sessionId] = status;
          }
          return res.json(visible);
        } catch (error) { return jsonError(res, 502, error.message); }
      });

      app.post('/api/session/:sessionID/fork', async (req, res, next) => {
        if (req.principal?.scope !== 'managed') return next();
        try {
          if (!await ownsSession(req.principal, req.params.sessionID)) return jsonError(res, 404, 'Session not found');
          const { response, payload } = await fetchUpstreamJson({
            req,
            buildOpenCodeUrl,
            getOpenCodeAuthHeaders,
            pathname: `/session/${encodeURIComponent(req.params.sessionID)}/fork`,
            method: 'POST',
          });
          if (!response.ok) return res.status(response.status).send(typeof payload === 'string' ? payload : JSON.stringify(payload));
          try {
            if (!await recordChildSessionOwnership(req.principal, payload, req.params.sessionID)) {
              throw new Error('Fork ownership could not be registered');
            }
          } catch (error) {
            if (typeof payload?.id === 'string') {
              await fetchUpstreamJson({
                req, buildOpenCodeUrl, getOpenCodeAuthHeaders,
                pathname: `/session/${encodeURIComponent(payload.id)}`, method: 'DELETE', body: undefined,
              }).catch(() => {});
            }
            throw error;
          }
          return res.status(response.status).json(payload);
        } catch (error) { return jsonError(res, 502, error.message); }
      });

      app.delete('/api/session/:sessionID', async (req, res, next) => {
        if (req.principal?.scope !== 'managed') return next();
        let upstreamDeleted = false;
        let ownershipTombstoned = false;
        let auditRegistered = false;
        const registerDeleteAudit = () => {
          if (auditRegistered) return;
          auditRegistered = true;
          let recorded = false;
          const recordOutcome = () => {
            if (recorded) return;
            recorded = true;
            void audit(req.principal, 'session.deleted', {
              targetType: 'session',
              targetId: req.params.sessionID,
              sessionId: req.params.sessionID,
              success: res.statusCode < 400 && upstreamDeleted && ownershipTombstoned,
              metadata: { statusCode: res.statusCode, upstreamDeleted, ownershipTombstoned },
            }).catch((error) => logger.error?.('[MultiUser] Failed to persist session delete audit:', error));
          };
          res.once('finish', recordOutcome);
          res.once('close', recordOutcome);
        };
        try {
          if (!await ensureOwnedSession(req.principal, req.params.sessionID)) return jsonError(res, 404, 'Session not found');
          registerDeleteAudit();
          const owner = await sessionOwnership(req.params.sessionID);
          const { response, payload } = await fetchUpstreamJson({
            req,
            buildOpenCodeUrl,
            getOpenCodeAuthHeaders,
            pathname: `/session/${encodeURIComponent(req.params.sessionID)}`,
            method: 'DELETE',
            body: undefined,
          });
          if (!response.ok) return res.status(response.status).send(typeof payload === 'string' ? payload : JSON.stringify(payload));
          upstreamDeleted = true;
          const archivedAt = new Date().toISOString();
          await supabase.rest('opencode_session_ownership', {
            method: 'PATCH', query: { session_id: `eq.${req.params.sessionID}` },
            body: { archived_at: archivedAt }, prefer: 'return=minimal',
          });
          await ownershipIndex.set({ ...owner, archived_at: archivedAt });
          ownershipTombstoned = true;
          return res.status(response.status).json(payload);
        } catch (error) { return jsonError(res, 502, error.message); }
      });

      app.use('/api/session/:sessionID', async (req, res, next) => {
        if (req.principal?.scope !== 'managed' || req.params.sessionID === 'status') return next();
        if (res.locals.multiUserSessionAuthorized === true) return next();
        try {
          if (!await ownsSession(req.principal, req.params.sessionID)) return jsonError(res, 404, 'Session not found');
          return next();
        } catch { return jsonError(res, 404, 'Session not found'); }
      });

      app.use('/api/openchamber/session/:sessionID', async (req, res, next) => {
        if (req.principal?.scope !== 'managed') return next();
        const sessionId = req.params.sessionID;
        try {
          if (!await ownsSession(req.principal, sessionId)) return jsonError(res, 404, 'Session not found');
          if (!STATE_CHANGING_METHODS.has(req.method)) return next();
          const requestedEventId = await audit(req.principal, 'session.scoped_revert.requested', {
            targetType: 'session', targetId: sessionId, sessionId,
          });
          let outcomeRecorded = false;
          const recordOutcome = () => {
            if (outcomeRecorded) return;
            outcomeRecorded = true;
            void audit(req.principal, 'session.scoped_revert.completed', {
              targetType: 'session',
              targetId: sessionId,
              sessionId,
              success: res.statusCode < 400,
              metadata: { statusCode: res.statusCode, requestedEventId },
            }).catch((error) => logger.error?.('[MultiUser] Failed to persist scoped revert audit:', error));
          };
          res.once('finish', recordOutcome);
          res.once('close', recordOutcome);
          return next();
        } catch (error) {
          return jsonError(res, error?.statusCode || 404, error?.statusCode ? error.message : 'Session not found');
        }
      });
    }
  };

  return {
    enabled: true,
    config,
    authController,
    wrapLegacyAuthController,
    registerRoutes,
    resolvePrincipal,
    filterEventForPrincipal,
    recordOpenCodeActivity,
    registerConnection,
    getPublicPrincipal: publicPrincipal,
    translateDirectoryValue,
    publicizeValue,
    ownsSession,
    canSessionTokenHashAccess,
    audit,
    resolveManagedProject,
    resolveScheduledTaskExecution,
    recordScheduledTaskSessionOwnership,
    setTerminalOwnerTerminator(callback) {
      terminateOwnedTerminals = typeof callback === 'function' ? callback : async () => {};
    },
    attachLoopbackPasskeyController(controller) {
      loopbackPasskeyController = controller?.enabled ? controller : null;
    },
    createManagedUser,
    assignProject,
  };
}
