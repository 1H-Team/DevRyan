import { summarizeText as summarizeSharedText } from '../text/summarization.js';
import { stripMessageDiffContent, stripSessionDiffContent } from '../opencode/diff-summary.js';

export const createNotificationTemplateRuntime = (deps) => {
  const {
    readSettingsFromDisk,
    persistSettings,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    resolveGitBinaryForSpawn,
  } = deps;

  const NOTIFICATION_BODY_MAX_CHARS = 1000;
  const ZEN_DEFAULT_MODEL = 'gpt-5-nano';
  const ZEN_MODELS_CACHE_TTL = 5 * 60 * 1000;
  const SESSION_INFO_CACHE_TTL_MS = 60 * 1000;

  let validatedZenFallback = null;
  let cachedZenModels = null;
  let cachedZenModelsTimestamp = 0;
  let zenModelsRefreshPromise = null;

  // Both caches are bounded LRUs (Map insertion order): sessions accumulate for
  // the whole server lifetime otherwise. forgetSessionCaches drops a session's
  // entries when the notifications runtime forgets the session.
  const SESSION_CACHE_MAX_ENTRIES = 200;
  const sessionTitleCache = new Map();
  const sessionInfoCache = new Map();

  const setBoundedCacheEntry = (cache, key, value) => {
    if (cache.has(key)) cache.delete(key);
    cache.set(key, value);
    while (cache.size > SESSION_CACHE_MAX_ENTRIES) {
      const oldestKey = cache.keys().next().value;
      cache.delete(oldestKey);
    }
  };

  const forgetSessionCaches = (sessionId) => {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return;
    sessionTitleCache.delete(sessionId);
    sessionInfoCache.delete(sessionId);
  };

  const createTimeoutSignal = (timeoutMs) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return {
      signal: controller.signal,
      cleanup: () => clearTimeout(timer),
    };
  };

  const formatProjectLabel = (label) => {
    if (!label || typeof label !== 'string') return '';
    return label
      .replace(/[-_]/g, ' ')
      .replace(/\b\w/g, (char) => char.toUpperCase());
  };

  const resolveNotificationTemplate = (template, variables) => {
    if (!template || typeof template !== 'string') return '';
    return template.replace(/\{(\w+)\}/g, (_match, key) => {
      const value = variables[key];
      if (value === undefined || value === null) return '';
      return String(value);
    });
  };

  const shouldApplyResolvedTemplateMessage = (template, resolved, variables) => {
    if (!resolved) {
      return false;
    }

    if (typeof template !== 'string') {
      return true;
    }

    if (template.includes('{last_message}')) {
      return typeof variables?.last_message === 'string' && variables.last_message.trim().length > 0;
    }

    return true;
  };

  const fetchFreeZenModels = async () => {
    const now = Date.now();
    if (cachedZenModels && now - cachedZenModelsTimestamp < ZEN_MODELS_CACHE_TTL) {
      return cachedZenModels.models;
    }

    if (zenModelsRefreshPromise) {
      return zenModelsRefreshPromise;
    }

    zenModelsRefreshPromise = (async () => {
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timeout = controller ? setTimeout(() => controller.abort(), 8000) : null;
      try {
        const [zenResponse, metadataResponse] = await Promise.all([
          fetch('https://opencode.ai/zen/v1/models', {
            signal: controller?.signal,
            headers: { Accept: 'application/json' },
          }),
          fetch('https://models.dev/api.json', {
            signal: controller?.signal,
            headers: { Accept: 'application/json' },
          }),
        ]);
        if (!zenResponse.ok) {
          throw new Error(`zen/v1/models responded with status ${zenResponse.status}`);
        }
        if (!metadataResponse.ok) {
          throw new Error(`models.dev responded with status ${metadataResponse.status}`);
        }

        const data = await zenResponse.json();
        const metadata = await metadataResponse.json();
        const metadataModels = metadata?.opencode?.models && typeof metadata.opencode.models === 'object'
          ? metadata.opencode.models
          : {};
        const allModels = Array.isArray(data?.data) ? data.data : [];
        const freeModels = allModels
          .filter((model) => {
            const id = typeof model?.id === 'string' ? model.id.trim() : '';
            const cost = id ? metadataModels[id]?.cost : null;
            return id && cost?.input === 0 && cost?.output === 0;
          })
          .map((model) => ({ id: model.id.trim(), owned_by: model.owned_by }));

        cachedZenModels = { models: freeModels };
        cachedZenModelsTimestamp = Date.now();
        return freeModels;
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    })().finally(() => {
      zenModelsRefreshPromise = null;
    });
    return zenModelsRefreshPromise;
  };

  const resolveZenModelNonBlocking = (override) => {
    const candidate = typeof override === 'string' && override.trim()
      ? override.trim()
      : ZEN_DEFAULT_MODEL;
    const cachedModels = Array.isArray(cachedZenModels?.models) ? cachedZenModels.models : [];
    const modelIds = cachedModels.map((model) => model.id);
    const cacheAge = Date.now() - cachedZenModelsTimestamp;
    const catalogState = modelIds.length === 0
      ? 'empty'
      : cacheAge < ZEN_MODELS_CACHE_TTL
        ? 'fresh'
        : 'stale';
    const model = modelIds.length === 0 || modelIds.includes(candidate)
      ? candidate
      : modelIds.includes(ZEN_DEFAULT_MODEL)
        ? ZEN_DEFAULT_MODEL
        : modelIds[0];
    const fallbackModel = [
      modelIds.includes(validatedZenFallback) ? validatedZenFallback : null,
      ...modelIds,
    ]
      .find((modelId) => typeof modelId === 'string' && modelId && modelId !== model) || null;

    if (catalogState !== 'fresh') {
      void fetchFreeZenModels().catch(() => {});
    }
    return { model, fallbackModel, catalogState };
  };

  const resolveZenModel = async (override) => {
    const overrideModel = typeof override === 'string' ? override.trim() : '';
    let settingsModel = '';
    try {
      const settings = await readSettingsFromDisk();
      if (typeof settings?.zenModel === 'string' && settings.zenModel.trim().length > 0) {
        settingsModel = settings.zenModel.trim();
      }
    } catch {
    }

    const candidate = overrideModel || settingsModel;
    try {
      const models = await fetchFreeZenModels();
      const modelIds = models.map((model) => model.id);
      if (candidate && modelIds.includes(candidate)) {
        return candidate;
      }
      if (modelIds.includes(ZEN_DEFAULT_MODEL)) {
        return ZEN_DEFAULT_MODEL;
      }
      if (modelIds.length > 0) {
        return modelIds[0];
      }
    } catch {
      if (candidate) {
        return candidate;
      }
    }

    return validatedZenFallback || ZEN_DEFAULT_MODEL;
  };

  const validateZenModelAtStartup = async () => {
    try {
      const freeModels = await fetchFreeZenModels();
      const freeModelIds = freeModels.map((model) => model.id);

      if (freeModelIds.length > 0) {
        validatedZenFallback = freeModelIds[0];

        const settings = await readSettingsFromDisk();
        const storedModel = typeof settings?.zenModel === 'string' ? settings.zenModel.trim() : '';

        if (!storedModel || !freeModelIds.includes(storedModel)) {
          const fallback = freeModelIds[0];
          console.log(
            storedModel
              ? `[zen] Stored model "${storedModel}" not found in free models, falling back to "${fallback}"`
              : `[zen] No model configured, setting default to "${fallback}"`
          );
          await persistSettings({ zenModel: fallback });
        } else {
          console.log(`[zen] Stored model "${storedModel}" verified as available`);
        }
      } else {
        console.warn('[zen] No free models returned from API, skipping validation');
      }
    } catch (error) {
      console.warn('[zen] Startup model validation failed (non-blocking):', error?.message || error);
    }
  };

  const summarizeText = async (text, targetLength, zenModel) => {
    if (!text || typeof text !== 'string' || text.trim().length === 0) return text;
    const result = await summarizeSharedText({
      text,
      threshold: 0,
      maxLength: targetLength,
      zenModel: zenModel || ZEN_DEFAULT_MODEL,
      mode: 'notification',
    });
    return typeof result?.summary === 'string' && result.summary.trim().length > 0
      ? result.summary
      : text;
  };

  const extractTextFromParts = (parts, maxLength = NOTIFICATION_BODY_MAX_CHARS) => {
    if (!Array.isArray(parts) || parts.length === 0) return '';

    const textParts = parts
      .filter((part) => part && (part.type === 'text' || typeof part.text === 'string' || typeof part.content === 'string'))
      .map((part) => part.text || part.content || '')
      .filter(Boolean);

    let text = textParts.length > 0 ? textParts.join('\n').trim() : '';

    if (maxLength > 0 && text.length > maxLength) {
      text = text.slice(0, maxLength);
    }

    return text;
  };

  const extractLastMessageText = (payload, maxLength = NOTIFICATION_BODY_MAX_CHARS) => {
    const info = payload?.properties?.info;
    if (!info) return '';

    const parts = info.parts || payload?.properties?.parts;
    const text = extractTextFromParts(parts, maxLength);
    if (text) return text;

    const content = info.content;
    if (Array.isArray(content)) {
      const textContent = content
        .filter((entry) => entry && (entry.type === 'text' || typeof entry.text === 'string'))
        .map((entry) => entry.text || '')
        .filter(Boolean);
      if (textContent.length > 0) {
        let result = textContent.join('\n').trim();
        if (maxLength > 0 && result.length > maxLength) {
          result = result.slice(0, maxLength);
        }
        return result;
      }
    }

    return '';
  };

  const fetchSessionMessages = async (sessionId, limit = 200) => {
    if (!sessionId) return [];

    try {
      const url = buildOpenCodeUrl(`/session/${encodeURIComponent(sessionId)}/message`, '');
      const response = await fetch(`${url}?limit=${encodeURIComponent(limit)}`, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          ...getOpenCodeAuthHeaders(),
        },
        signal: AbortSignal.timeout(3000),
      });

      if (!response.ok) return [];
      const messages = await response.json().catch(() => null);
      // Diff snapshots can dominate the payload (~92MB observed); notification
      // templates only read message text/metadata, never patch bodies.
      return Array.isArray(messages) ? messages.map(stripMessageDiffContent) : [];
    } catch {
      return [];
    }
  };

  const fetchLastAssistantMessageText = async (sessionId, messageId, maxLength = NOTIFICATION_BODY_MAX_CHARS) => {
    if (!sessionId) return '';

    try {
      const messages = await fetchSessionMessages(sessionId, 5);
      if (messages.length === 0) return '';

      let target = null;
      if (messageId) {
        target = messages.find((message) => message?.info?.id === messageId && message?.info?.role === 'assistant');
      }
      if (!target) {
        for (let i = messages.length - 1; i >= 0; i -= 1) {
          const message = messages[i];
          if (message?.info?.role === 'assistant' && message?.info?.finish === 'stop') {
            target = message;
            break;
          }
        }
      }

      if (!target || !Array.isArray(target.parts)) return '';

      return extractTextFromParts(target.parts, maxLength);
    } catch {
      return '';
    }
  };

  const cacheSessionTitle = (sessionId, title) => {
    if (typeof sessionId === 'string' && sessionId.length > 0 && typeof title === 'string' && title.length > 0) {
      setBoundedCacheEntry(sessionTitleCache, sessionId, title);
    }
  };

  const getCachedSessionTitle = (sessionId) => {
    return sessionTitleCache.get(sessionId) ?? null;
  };

  const cacheSessionInfo = (sessionId, rawInfo) => {
    if (!sessionId || !rawInfo || typeof rawInfo !== 'object') return;
    const data = stripSessionDiffContent(rawInfo);
    setBoundedCacheEntry(sessionInfoCache, sessionId, { data, at: Date.now() });
  };

  const maybeCacheSessionInfoFromEvent = (payload) => {
    if (!payload || typeof payload !== 'object') return;
    const type = payload.type;
    if (type !== 'session.updated' && type !== 'session.created') return;
    const info = payload.properties?.info;
    if (!info || typeof info !== 'object') return;
    cacheSessionTitle(info.id, info.title);
    cacheSessionInfo(info.id, info);
  };

  const fetchSessionInfo = async (sessionId) => {
    if (!sessionId) return null;

    const cached = sessionInfoCache.get(sessionId);
    if (cached && Date.now() - cached.at < SESSION_INFO_CACHE_TTL_MS) {
      return cached.data;
    }

    try {
      const url = buildOpenCodeUrl(`/session/${encodeURIComponent(sessionId)}`, '');
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          ...getOpenCodeAuthHeaders(),
        },
        signal: AbortSignal.timeout(2000),
      });
      if (!response.ok) {
        console.warn(`[Notification] fetchSessionInfo: ${response.status} for session ${sessionId}`);
        return null;
      }
      const rawData = await response.json().catch(() => null);
      if (rawData && typeof rawData === 'object') {
        // Session objects can carry a top-level diff summary; drop patch bodies
        // before caching so the cache holds metadata, not workspace diffs.
        const data = stripSessionDiffContent(rawData);
        cacheSessionInfo(sessionId, data);
        return data;
      }
      return null;
    } catch (error) {
      console.warn(`[Notification] fetchSessionInfo failed for ${sessionId}:`, error?.message || error);
      return null;
    }
  };

  const buildTemplateVariables = async (payload, sessionId) => {
    const info = payload?.properties?.info || {};

    let sessionTitle = payload?.properties?.sessionTitle
      || payload?.properties?.session?.title
      || payload?.properties?.session?.name
      || (typeof info.sessionTitle === 'string' ? info.sessionTitle : '')
      || (typeof info.title === 'string' ? info.title : '')
      || (typeof info.name === 'string' ? info.name : '')
      || '';

    if (!sessionTitle && sessionId) {
      const cached = getCachedSessionTitle(sessionId);
      if (cached) {
        sessionTitle = cached;
      }
    }

    let sessionInfo = null;
    if (!sessionTitle && sessionId) {
      sessionInfo = await fetchSessionInfo(sessionId);
      const fetchedTitle = typeof sessionInfo?.title === 'string'
        ? sessionInfo.title
        : (typeof sessionInfo?.name === 'string' ? sessionInfo.name : '');
      if (fetchedTitle) {
        sessionTitle = fetchedTitle;
        cacheSessionTitle(sessionId, sessionTitle);
      }
    }

    const agentName = (() => {
      const mode = typeof info.agent === 'string' && info.agent.trim().length > 0
        ? info.agent.trim()
        : (typeof info.mode === 'string' ? info.mode.trim() : '');
      if (!mode) return 'Agent';
      return mode.split(/[-_\s]+/).filter(Boolean)
        .map((token) => token.charAt(0).toUpperCase() + token.slice(1)).join(' ');
    })();

    const modelName = (() => {
      const raw = typeof info.modelID === 'string' ? info.modelID.trim()
        : (typeof info.model?.modelID === 'string' ? info.model.modelID.trim() : '');
      if (!raw) return 'Assistant';
      return raw.split(/[-_]+/).filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
    })();

    let projectName = '';
    let branch = '';
    let worktreeDir = '';

    const infoPath = info.path;
    if (typeof infoPath?.root === 'string' && infoPath.root.length > 0) {
      worktreeDir = infoPath.root;
    } else if (typeof infoPath?.cwd === 'string' && infoPath.cwd.length > 0) {
      worktreeDir = infoPath.cwd;
    }

    try {
      const settings = await readSettingsFromDisk();
      const projects = Array.isArray(settings.projects) ? settings.projects : [];

      if (worktreeDir) {
        const normalizedDir = worktreeDir.replace(/\/+$/, '');
        const matchedProject = projects.find((project) => {
          if (!project || typeof project.path !== 'string') return false;
          return project.path.replace(/\/+$/, '') === normalizedDir;
        });
        if (matchedProject && typeof matchedProject.label === 'string' && matchedProject.label.trim().length > 0) {
          projectName = matchedProject.label.trim();
        } else {
          projectName = normalizedDir.split('/').filter(Boolean).pop() || '';
        }
      } else {
        const activeId = typeof settings.activeProjectId === 'string' ? settings.activeProjectId : '';
        const activeProject = activeId ? projects.find((project) => project && project.id === activeId) : projects[0];
        if (activeProject) {
          projectName = typeof activeProject.label === 'string' && activeProject.label.trim().length > 0
            ? activeProject.label.trim()
            : typeof activeProject.path === 'string'
              ? activeProject.path.split('/').pop() || ''
              : '';
          worktreeDir = typeof activeProject.path === 'string' ? activeProject.path : '';
        }
      }
    } catch {
      if (worktreeDir && !projectName) {
        projectName = worktreeDir.split('/').filter(Boolean).pop() || '';
      }
    }

    if (worktreeDir) {
      try {
        const { simpleGit } = await import('simple-git');
        const git = simpleGit({
          baseDir: worktreeDir,
          spawnOptions: { windowsHide: true },
          binary: resolveGitBinaryForSpawn(),
        });
        branch = await Promise.race([
          git.revparse(['--abbrev-ref', 'HEAD']),
          new Promise((_, reject) => setTimeout(() => reject(new Error('git timeout')), 3000)),
        ]).catch(() => '');
      } catch {
      }
    }

    return {
      project_name: formatProjectLabel(projectName),
      worktree: worktreeDir,
      branch: typeof branch === 'string' ? branch.trim() : '',
      session_name: sessionTitle,
      agent_name: agentName,
      model_name: modelName,
      last_message: '',
      session_id: sessionId || '',
    };
  };

  const getCachedZenModels = () => cachedZenModels;

  return {
    createTimeoutSignal,
    formatProjectLabel,
    resolveNotificationTemplate,
    shouldApplyResolvedTemplateMessage,
    fetchFreeZenModels,
    resolveZenModel,
    resolveZenModelNonBlocking,
    validateZenModelAtStartup,
    summarizeText,
    extractTextFromParts,
    extractLastMessageText,
    fetchSessionMessages,
    fetchSessionInfo,
    fetchLastAssistantMessageText,
    maybeCacheSessionInfoFromEvent,
    buildTemplateVariables,
    getCachedZenModels,
    forgetSessionCaches,
  };
};
