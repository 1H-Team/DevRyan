import { normalizeProxyTargetUrl } from './proxy-runtime.js';

export const PROJECT_PREVIEW_GRANT_TTL_MS = 2 * 60 * 1000;
export const PROJECT_PREVIEW_GRANT_SWEEP_MS = 15 * 1000;
export const PROJECT_PREVIEW_MAX_LABEL_LENGTH = 120;

const normalizeDirectoryInput = (value) => (
  typeof value === 'string' ? value.trim() : ''
);

const isContained = (path, root, candidate) => {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

const assignmentForDirectory = (path, principal, directory) => (
  (principal?.assignments || []).find((assignment) => (
    (typeof assignment.repositoryPath === 'string'
      && isContained(path, assignment.repositoryPath, directory))
    || (typeof assignment.worktreeContainerPath === 'string'
      && assignment.worktreeContainerPath
      && isContained(path, assignment.worktreeContainerPath, directory))
  )) || null
);

export const normalizeProjectPreviewUrl = (rawUrl) => {
  const input = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (!input || input.length > 2048) {
    return { ok: false, error: 'A valid preview URL is required' };
  }

  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    return { ok: false, error: 'Invalid URL' };
  }

  if (parsed.username || parsed.password) {
    return { ok: false, error: 'Preview URLs cannot include credentials' };
  }

  const normalized = normalizeProxyTargetUrl(parsed.toString(), { allowExternal: false });
  if (!normalized.ok) return normalized;

  const displayUrl = new URL(`${parsed.pathname}${parsed.search}${parsed.hash}`, normalized.origin).toString();
  return {
    ok: true,
    origin: normalized.origin,
    url: displayUrl,
    port: new URL(normalized.origin).port || (parsed.protocol === 'https:' ? '443' : '80'),
  };
};

export const createProjectPreviewInstancesRuntime = ({
  crypto,
  fs,
  path,
  probeUrl,
  getTerminalRuntime,
  now = () => Date.now(),
  grantTtlMs = PROJECT_PREVIEW_GRANT_TTL_MS,
  sweepIntervalMs = PROJECT_PREVIEW_GRANT_SWEEP_MS,
} = {}) => {
  const grants = new Map();
  let onGrantRemoved = null;

  const canonicalizeDirectory = async (rawDirectory) => {
    const input = normalizeDirectoryInput(rawDirectory);
    if (!input || !path.isAbsolute(input)) return null;
    try {
      const canonical = await fs.promises.realpath(input);
      const stats = await fs.promises.stat(canonical);
      return stats.isDirectory() ? canonical : null;
    } catch {
      return null;
    }
  };

  const resolveProject = (principal, directory) => {
    if (principal?.scope === 'managed') {
      const assignment = assignmentForDirectory(path, principal, directory);
      if (assignment?.projectId) {
        return { key: `project:${assignment.projectId}`, projectId: assignment.projectId };
      }
      if (principal.role !== 'admin') return null;
    }
    return { key: `directory:${directory}`, projectId: null };
  };

  const removeGrant = (grantId, reason) => {
    const grant = grants.get(grantId);
    if (!grant) return false;
    grants.delete(grantId);
    try {
      onGrantRemoved?.({ ...grant, reason });
    } catch {
      // Grant removal is authoritative even if target cleanup is best-effort.
    }
    return true;
  };

  const removeExpired = () => {
    const currentTime = now();
    for (const [grantId, grant] of grants) {
      if (grant.expiresAt <= currentTime) removeGrant(grantId, 'expired');
    }
  };

  const isReachable = async (url) => {
    try {
      const result = await probeUrl(url);
      return result === true || result?.status === 'reachable';
    } catch {
      return false;
    }
  };

  const register = async ({ principal, directory, terminalSessionId, url, label }) => {
    const canonicalDirectory = await canonicalizeDirectory(directory);
    if (!canonicalDirectory) {
      return { ok: false, status: 400, error: 'Invalid project directory' };
    }

    const project = resolveProject(principal, canonicalDirectory);
    if (!project) {
      return { ok: false, status: 403, error: 'Directory is outside your assigned workspace' };
    }

    const sessionId = typeof terminalSessionId === 'string' ? terminalSessionId.trim() : '';
    const session = getTerminalRuntime?.()?.getSessionDescriptor?.(sessionId);
    if (!session || session.ownerUserId !== (principal?.id || 'local-admin')) {
      return { ok: false, status: 404, error: 'Terminal session not found' };
    }

    const terminalDirectory = await canonicalizeDirectory(session.cwd);
    if (!terminalDirectory || terminalDirectory !== canonicalDirectory) {
      return { ok: false, status: 403, error: 'Terminal session does not match the project directory' };
    }

    const normalizedUrl = normalizeProjectPreviewUrl(url);
    if (!normalizedUrl.ok) {
      return { ok: false, status: 400, error: normalizedUrl.error };
    }

    const matchingGrant = [...grants.values()].find((grant) => (
      grant.projectKey === project.key
      && grant.terminalSessionId === sessionId
      && grant.origin === normalizedUrl.origin
    ));

    if (!await isReachable(normalizedUrl.url)) {
      if (matchingGrant) removeGrant(matchingGrant.id, 'liveness-failed');
      return { ok: false, status: 422, error: 'Preview app is not reachable' };
    }

    const currentTime = now();
    const normalizedLabel = typeof label === 'string'
      ? label.trim().slice(0, PROJECT_PREVIEW_MAX_LABEL_LENGTH)
      : '';
    const grant = matchingGrant || {
      id: crypto.randomBytes(16).toString('hex'),
      createdAt: currentTime,
    };
    Object.assign(grant, {
      projectKey: project.key,
      projectId: project.projectId,
      directory: canonicalDirectory,
      terminalSessionId: sessionId,
      ownerUserId: principal?.id || 'local-admin',
      origin: normalizedUrl.origin,
      url: normalizedUrl.url,
      port: normalizedUrl.port,
      label: normalizedLabel,
      updatedAt: currentTime,
      expiresAt: currentTime + Math.max(15_000, Math.trunc(grantTtlMs)),
    });
    grants.set(grant.id, grant);
    return { ok: true, grant };
  };

  const liveGrantsForProject = async (projectKey) => {
    removeExpired();
    const candidates = [...grants.values()].filter((grant) => grant.projectKey === projectKey);
    const checks = await Promise.all(candidates.map(async (grant) => ({
      grant,
      reachable: await isReachable(grant.url),
    })));
    for (const check of checks) {
      if (!check.reachable) removeGrant(check.grant.id, 'liveness-failed');
    }
    return checks.filter((check) => check.reachable).map((check) => check.grant);
  };

  const list = async ({ principal, directory }) => {
    const canonicalDirectory = await canonicalizeDirectory(directory);
    if (!canonicalDirectory) {
      return { ok: false, status: 400, error: 'Invalid project directory' };
    }
    const project = resolveProject(principal, canonicalDirectory);
    if (!project) {
      return { ok: false, status: 403, error: 'Directory is outside your assigned workspace' };
    }

    const live = await liveGrantsForProject(project.key);
    const latestByOrigin = new Map();
    for (const grant of live) {
      const previous = latestByOrigin.get(grant.origin);
      if (!previous || previous.updatedAt < grant.updatedAt) latestByOrigin.set(grant.origin, grant);
    }
    return {
      ok: true,
      instances: [...latestByOrigin.values()].map((grant) => ({
        id: grant.id,
        label: grant.label || null,
        url: grant.url,
        origin: grant.origin,
        port: grant.port,
        expiresAt: grant.expiresAt,
      })),
    };
  };

  const authorizeTarget = async ({ principal, directory, url }) => {
    const canonicalDirectory = await canonicalizeDirectory(directory);
    if (!canonicalDirectory) {
      return { ok: false, status: 400, error: 'directory is required for remote preview access' };
    }
    const project = resolveProject(principal, canonicalDirectory);
    if (!project) {
      return { ok: false, status: 403, error: 'Directory is outside your assigned workspace' };
    }
    const normalizedUrl = normalizeProjectPreviewUrl(url);
    if (!normalizedUrl.ok) {
      return { ok: false, status: 400, error: normalizedUrl.error };
    }

    const live = await liveGrantsForProject(project.key);
    const grant = live.find((candidate) => candidate.origin === normalizedUrl.origin);
    if (!grant) {
      return { ok: false, status: 403, error: 'This project preview port has not been approved' };
    }
    return {
      ok: true,
      origin: normalizedUrl.origin,
      grantId: grant.id,
      projectKey: project.key,
    };
  };

  const handleTerminalSessionClosed = ({ sessionId }) => {
    for (const [grantId, grant] of grants) {
      if (grant.terminalSessionId === sessionId) removeGrant(grantId, 'terminal-closed');
    }
  };

  const revokeOwner = (ownerUserId) => {
    for (const [grantId, grant] of grants) {
      if (grant.ownerUserId === ownerUserId) removeGrant(grantId, 'owner-revoked');
    }
  };

  const attach = (app, { express, uiAuthController, isRequestOriginAllowed }) => {
    const requireRequestAccess = async (req, res, { requireOrigin = false } = {}) => {
      if (uiAuthController?.enabled) {
        const token = await uiAuthController.ensureSessionToken?.(req, res);
        if (!token) {
          res.status(401).json({ error: 'UI authentication required' });
          return false;
        }
      }
      if (requireOrigin && !await isRequestOriginAllowed(req)) {
        res.status(403).json({ error: 'Invalid origin' });
        return false;
      }
      return true;
    };

    app.post('/api/preview/instances/register', express.json({ limit: '16kb' }), async (req, res) => {
      try {
        if (!await requireRequestAccess(req, res, { requireOrigin: true })) return;
        const csrf = typeof req.get === 'function'
          ? req.get('x-devryan-csrf')
          : req.headers?.['x-devryan-csrf'];
        if (csrf !== '1') return res.status(403).json({ error: 'Missing CSRF request header' });

        const result = await register({
          principal: req.principal,
          directory: req.body?.directory,
          terminalSessionId: req.body?.terminalSessionId,
          url: req.body?.url,
          label: req.body?.label,
        });
        if (!result.ok) return res.status(result.status).json({ error: result.error });
        return res.json({
          instance: {
            id: result.grant.id,
            label: result.grant.label || null,
            url: result.grant.url,
            origin: result.grant.origin,
            port: result.grant.port,
            expiresAt: result.grant.expiresAt,
          },
        });
      } catch (error) {
        console.error('[preview-instances] Failed to register preview app:', error);
        return res.status(500).json({ error: 'Failed to register preview app' });
      }
    });

    app.get('/api/preview/instances', async (req, res) => {
      try {
        if (!await requireRequestAccess(req, res)) return;
        const result = await list({ principal: req.principal, directory: req.query?.directory });
        if (!result.ok) return res.status(result.status).json({ error: result.error });
        return res.json({ instances: result.instances });
      } catch (error) {
        console.error('[preview-instances] Failed to list preview apps:', error);
        return res.status(500).json({ error: 'Failed to list preview apps' });
      }
    });
  };

  const sweepTimer = setInterval(removeExpired, sweepIntervalMs);
  sweepTimer.unref?.();

  const shutdown = () => {
    clearInterval(sweepTimer);
    for (const grantId of [...grants.keys()]) removeGrant(grantId, 'shutdown');
  };

  return {
    attach,
    register,
    list,
    authorizeTarget,
    handleTerminalSessionClosed,
    revokeOwner,
    setGrantRemovalHandler(handler) {
      onGrantRemoved = typeof handler === 'function' ? handler : null;
    },
    getSnapshot: () => [...grants.values()].map((grant) => ({ ...grant })),
    shutdown,
  };
};
