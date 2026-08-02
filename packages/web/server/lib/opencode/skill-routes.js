import {
  filterVisibleSkills,
  isRetiredDevRyanSkillName,
  normalizeSkillPath,
} from './skill-policy.js';
import { isAllowedSkillSource } from './shared.js';
import {
  createHarnessError,
  createHarnessSuccess,
  createHarnessWarning,
  withHarnessResult,
} from './harness-result.js';

export const registerSkillRoutes = (app, dependencies) => {
  const {
    fs,
    path,
    os,
    resolveProjectDirectory,
    resolveOptionalProjectDirectory,
    readSettingsFromDisk,
    persistSettings,
    sanitizeSkillCatalogs,
    sanitizeHiddenSkills,
    isUnsafeSkillRelativePath,
    refreshOpenCodeAfterConfigChange,
    isExternalOpenCode = () => false,
    clientReloadDelayMs,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    getOpenCodePort,
    getSkillSources,
    discoverSkills,
    createSkill,
    updateSkill,
    deleteSkill,
    readSkillSupportingFile,
    writeSkillSupportingFile,
    deleteSkillSupportingFile,
    SKILL_SCOPE,
    SKILL_DIR,
    getCuratedSkillsSources,
    getCacheKey,
    getCachedScan,
    setCachedScan,
    parseSkillRepoSource,
    scanSkillsRepository,
    installSkillsFromRepository,
    scanClawdHubPage,
    installSkillsFromClawdHub,
    isClawdHubSource,
    getProfiles,
    getProfile,
  } = dependencies;

  const getHiddenSkillsFromSettings = (settings) => {
    if (typeof sanitizeHiddenSkills === 'function') {
      return sanitizeHiddenSkills(settings?.hiddenSkills) || [];
    }
    return Array.isArray(settings?.hiddenSkills) ? settings.hiddenSkills : [];
  };

  const sendHarness = (res, payload, harness, statusCode = null) => {
    if (statusCode) {
      return res.status(statusCode).json(withHarnessResult(payload, harness));
    }
    return res.json(withHarnessResult(payload, harness));
  };
  const formatErrorMessage = (error, fallback) => (
    error instanceof Error && error.message ? error.message : fallback
  );
  const sendSkillHarnessError = (res, payload, {
    statusCode = 400,
    summary,
    nextActions = [],
    rootCauseHint,
    safeRetry,
    stopCondition,
    retryable = true,
  }) => sendHarness(res, payload, createHarnessError({
    summary,
    nextActions,
    recovery: {
      rootCauseHint,
      safeRetry,
      stopCondition,
      retryable,
    },
  }), statusCode);

  const buildHiddenSkillsResponse = (discoveredSkills, hiddenSkills, directory) => {
    const discoveredByPath = new Map(
      discoveredSkills
        .map((skill) => [normalizeSkillPath(skill?.path), skill])
        .filter(([skillPath]) => Boolean(skillPath))
    );
    const seen = new Set();
    const result = [];

    for (const hiddenSkill of hiddenSkills) {
      const skillPath = normalizeSkillPath(hiddenSkill?.path);
      if (!skillPath || seen.has(skillPath)) {
        continue;
      }
      seen.add(skillPath);

      const discovered = discoveredByPath.get(skillPath) || null;
      const name = discovered?.name || hiddenSkill.name;
      if (!name) {
        continue;
      }

      const baseSkill = {
        ...hiddenSkill,
        ...(discovered || {}),
        name,
        path: discovered?.path || skillPath,
        scope: discovered?.scope || hiddenSkill.scope,
        source: discovered?.source || hiddenSkill.source,
        description: discovered?.description || hiddenSkill.description,
      };
      const sources = getSkillSources(name, directory, { ...baseSkill, preferDiscoveredPath: true });

      result.push({
        ...baseSkill,
        sources,
      });
    }

    return result;
  };

  const normalizeSkillScopeFilter = (value) => {
    if (typeof value !== 'string') {
      return 'all';
    }
    const normalized = value.trim().toLowerCase();
    if (normalized === SKILL_SCOPE.USER || normalized === SKILL_SCOPE.PROJECT) {
      return normalized;
    }
    return 'all';
  };

  const filterSkillsByScope = (skills, scope) => {
    if (scope !== SKILL_SCOPE.USER && scope !== SKILL_SCOPE.PROJECT) {
      return skills;
    }
    return skills.filter((skill) => skill?.scope === scope);
  };

  const findSkillByIdentity = (skills, skillName, requestedPath, scope = 'all', strictPath = false) => {
    if (isRetiredDevRyanSkillName(skillName)) {
      return null;
    }
    const normalizedRequestedPath = normalizeSkillPath(requestedPath);
    if (normalizedRequestedPath) {
      const byPath = skills.find((skill) => (
        skill?.name === skillName
        && normalizeSkillPath(skill?.path) === normalizedRequestedPath
        && (scope === 'all' || skill?.scope === scope)
      ));
      if (byPath) {
        return { ...byPath, preferDiscoveredPath: true };
      }
      if (strictPath) {
        return null;
      }
    }

    const byName = skills.find((skill) => (
      skill?.name === skillName
      && (scope === 'all' || skill?.scope === scope)
    ));
    return byName ? { ...byName, preferDiscoveredPath: true } : null;
  };

  const findWorktreeRootForSkills = (workingDirectory) => {
    if (!workingDirectory) return null;
    let current = path.resolve(workingDirectory);
    while (true) {
      if (fs.existsSync(path.join(current, '.git'))) {
        return current;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        return null;
      }
      current = parent;
    }
  };

  const getSkillProjectAncestors = (workingDirectory) => {
    if (!workingDirectory) return [];
    const result = [];
    let current = path.resolve(workingDirectory);
    const stop = findWorktreeRootForSkills(workingDirectory) || current;
    while (true) {
      result.push(current);
      if (current === stop) break;
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return result;
  };

  const isPathInside = (candidatePath, parentPath) => {
    if (!candidatePath || !parentPath) return false;
    const normalizedCandidate = path.resolve(candidatePath);
    const normalizedParent = path.resolve(parentPath);
    return normalizedCandidate === normalizedParent || normalizedCandidate.startsWith(`${normalizedParent}${path.sep}`);
  };

  const inferSkillScopeAndSourceFromPath = (skillPath, workingDirectory) => {
    const resolvedPath = typeof skillPath === 'string' ? path.resolve(skillPath) : '';
    const home = os.homedir();
    const source = resolvedPath.includes(`${path.sep}.agents${path.sep}skills${path.sep}`)
      ? 'agents'
      : resolvedPath.includes(`${path.sep}.claude${path.sep}skills${path.sep}`)
        ? 'claude'
        : 'opencode';

    const projectAncestors = getSkillProjectAncestors(workingDirectory);
    const isProjectScoped = projectAncestors.some((ancestor) => {
      const candidates = [
        path.join(ancestor, '.opencode'),
        path.join(ancestor, '.claude', 'skills'),
        path.join(ancestor, '.agents', 'skills'),
      ];
      return candidates.some((candidate) => isPathInside(resolvedPath, candidate));
    });

    if (isProjectScoped) {
      return { scope: SKILL_SCOPE.PROJECT, source };
    }

    const userRoots = [
      path.join(home, '.config', 'opencode'),
      path.join(home, '.opencode'),
      path.join(home, '.claude', 'skills'),
      path.join(home, '.agents', 'skills'),
      process.env.OPENCODE_CONFIG_DIR ? path.resolve(process.env.OPENCODE_CONFIG_DIR) : null,
    ].filter(Boolean);

    if (userRoots.some((root) => isPathInside(resolvedPath, root))) {
      return { scope: SKILL_SCOPE.USER, source };
    }

    return { scope: SKILL_SCOPE.USER, source };
  };

  const fetchOpenCodeDiscoveredSkills = async (workingDirectory) => {
    if (!getOpenCodePort()) {
      return null;
    }

    try {
      const url = new URL(buildOpenCodeUrl('/skill', ''));
      if (workingDirectory) {
        url.searchParams.set('directory', workingDirectory);
      }

      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          ...getOpenCodeAuthHeaders(),
        },
        signal: AbortSignal.timeout(8_000),
      });

      if (!response.ok) {
        return null;
      }

      const payload = await response.json();
      if (!Array.isArray(payload)) {
        return null;
      }

      return payload
        .map((item) => {
          const name = typeof item?.name === 'string' ? item.name.trim() : '';
          const location = typeof item?.location === 'string' ? item.location : '';
          const description = typeof item?.description === 'string' ? item.description : '';
          if (!name || !location) {
            return null;
          }
          const inferred = inferSkillScopeAndSourceFromPath(location, workingDirectory);
          if (!isAllowedSkillSource(inferred.source)) {
            return null;
          }
          return {
            name,
            path: location,
            scope: inferred.scope,
            source: inferred.source,
            description,
          };
        })
        .filter(Boolean);
    } catch {
      return null;
    }
  };

  const mergeDiscoveredSkills = (localSkills = [], openCodeSkills = []) => {
    const merged = [];
    const indexByPath = new Map();
    const indexByName = new Map();

    const remember = (skill, index) => {
      const skillPath = normalizeSkillPath(skill?.path);
      if (skillPath) {
        indexByPath.set(skillPath, index);
      }
      if (skill?.name) {
        indexByName.set(skill.name, index);
      }
    };

    const addOrMerge = (skill, preferIncoming) => {
      if (!skill?.name && !skill?.path) {
        return;
      }

      const skillPath = normalizeSkillPath(skill?.path);
      let existingIndex = skillPath ? indexByPath.get(skillPath) : undefined;
      if (typeof existingIndex !== 'number' && !skillPath && skill?.name) {
        existingIndex = indexByName.get(skill.name);
      }
      if (typeof existingIndex === 'number') {
        // OpenCode can provide fresher runtime metadata, but local discovery can
        // provide paths/scope when OpenCode is unavailable or incomplete.
        merged[existingIndex] = preferIncoming
          ? { ...merged[existingIndex], ...skill }
          : { ...skill, ...merged[existingIndex] };
        remember(merged[existingIndex], existingIndex);
        return;
      }

      const nextIndex = merged.length;
      merged.push(skill);
      remember(skill, nextIndex);
    };

    for (const skill of localSkills || []) {
      addOrMerge(skill, false);
    }
    for (const skill of openCodeSkills || []) {
      addOrMerge(skill, true);
    }

    return merged;
  };

  const resolveDiscoveredSkills = async (directory) => {
    const localSkills = discoverSkills(directory) || [];
    const openCodeSkills = await fetchOpenCodeDiscoveredSkills(directory);
    return mergeDiscoveredSkills(localSkills, Array.isArray(openCodeSkills) ? openCodeSkills : []);
  };

  const listGitIdentitiesForResponse = () => {
    try {
      const profiles = getProfiles();
      return profiles.map((p) => ({ id: p.id, name: p.name }));
    } catch {
      return [];
    }
  };

  const resolveGitIdentity = (profileId) => {
    if (!profileId) {
      return null;
    }
    try {
      const profile = getProfile(profileId);
      const sshKey = profile?.sshKey;
      if (typeof sshKey === 'string' && sshKey.trim()) {
        return { sshKey: sshKey.trim() };
      }
    } catch {
      // ignore
    }
    return null;
  };

  app.get('/api/config/skills', async (req, res) => {
    try {
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) {
        return res.status(400).json({ error });
      }
      const scope = normalizeSkillScopeFilter(req.query.scope);
      const includeHidden = String(req.query.includeHidden || '').toLowerCase() === 'true';
      const settings = await readSettingsFromDisk();
      const hiddenSkills = getHiddenSkillsFromSettings(settings);
      const discoveredSkills = await resolveDiscoveredSkills(directory);
      const scopedDiscoveredSkills = filterSkillsByScope(discoveredSkills, scope);
      const skills = filterVisibleSkills(scopedDiscoveredSkills, hiddenSkills);

      const enrichedSkills = skills.map((skill) => {
        const sources = getSkillSources(skill.name, directory, { ...skill, preferDiscoveredPath: true });
        return {
          ...skill,
          sources
        };
      });

      const payload = { skills: enrichedSkills };
      if (includeHidden) {
        payload.hiddenSkills = filterSkillsByScope(
          buildHiddenSkillsResponse(discoveredSkills, hiddenSkills, directory),
          scope,
        );
      }

      res.json(payload);
    } catch (error) {
      console.error('Failed to list skills:', error);
      res.status(500).json({ error: 'Failed to list skills' });
    }
  });

  app.get('/api/config/skills/catalog', async (req, res) => {
    try {
      const { error } = await resolveOptionalProjectDirectory(req);
      if (error) {
        return sendSkillHarnessError(res, { error }, {
          summary: 'Skills catalog failed to load',
          rootCauseHint: error,
          safeRetry: 'Retry with a valid project directory or without a directory filter',
          stopCondition: 'Stop if the requested project directory is unavailable',
          retryable: false,
        });
      }

      const curatedSources = getCuratedSkillsSources();
      const settings = await readSettingsFromDisk();
      const customSourcesRaw = sanitizeSkillCatalogs(settings.skillCatalogs) || [];

      const customSources = customSourcesRaw.map((entry) => ({
        id: entry.id,
        label: entry.label,
        description: entry.source,
        source: entry.source,
        defaultSubpath: entry.subpath,
        gitIdentityId: entry.gitIdentityId,
      }));

      const sources = [...curatedSources, ...customSources];
      const sourcesForUi = sources.map(({ gitIdentityId, ...rest }) => rest);

      sendHarness(res, { ok: true, sources: sourcesForUi, itemsBySource: {}, pageInfoBySource: {} }, createHarnessSuccess({
        summary: 'Skills catalog loaded',
        nextActions: ['Scan a catalog source or install a listed skill'],
      }));
    } catch (error) {
      console.error('Failed to load skills catalog:', error);
      const message = formatErrorMessage(error, 'Failed to load catalog');
      sendHarness(res, { ok: false, error: { kind: 'unknown', message } }, createHarnessError({
        summary: 'Skills catalog failed to load',
        recovery: {
          rootCauseHint: message,
          safeRetry: 'Retry after settings are readable',
          stopCondition: 'Stop retrying if settings cannot be read',
          retryable: true,
        },
      }), 500);
    }
  });

  app.get('/api/config/skills/catalog/source', async (req, res) => {
    try {
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) {
        return sendSkillHarnessError(res, { ok: false, error: { kind: 'invalidSource', message: error } }, {
          summary: 'Skills catalog source failed to load',
          rootCauseHint: error,
          safeRetry: 'Retry with a valid project directory or without a directory filter',
          stopCondition: 'Stop if the requested project directory is unavailable',
          retryable: false,
        });
      }

      const sourceId = typeof req.query.sourceId === 'string' ? req.query.sourceId : null;
      if (!sourceId) {
        return sendSkillHarnessError(res, { ok: false, error: { kind: 'invalidSource', message: 'Missing sourceId' } }, {
          summary: 'Skills catalog source failed to load',
          rootCauseHint: 'Missing sourceId',
          safeRetry: 'Retry with a catalog sourceId',
          stopCondition: 'Stop if no catalog source has been selected',
          retryable: false,
        });
      }

      const refresh = String(req.query.refresh || '').toLowerCase() === 'true';
      const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : null;

      const curatedSources = getCuratedSkillsSources();
      const settings = await readSettingsFromDisk();
      const customSourcesRaw = sanitizeSkillCatalogs(settings.skillCatalogs) || [];

      const customSources = customSourcesRaw.map((entry) => ({
        id: entry.id,
        label: entry.label,
        description: entry.source,
        source: entry.source,
        defaultSubpath: entry.subpath,
        gitIdentityId: entry.gitIdentityId,
      }));

      const sources = [...curatedSources, ...customSources];
      const src = sources.find((entry) => entry.id === sourceId);

      if (!src) {
        return sendSkillHarnessError(res, { ok: false, error: { kind: 'invalidSource', message: 'Unknown source' } }, {
          statusCode: 404,
          summary: 'Skills catalog source failed to load',
          rootCauseHint: 'Unknown source',
          safeRetry: 'Refresh catalog sources and retry with an available sourceId',
          stopCondition: 'Stop if the catalog source was removed from settings',
          retryable: false,
        });
      }

      const hiddenSkills = getHiddenSkillsFromSettings(settings);
      const discovered = directory
        ? filterVisibleSkills(await resolveDiscoveredSkills(directory), hiddenSkills)
        : [];
      const installedByName = new Map(discovered.map((s) => [s.name, s]));

      if (src.sourceType === 'clawdhub' || isClawdHubSource(src.source)) {
        const scanned = await scanClawdHubPage({ cursor: cursor || null });
        if (!scanned.ok) {
          return sendSkillHarnessError(res, { ok: false, error: scanned.error }, {
            statusCode: 500,
            summary: 'Skills catalog source failed to load',
            rootCauseHint: scanned.error?.message || 'ClawdHub scan did not complete',
            safeRetry: 'Retry after checking catalog availability',
            stopCondition: 'Stop if the catalog source remains unavailable',
          });
        }

        const items = (scanned.items || []).map((item) => {
          const installed = installedByName.get(item.skillName);
          return {
            ...item,
            sourceId: src.id,
            installed: installed
              ? { isInstalled: true, scope: installed.scope, source: installed.source }
              : { isInstalled: false },
          };
        });

        return sendHarness(res, { ok: true, items, nextCursor: scanned.nextCursor || null }, createHarnessSuccess({
          summary: 'Skills catalog source loaded',
          nextActions: ['Install a listed skill or load the next catalog page'],
        }));
      }

      const parsed = parseSkillRepoSource(src.source);
      if (!parsed.ok) {
        return sendSkillHarnessError(res, { ok: false, error: parsed.error }, {
          summary: 'Skills catalog source failed to load',
          rootCauseHint: parsed.error?.message || 'Catalog source could not be parsed',
          safeRetry: 'Retry with a GitHub owner/repo source',
          stopCondition: 'Stop if the configured source is not a supported skills repository',
          retryable: false,
        });
      }

      const effectiveSubpath = src.defaultSubpath || parsed.effectiveSubpath || null;
      const cacheKey = getCacheKey({
        normalizedRepo: parsed.normalizedRepo,
        subpath: effectiveSubpath || '',
        identityId: src.gitIdentityId || '',
      });

      let scanResult = !refresh ? getCachedScan(cacheKey) : null;
      if (!scanResult) {
        const scanned = await scanSkillsRepository({
          source: src.source,
          subpath: src.defaultSubpath,
          defaultSubpath: src.defaultSubpath,
          identity: resolveGitIdentity(src.gitIdentityId),
        });

        if (!scanned.ok) {
          return sendSkillHarnessError(res, { ok: false, error: scanned.error }, {
            statusCode: 500,
            summary: 'Skills catalog source failed to load',
            rootCauseHint: scanned.error?.message || 'Skill repository scan did not complete',
            safeRetry: 'Retry after checking repository access and catalog configuration',
            stopCondition: 'Stop if the repository is unreachable or does not contain skills',
          });
        }

        scanResult = scanned;
        setCachedScan(cacheKey, scanResult);
      }

      const items = (scanResult.items || []).map((item) => {
        const installed = installedByName.get(item.skillName);
        return {
          sourceId: src.id,
          ...item,
          gitIdentityId: src.gitIdentityId,
          installed: installed
            ? { isInstalled: true, scope: installed.scope, source: installed.source }
            : { isInstalled: false },
        };
      });

      return sendHarness(res, { ok: true, items }, createHarnessSuccess({
        summary: 'Skills catalog source loaded',
        nextActions: ['Install a listed skill'],
      }));
    } catch (error) {
      console.error('Failed to load catalog source:', error);
      const message = formatErrorMessage(error, 'Failed to load catalog source');
      return sendSkillHarnessError(res, {
        ok: false,
        error: { kind: 'unknown', message },
      }, {
        statusCode: 500,
        summary: 'Skills catalog source failed to load',
        rootCauseHint: message,
        safeRetry: 'Retry after settings and catalog metadata are readable',
        stopCondition: 'Stop if the catalog source cannot be read',
      });
    }
  });

  app.post('/api/config/skills/scan', async (req, res) => {
    try {
      const { source, subpath, gitIdentityId } = req.body || {};
      const identity = resolveGitIdentity(gitIdentityId);

      const result = await scanSkillsRepository({
        source,
        subpath,
        identity,
      });

      if (!result.ok) {
        const harness = createHarnessError({
          summary: 'Skills scan failed',
          nextActions: ['Check the skill source and retry the scan'],
          recovery: {
            rootCauseHint: result.error?.message || 'Skill repository scan did not complete',
            safeRetry: result.error?.kind === 'authRequired'
              ? 'Retry with a Git identity that can read the repository'
              : 'Retry with a valid skill repository source',
            stopCondition: 'Stop if the source is not reachable or does not contain skills',
            retryable: result.error?.kind !== 'invalidSource',
          },
        });
        if (result.error?.kind === 'authRequired') {
          return sendHarness(res, {
            ok: false,
            error: {
              ...result.error,
              identities: listGitIdentitiesForResponse(),
            },
          }, harness, 401);
        }

        return sendHarness(res, { ok: false, error: result.error }, harness, 400);
      }

      sendHarness(res, { ok: true, items: result.items }, createHarnessSuccess({
        summary: 'Skills scan completed',
        nextActions: ['Select skills to install'],
        artifacts: (result.items || []).map((item) => item.skillDir || item.skillName).filter(Boolean),
      }));
    } catch (error) {
      console.error('Failed to scan skills repository:', error);
      const message = formatErrorMessage(error, 'Failed to scan repository');
      sendHarness(res, { ok: false, error: { kind: 'unknown', message } }, createHarnessError({
        summary: 'Skills scan failed',
        recovery: {
          rootCauseHint: message,
          safeRetry: 'Retry after checking the repository source and network access',
          stopCondition: 'Stop if the source is not reachable or not a skill repository',
          retryable: true,
        },
      }), 500);
    }
  });

  app.post('/api/config/skills/install', async (req, res) => {
    try {
      const {
        source,
        subpath,
        gitIdentityId,
        scope,
        targetSource,
        selections,
        conflictPolicy,
        conflictDecisions,
      } = req.body || {};

      const effectiveScope = scope || 'project';
      let workingDirectory = null;
      if (effectiveScope === 'project') {
        const resolved = await resolveProjectDirectory(req);
        if (!resolved.directory) {
          return sendSkillHarnessError(res, {
            ok: false,
            error: { kind: 'invalidSource', message: resolved.error || 'Project installs require a directory parameter' },
          }, {
            summary: 'Skills install failed',
            rootCauseHint: resolved.error || 'Project installs require a directory parameter',
            safeRetry: 'Retry with a valid project directory or install to user scope',
            stopCondition: 'Stop if no project directory is available for project-scoped installs',
            retryable: false,
          });
        }
        workingDirectory = resolved.directory;
      }

      if (isClawdHubSource(source)) {
        const result = await installSkillsFromClawdHub({
          scope: effectiveScope,
          targetSource,
          workingDirectory,
          userSkillDir: SKILL_DIR,
          selections,
          conflictPolicy,
          conflictDecisions,
        });

        if (!result.ok) {
          const harness = createHarnessError({
            summary: 'Skills install failed',
            nextActions: ['Resolve install errors before retrying'],
            recovery: {
              rootCauseHint: result.error?.message || 'Skill install did not complete',
              safeRetry: result.error?.kind === 'conflicts'
                ? 'Retry with explicit conflict decisions'
                : 'Retry after checking skill source and target write permissions',
              stopCondition: result.error?.kind === 'conflicts'
                ? 'Stop if the user chooses not to overwrite conflicting skills'
                : 'Stop if the target skill directory cannot be written',
              retryable: true,
            },
          });
          if (result.error?.kind === 'conflicts') {
            return sendHarness(res, { ok: false, error: result.error }, harness, 409);
          }
          return sendHarness(res, { ok: false, error: result.error }, harness, 400);
        }

        const installed = result.installed || [];
        const skipped = result.skipped || [];
        const requiresReload = installed.length > 0;

        if (requiresReload) {
          await refreshOpenCodeAfterConfigChange('skills install');
        }

        return sendHarness(res, {
          ok: true,
          installed,
          skipped,
          requiresReload,
          message: requiresReload ? 'Skills installed successfully. Reloading interface…' : 'No skills were installed',
          reloadDelayMs: requiresReload ? clientReloadDelayMs : undefined,
        }, createHarnessSuccess({
          summary: 'Skills install completed',
          nextActions: requiresReload ? ['Wait for OpenCode reload before using installed skills'] : [],
          artifacts: installed.map((item) => item.skillName).filter(Boolean),
        }));
      }

      const identity = resolveGitIdentity(gitIdentityId);

      const result = await installSkillsFromRepository({
        source,
        subpath,
        identity,
        scope: effectiveScope,
        targetSource,
        workingDirectory,
        userSkillDir: SKILL_DIR,
        selections,
        conflictPolicy,
        conflictDecisions,
      });

      if (!result.ok) {
        const harness = createHarnessError({
          summary: 'Skills install failed',
          nextActions: ['Resolve install errors before retrying'],
          recovery: {
            rootCauseHint: result.error?.message || 'Skill install did not complete',
            safeRetry: result.error?.kind === 'authRequired'
              ? 'Retry with a Git identity that can read the repository'
              : result.error?.kind === 'conflicts'
                ? 'Retry with explicit conflict decisions'
                : 'Retry after checking skill source and target write permissions',
            stopCondition: result.error?.kind === 'conflicts'
              ? 'Stop if the user chooses not to overwrite conflicting skills'
              : 'Stop if the target skill directory cannot be written',
            retryable: result.error?.kind !== 'invalidSource',
          },
        });
        if (result.error?.kind === 'conflicts') {
          return sendHarness(res, { ok: false, error: result.error }, harness, 409);
        }

        if (result.error?.kind === 'authRequired') {
          return sendHarness(res, {
            ok: false,
            error: {
              ...result.error,
              identities: listGitIdentitiesForResponse(),
            },
          }, harness, 401);
        }

        return sendHarness(res, { ok: false, error: result.error }, harness, 400);
      }

      const installed = result.installed || [];
      const skipped = result.skipped || [];
      const requiresReload = installed.length > 0;

      if (requiresReload) {
        await refreshOpenCodeAfterConfigChange('skills install');
      }

      sendHarness(res, {
        ok: true,
        installed,
        skipped,
        requiresReload,
        message: requiresReload ? 'Skills installed successfully. Reloading interface…' : 'No skills were installed',
        reloadDelayMs: requiresReload ? clientReloadDelayMs : undefined,
      }, (skipped.length > 0 && installed.length === 0 ? createHarnessWarning : createHarnessSuccess)({
        summary: 'Skills install completed',
        nextActions: requiresReload ? ['Wait for OpenCode reload before using installed skills'] : [],
        artifacts: installed.map((item) => item.skillName).filter(Boolean),
        recovery: skipped.length > 0 ? {
          rootCauseHint: 'Some requested skills were skipped by conflict or selection policy',
          safeRetry: 'Retry with explicit conflict decisions if skipped skills should be installed',
          stopCondition: 'Stop retrying if the user chose to skip the conflicts',
          retryable: true,
        } : null,
      }));
    } catch (error) {
      console.error('Failed to install skills:', error);
      const message = formatErrorMessage(error, 'Failed to install skills');
      sendHarness(res, { ok: false, error: { kind: 'unknown', message } }, createHarnessError({
        summary: 'Skills install failed',
        recovery: {
          rootCauseHint: message,
          safeRetry: 'Retry after checking write permissions and repository access',
          stopCondition: 'Stop if the target skill directory cannot be written',
          retryable: true,
        },
      }), 500);
    }
  });

  app.post('/api/config/skills/hidden/restore', async (req, res) => {
    try {
      const requestedPath = normalizeSkillPath(req.body?.path);
      if (!requestedPath) {
        return res.status(400).json({ error: 'Skill path is required' });
      }

      const { directory, error } = await resolveProjectDirectory(req);
      if (!directory) {
        return res.status(400).json({ error });
      }

      const settings = await readSettingsFromDisk();
      const hiddenSkills = getHiddenSkillsFromSettings(settings);
      const nextHiddenSkills = hiddenSkills.filter((skill) => normalizeSkillPath(skill?.path) !== requestedPath);

      if (nextHiddenSkills.length === hiddenSkills.length) {
        return res.status(404).json({ error: 'Hidden skill not found' });
      }

      const updated = await persistSettings({ hiddenSkills: nextHiddenSkills });
      await refreshOpenCodeAfterConfigChange('skill restore');

      res.json({
        success: true,
        hiddenSkills: getHiddenSkillsFromSettings(updated),
        requiresReload: true,
        message: 'Skill restored successfully. Reloading interface…',
        reloadDelayMs: clientReloadDelayMs,
      });
    } catch (error) {
      console.error('Failed to restore hidden skill:', error);
      res.status(500).json({ error: error.message || 'Failed to restore hidden skill' });
    }
  });

  app.get('/api/config/skills/:name', async (req, res) => {
    try {
      const skillName = req.params.name;
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) {
        return res.status(400).json({ error });
      }
      const scope = normalizeSkillScopeFilter(req.query.scope);
      const requestedPath = typeof req.query.path === 'string' ? req.query.path : '';
      const discoveredSkill = findSkillByIdentity(
        await resolveDiscoveredSkills(directory),
        skillName,
        requestedPath,
        scope,
      );
      const sources = getSkillSources(skillName, directory, discoveredSkill);
      if (scope !== 'all' && sources.md.scope && sources.md.scope !== scope) {
        return res.status(404).json({ error: 'Skill not found' });
      }

      res.json({
        name: skillName,
        sources: sources,
        scope: sources.md.scope,
        source: sources.md.source,
        exists: sources.md.exists
      });
    } catch (error) {
      console.error('Failed to get skill sources:', error);
      res.status(500).json({ error: 'Failed to get skill configuration metadata' });
    }
  });

  app.get('/api/config/skills/:name/files/*filePath', async (req, res) => {
    try {
      const skillName = req.params.name;
      const filePath = decodeURIComponent(req.params.filePath);
      if (isUnsafeSkillRelativePath(filePath)) {
        return res.status(400).json({ error: 'Invalid file path' });
      }
      const { directory, error } = await resolveProjectDirectory(req);
      if (!directory) {
        return res.status(400).json({ error });
      }
      const scope = normalizeSkillScopeFilter(req.query.scope);
      const requestedPath = typeof req.query.path === 'string' ? req.query.path : '';

      const discoveredSkill = findSkillByIdentity(
        await resolveDiscoveredSkills(directory),
        skillName,
        requestedPath,
        scope,
      );
      const sources = getSkillSources(skillName, directory, discoveredSkill);
      if (!sources.md.exists || !sources.md.dir) {
        return res.status(404).json({ error: 'Skill not found' });
      }
      if (scope !== 'all' && sources.md.scope && sources.md.scope !== scope) {
        return res.status(404).json({ error: 'Skill not found' });
      }

      const content = readSkillSupportingFile(sources.md.dir, filePath);
      if (content === null) {
        return res.status(404).json({ error: 'File not found' });
      }

      res.json({ path: filePath, content });
    } catch (error) {
      if (error && typeof error === 'object' && (error.code === 'EACCES' || error.code === 'EPERM')) {
        return res.status(403).json({ error: 'Access to file denied' });
      }
      console.error('Failed to read skill file:', error);
      res.status(500).json({ error: 'Failed to read skill file' });
    }
  });

  app.post('/api/config/skills/:name', async (req, res) => {
    try {
      const skillName = req.params.name;
      const { scope, source: skillSource, ...config } = req.body;
      const { directory, error } = await resolveProjectDirectory(req);
      if (!directory) {
        return res.status(400).json({ error });
      }

      console.log('[Server] Creating skill:', skillName);
      console.log('[Server] Scope:', scope, 'Working directory:', directory);

      createSkill(skillName, { ...config, source: skillSource }, directory, scope || 'project');
      await refreshOpenCodeAfterConfigChange('skill creation');

      res.json({
        success: true,
        requiresReload: true,
        message: `Skill ${skillName} created successfully. Reloading interface…`,
        reloadDelayMs: clientReloadDelayMs,
      });
    } catch (error) {
      console.error('Failed to create skill:', error);
      res.status(500).json({ error: error.message || 'Failed to create skill' });
    }
  });

  app.patch('/api/config/skills/:name', async (req, res) => {
    try {
      const skillName = req.params.name;
      const updates = req.body;
      const { directory, error } = await resolveProjectDirectory(req);
      if (!directory) {
        return res.status(400).json({ error });
      }
      const scope = normalizeSkillScopeFilter(req.query.scope);
      const requestedPath = typeof req.query.path === 'string' ? req.query.path : '';

      console.log(`[Server] Updating skill: ${skillName}`);
      console.log('[Server] Working directory:', directory);

      const discoveredSkill = findSkillByIdentity(
        await resolveDiscoveredSkills(directory),
        skillName,
        requestedPath,
        scope,
      );
      const sources = getSkillSources(skillName, directory, discoveredSkill);
      if (!sources.md.exists || !sources.md.path) {
        return res.status(404).json({ error: 'Skill not found' });
      }
      if (scope !== 'all' && sources.md.scope && sources.md.scope !== scope) {
        return res.status(404).json({ error: 'Skill not found' });
      }

      updateSkill(skillName, updates, directory, discoveredSkill);
      await refreshOpenCodeAfterConfigChange('skill update');

      res.json({
        success: true,
        requiresReload: true,
        message: `Skill ${skillName} updated successfully. Reloading interface…`,
        reloadDelayMs: clientReloadDelayMs,
      });
    } catch (error) {
      console.error('[Server] Failed to update skill:', error);
      res.status(500).json({ error: error.message || 'Failed to update skill' });
    }
  });

  app.put('/api/config/skills/:name/files/*filePath', async (req, res) => {
    try {
      const skillName = req.params.name;
      const filePath = decodeURIComponent(req.params.filePath);
      if (isUnsafeSkillRelativePath(filePath)) {
        return res.status(400).json({ error: 'Invalid file path' });
      }
      const { content } = req.body;
      const { directory, error } = await resolveProjectDirectory(req);
      if (!directory) {
        return res.status(400).json({ error });
      }
      const scope = normalizeSkillScopeFilter(req.query.scope);
      const requestedPath = typeof req.query.path === 'string' ? req.query.path : '';

      const discoveredSkill = findSkillByIdentity(
        await resolveDiscoveredSkills(directory),
        skillName,
        requestedPath,
        scope,
      );
      const sources = getSkillSources(skillName, directory, discoveredSkill);
      if (!sources.md.exists || !sources.md.dir) {
        return res.status(404).json({ error: 'Skill not found' });
      }
      if (scope !== 'all' && sources.md.scope && sources.md.scope !== scope) {
        return res.status(404).json({ error: 'Skill not found' });
      }

      writeSkillSupportingFile(sources.md.dir, filePath, content || '');

      res.json({
        success: true,
        message: `File ${filePath} saved successfully`,
      });
    } catch (error) {
      if (error && typeof error === 'object' && (error.code === 'EACCES' || error.code === 'EPERM')) {
        return res.status(403).json({ error: 'Access to file denied' });
      }
      console.error('Failed to write skill file:', error);
      res.status(500).json({ error: error.message || 'Failed to write skill file' });
    }
  });

  app.delete('/api/config/skills/:name/files/*filePath', async (req, res) => {
    try {
      const skillName = req.params.name;
      const filePath = decodeURIComponent(req.params.filePath);
      if (isUnsafeSkillRelativePath(filePath)) {
        return res.status(400).json({ error: 'Invalid file path' });
      }
      const { directory, error } = await resolveProjectDirectory(req);
      if (!directory) {
        return res.status(400).json({ error });
      }
      const scope = normalizeSkillScopeFilter(req.query.scope);
      const requestedPath = typeof req.query.path === 'string' ? req.query.path : '';

      const discoveredSkill = findSkillByIdentity(
        await resolveDiscoveredSkills(directory),
        skillName,
        requestedPath,
        scope,
      );
      const sources = getSkillSources(skillName, directory, discoveredSkill);
      if (!sources.md.exists || !sources.md.dir) {
        return res.status(404).json({ error: 'Skill not found' });
      }
      if (scope !== 'all' && sources.md.scope && sources.md.scope !== scope) {
        return res.status(404).json({ error: 'Skill not found' });
      }

      deleteSkillSupportingFile(sources.md.dir, filePath);

      res.json({
        success: true,
        message: `File ${filePath} deleted successfully`,
      });
    } catch (error) {
      if (error && typeof error === 'object' && (error.code === 'EACCES' || error.code === 'EPERM')) {
        return res.status(403).json({ error: 'Access to file denied' });
      }
      console.error('Failed to delete skill file:', error);
      res.status(500).json({ error: error.message || 'Failed to delete skill file' });
    }
  });

  app.post('/api/config/skills/:name/hide', async (req, res) => {
    try {
      const skillName = req.params.name;
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) {
        return res.status(400).json({ error });
      }
      const scope = normalizeSkillScopeFilter(req.query.scope);
      const requestedPath = typeof req.query.path === 'string' ? req.query.path : '';
      const discoveredSkill = findSkillByIdentity(
        await resolveDiscoveredSkills(directory),
        skillName,
        requestedPath,
        scope,
        true,
      );
      if (!discoveredSkill) {
        return res.status(404).json({ error: 'Skill not found' });
      }
      const sources = getSkillSources(skillName, directory, discoveredSkill);
      if (!sources.md.exists || !sources.md.path || (scope !== 'all' && sources.md.scope !== scope)) {
        return res.status(404).json({ error: 'Skill not found' });
      }

      const settings = await readSettingsFromDisk();
      const hiddenSkills = getHiddenSkillsFromSettings(settings);
      const skillPath = normalizeSkillPath(sources.md.path);
      if (!hiddenSkills.some((skill) => normalizeSkillPath(skill?.path) === skillPath)) {
        await persistSettings({
          hiddenSkills: [
            ...hiddenSkills,
            {
              name: skillName,
              path: skillPath,
              ...(sources.md.scope ? { scope: sources.md.scope } : {}),
              ...(sources.md.source ? { source: sources.md.source } : {}),
            },
          ],
        });
      }
      await refreshOpenCodeAfterConfigChange('skill hide');

      res.json({
        success: true,
        requiresReload: true,
        message: `Skill ${skillName} hidden successfully. Reloading interface…`,
        reloadDelayMs: clientReloadDelayMs,
      });
    } catch (error) {
      console.error('Failed to hide skill:', error);
      res.status(500).json({ error: error.message || 'Failed to hide skill' });
    }
  });

  app.delete('/api/config/skills/:name', async (req, res) => {
    try {
      const skillName = req.params.name;
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) {
        return res.status(400).json({ error });
      }
      const scope = normalizeSkillScopeFilter(req.query.scope);
      const requestedPath = typeof req.query.path === 'string' ? req.query.path : '';

      const discoveredSkill = findSkillByIdentity(
        await resolveDiscoveredSkills(directory),
        skillName,
        requestedPath,
        scope,
        true,
      );
      if (!discoveredSkill) {
        return res.status(404).json({ error: 'Skill not found' });
      }
      const sources = getSkillSources(skillName, directory, discoveredSkill);
      if (!sources.md.exists || !sources.md.path) {
        return res.status(404).json({ error: 'Skill not found' });
      }
      if (scope !== 'all' && sources.md.scope && sources.md.scope !== scope) {
        return res.status(404).json({ error: 'Skill not found' });
      }

      const skillPath = normalizeSkillPath(sources.md.path);
      const settings = await readSettingsFromDisk();
      const hiddenSkills = getHiddenSkillsFromSettings(settings);
      const normalizedHiddenSkills = hiddenSkills.map((skill) => ({
        ...skill,
        path: normalizeSkillPath(skill?.path),
      }));
      const nextHiddenSkills = normalizedHiddenSkills.filter((skill) => skill.path !== skillPath);

      deleteSkill(skillName, directory, discoveredSkill);

      let warning;
      if (nextHiddenSkills.length !== hiddenSkills.length) {
        try {
          await persistSettings({ hiddenSkills: nextHiddenSkills });
        } catch (settingsError) {
          warning = `The skill was deleted, but its hidden-skill settings entry could not be removed: ${formatErrorMessage(settingsError, 'Failed to update settings')}`;
          console.warn('[API:Skill delete] Failed to remove stale hidden-skill settings entry:', settingsError);
        }
      }

      const externalRuntime = isExternalOpenCode();
      if (!externalRuntime) {
        void Promise.resolve()
          .then(() => refreshOpenCodeAfterConfigChange('skill delete'))
          .catch((refreshError) => {
            console.error('[API:Skill delete] OpenCode refresh failed after deletion:', refreshError);
          });
      } else {
        warning = warning
          ? `${warning} Restart the external OpenCode runtime before relying on the updated skill list.`
          : 'Restart the external OpenCode runtime before relying on the updated skill list.';
      }

      res.json({
        success: true,
        requiresReload: false,
        runtimeRefreshPending: !externalRuntime,
        runtimeApplied: false,
        message: `Skill ${skillName} permanently deleted.`,
        ...(warning ? { warning } : {}),
      });
    } catch (error) {
      console.error('Failed to remove skill:', error);
      res.status(500).json({ error: error.message || 'Failed to remove skill' });
    }
  });
};
