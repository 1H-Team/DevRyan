import { detectPlanReadyRevision, PLAN_READY_DEFAULT_TEMPLATE } from './plan-ready.js';

export const SESSION_COMPLETION_NOTIFICATION_SETTLE_MS = 500;

const HIDDEN_NOTIFICATION_SESSION_TITLES = new Set([
  'smartfetch-secondary',
  'Commit generation workflow',
]);

export const isUserVisibleNotificationSessionInfo = (sessionInfo) => {
  if (!sessionInfo || typeof sessionInfo !== 'object') return false;
  const title = typeof sessionInfo.title === 'string'
    ? sessionInfo.title.trim()
    : (typeof sessionInfo.name === 'string' ? sessionInfo.name.trim() : '');
  return !HIDDEN_NOTIFICATION_SESSION_TITLES.has(title);
};

export const createNotificationTriggerRuntime = (deps) => {
  const {
    readSettingsFromDisk,
    prepareNotificationLastMessage,
    summarizeText,
    resolveZenModel,
    buildTemplateVariables,
    extractLastMessageText,
    fetchSessionMessages,
    fetchLastAssistantMessageText,
    resolveNotificationTemplate,
    shouldApplyResolvedTemplateMessage,
    emitDesktopNotification,
    broadcastUiNotification,
    sendPushToAllUiSessions,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    fetchSessionInfo,
    forgetSessionCaches,
  } = deps;

  let getIsWindowFocused = typeof deps.getIsWindowFocused === 'function'
    ? deps.getIsWindowFocused
    : null;

  const setGetIsWindowFocused = (cb) => {
    getIsWindowFocused = typeof cb === 'function' ? cb : null;
  };

  const completionSettleMs = Number.isFinite(deps.completionSettleMs)
    ? Math.max(0, deps.completionSettleMs)
    : SESSION_COMPLETION_NOTIFICATION_SETTLE_MS;

  const shouldSkipForFocusedWindow = (settings) => {
    return settings.notificationMode !== 'always' && getIsWindowFocused?.();
  };

  const PUSH_QUESTION_DEBOUNCE_MS = 500;
  const PUSH_PERMISSION_DEBOUNCE_MS = 500;
  const PLAN_HISTORY_LIMIT = 50;
  const PLAN_HISTORY_RETRY_DELAYS_MS = [50, 150];
  const PLAN_MODE_INSTRUCTION_PREFIX = 'User has requested to enter plan mode';
  const PLAN_CARD_SENTINEL = '<!--plan-->';
  const PLAN_EVENT_CACHE_MAX_SESSIONS = 200;
  const PLAN_EVENT_CACHE_MAX_MESSAGES = 8;
  const PLAN_EVENT_CACHE_MAX_PARTS_PER_MESSAGE = 64;
  const PLAN_EVENT_CACHE_MAX_PART_CHARS = 256 * 1024;
  const PLAN_EVENT_CACHE_MAX_CHARS_PER_SESSION = 512 * 1024;
  const PLAN_EVENT_CACHE_MAX_CHARS = 20 * 1024 * 1024;
  const COMPLETION_RETRY_DELAYS_MS = [250, 1000, 3000];
  const SETTLEMENT_DEDUPE_MAX = 2048;
  // Soft cap so a long-running server with churn doesn't grow this set
  // without bound. The set's only purpose is to dedupe notifications for
  // recently-seen permission requests; oldest entries fall off first.
  const NOTIFIED_PERMISSION_REQUESTS_MAX = 1024;
  const pushQuestionDebounceTimers = new Map();
  const pushPermissionDebounceTimers = new Map();
  // Map insertion order = LRU. Trim oldest when the cap is exceeded.
  const notifiedPermissionRequests = new Set();
  const sessionStatusById = new Map();
  const sessionStatusEventOrderById = new Map();
  const completionCandidatesBySessionId = new Map();
  const sessionsWithIncompleteTodos = new Set();
  const sessionsWithPendingAttention = new Set();
  const processedPlanRevisionKeys = new Set();
  const processedCompletionMessageKeys = new Set();
  const planEventCacheBySessionId = new Map();
  const completionRetryTimers = new Map();
  const completionSettleTimers = new Map();
  const sessionProcessingById = new Map();
  let planEventCacheChars = 0;
  let triggerEventOrder = 0;

  const rememberNotifiedPermissionRequest = (requestKey) => {
    if (typeof requestKey !== 'string' || requestKey.length === 0) return;
    if (notifiedPermissionRequests.has(requestKey)) {
      notifiedPermissionRequests.delete(requestKey);
    }
    notifiedPermissionRequests.add(requestKey);
    while (notifiedPermissionRequests.size > NOTIFIED_PERMISSION_REQUESTS_MAX) {
      const oldest = notifiedPermissionRequests.values().next().value;
      if (oldest === undefined) break;
      notifiedPermissionRequests.delete(oldest);
    }
  };

  const rememberSettlementKey = (keys, key) => {
    if (keys.has(key)) keys.delete(key);
    keys.add(key);
    while (keys.size > SETTLEMENT_DEDUPE_MAX) {
      const oldestKey = keys.values().next().value;
      if (oldestKey === undefined) break;
      keys.delete(oldestKey);
    }
  };

  const completionMessageKey = (sessionId, messageId) => `${sessionId}:${messageId}`;

  const clearCompletionSettleTimer = (sessionId) => {
    const timer = completionSettleTimers.get(sessionId);
    if (!timer) return;
    clearTimeout(timer);
    completionSettleTimers.delete(sessionId);
  };

  const clearCompletionRetryTimer = (sessionId) => {
    const timer = completionRetryTimers.get(sessionId);
    if (!timer) return;
    clearTimeout(timer);
    completionRetryTimers.delete(sessionId);
  };

  const deletePlanEventCache = (sessionId) => {
    const cache = planEventCacheBySessionId.get(sessionId);
    if (!cache) return;
    planEventCacheChars = Math.max(0, planEventCacheChars - (cache.accountedChars ?? 0));
    planEventCacheBySessionId.delete(sessionId);
  };

  const forgetSession = (sessionId) => {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return;
    const questionTimer = pushQuestionDebounceTimers.get(sessionId);
    if (questionTimer) {
      clearTimeout(questionTimer);
      pushQuestionDebounceTimers.delete(sessionId);
    }
    const permissionTimer = pushPermissionDebounceTimers.get(sessionId);
    if (permissionTimer?.timer) {
      clearTimeout(permissionTimer.timer);
    }
    pushPermissionDebounceTimers.delete(sessionId);
    clearCompletionRetryTimer(sessionId);
    clearCompletionSettleTimer(sessionId);
    sessionStatusById.delete(sessionId);
    sessionStatusEventOrderById.delete(sessionId);
    completionCandidatesBySessionId.delete(sessionId);
    sessionsWithIncompleteTodos.delete(sessionId);
    sessionsWithPendingAttention.delete(sessionId);
    deletePlanEventCache(sessionId);
    sessionParentIdCache.delete(sessionId);
    autoAcceptingSessions.delete(sessionId);
    const prefix = `${sessionId}:`;
    for (const key of notifiedPermissionRequests) {
      if (key.startsWith(prefix)) {
        notifiedPermissionRequests.delete(key);
      }
    }
    for (const keys of [processedPlanRevisionKeys, processedCompletionMessageKeys]) {
      for (const key of keys) {
        if (key.startsWith(prefix)) keys.delete(key);
      }
    }
    forgetSessionCaches?.(sessionId);
  };

  const sessionParentIdCache = new Map();
  const SESSION_PARENT_CACHE_TTL_MS = 60 * 1000;

  // Sessions where the client has enabled Permission Auto-Accept. Mirrored
  // from the client-side permissionStore via POST /api/notifications/auto-accept
  // so the server can suppress permission notifications BEFORE dispatch (the
  // 500ms debounce race otherwise leaks notifications for auto-accepted
  // permissions when the replied round-trip is slower than the debounce).
  const autoAcceptingSessions = new Set();
  const setAutoAcceptSession = (sessionId, enabled) => {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return;
    if (enabled) {
      autoAcceptingSessions.add(sessionId);
    } else {
      autoAcceptingSessions.delete(sessionId);
    }
  };

  const buildSessionDeepLinkUrl = (sessionId) => {
    if (!sessionId || typeof sessionId !== 'string') {
      return '/';
    }
    return `/?session=${encodeURIComponent(sessionId)}`;
  };

  const normalizeSessionParentId = (value) => {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : null;
    }
    return value === null ? null : undefined;
  };

  const readParentIdFromSessionInfo = (info) => {
    if (!info || typeof info !== 'object') return undefined;
    if (Object.prototype.hasOwnProperty.call(info, 'parentID')) {
      return normalizeSessionParentId(info.parentID);
    }
    if (Object.prototype.hasOwnProperty.call(info, 'parentId')) {
      return normalizeSessionParentId(info.parentId);
    }
    return undefined;
  };

  const getCachedSessionParentId = (sessionId) => {
    const entry = sessionParentIdCache.get(sessionId);
    if (!entry) return undefined;
    if (Date.now() - entry.at > SESSION_PARENT_CACHE_TTL_MS) {
      sessionParentIdCache.delete(sessionId);
      return undefined;
    }
    return entry.parentID;
  };

  const setCachedSessionParentId = (sessionId, parentID) => {
    if (typeof sessionId !== 'string' || sessionId.length === 0 || parentID === undefined) return;
    sessionParentIdCache.set(sessionId, { parentID: parentID ?? null, at: Date.now() });
  };

  const getParentIdFromPayload = (payload) => {
    if (!payload || typeof payload !== 'object') return undefined;

    const parentIDFromInfo = readParentIdFromSessionInfo(payload.properties?.info);
    if (parentIDFromInfo !== undefined) return parentIDFromInfo;

    const props = payload.properties;
    if (!props || typeof props !== 'object') return undefined;
    if (Object.prototype.hasOwnProperty.call(props, 'parentID')) {
      return normalizeSessionParentId(props.parentID);
    }
    if (Object.prototype.hasOwnProperty.call(props, 'parentId')) {
      return normalizeSessionParentId(props.parentId);
    }

    return undefined;
  };

  const maybeCacheSessionParentFromPayload = (payload) => {
    if (payload?.type !== 'session.created' && payload?.type !== 'session.updated') return;
    const sessionId = extractSessionIdFromPayload(payload);
    if (typeof sessionId !== 'string' || sessionId.length === 0) return;
    const parentID = getParentIdFromPayload(payload);
    setCachedSessionParentId(sessionId, parentID);
  };

  const readSessionParentIdFromResponse = (data) => {
    if (!data || typeof data !== 'object') return undefined;
    const parentID = readParentIdFromSessionInfo(data);
    if (parentID !== undefined) return parentID;

    // A successful specific-session response is authoritative. OpenCode omits
    // parentID entirely for root sessions, so absence here means root rather
    // than "unknown" and must not trigger an expensive all-session fallback.
    return typeof data.id === 'string' && data.id.length > 0 ? null : undefined;
  };

  const fetchSpecificSessionParentId = async (sessionId) => {
    try {
      const response = await fetch(buildOpenCodeUrl(`/session/${encodeURIComponent(sessionId)}`, ''), {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          ...getOpenCodeAuthHeaders(),
        },
        signal: AbortSignal.timeout(2000),
      });
      if (!response.ok) {
        return undefined;
      }
      const data = await response.json().catch(() => null);
      const parentID = readSessionParentIdFromResponse(data);
      setCachedSessionParentId(sessionId, parentID);
      return parentID;
    } catch {
      return undefined;
    }
  };

  const fetchSessionParentId = async (sessionId) => {
    if (!sessionId) return undefined;

    const cached = getCachedSessionParentId(sessionId);
    if (cached !== undefined) return cached;

    const specificParentID = await fetchSpecificSessionParentId(sessionId);
    if (specificParentID !== undefined) return specificParentID;

    try {
      const response = await fetch(buildOpenCodeUrl('/session', ''), {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          ...getOpenCodeAuthHeaders(),
        },
        signal: AbortSignal.timeout(2000),
      });
      if (!response.ok) {
        return undefined;
      }
      const data = await response.json().catch(() => null);
      const sessions = Array.isArray(data)
        ? data
        : Array.isArray(data?.items)
          ? data.items
          : Array.isArray(data?.data)
            ? data.data
            : null;
      if (!sessions) {
        return undefined;
      }

      for (const session of sessions) {
        if (!session || typeof session !== 'object' || typeof session.id !== 'string') continue;
        setCachedSessionParentId(session.id, readParentIdFromSessionInfo(session));
      }

      const match = sessions.find((session) => session && typeof session === 'object' && session.id === sessionId);
      const parentID = readParentIdFromSessionInfo(match);
      setCachedSessionParentId(sessionId, parentID);
      return parentID;
    } catch {
      return undefined;
    }
  };

  const resolveSessionNotificationTarget = async (sessionId) => {
    if (!sessionId || typeof fetchSessionInfo !== 'function') return null;
    const sessionInfo = await fetchSessionInfo(sessionId);
    if (!sessionInfo || typeof sessionInfo !== 'object') return null;

    const parentID = readParentIdFromSessionInfo(sessionInfo) ?? null;
    setCachedSessionParentId(sessionId, parentID);
    return {
      sessionInfo,
      parentID,
      isSubtask: Boolean(parentID),
      isVisible: isUserVisibleNotificationSessionInfo(sessionInfo),
    };
  };

  const isHiddenNotificationSession = async (sessionId) => {
    const target = await resolveSessionNotificationTarget(sessionId);
    return target?.isVisible === false;
  };

  // Mirrors client-side autoRespondsPermission: a session auto-accepts if it
  // OR any ancestor is flagged. Walks the parent chain via fetchSessionParentId.
  const isSessionAutoAccepting = async (sessionId) => {
    if (!sessionId || autoAcceptingSessions.size === 0) return false;
    let current = sessionId;
    const seen = new Set();
    while (current && !seen.has(current)) {
      if (autoAcceptingSessions.has(current)) return true;
      seen.add(current);
      const parent = await fetchSessionParentId(current);
      if (!parent) return false;
      current = parent;
    }
    return false;
  };

  const extractSessionIdFromPayload = (payload) => {
    if (!payload || typeof payload !== 'object') return null;
    const props = payload.properties;
    const info = props?.info;
    const sessionInfoId = (payload.type === 'session.created' || payload.type === 'session.updated')
      ? info?.id
      : null;
    const sessionId =
      info?.sessionID ??
      info?.sessionId ??
      sessionInfoId ??
      props?.sessionID ??
      props?.sessionId ??
      props?.session ??
      null;
    return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null;
  };

  const readPartText = (part) => {
    if (!part || typeof part !== 'object') return '';
    return [part.text, part.content, part.value]
      .filter((value) => typeof value === 'string')
      .reduce((best, value) => value.length > best.length ? value : best, '');
  };

  const cachePlanSession = (sessionId, cache) => {
    const existing = planEventCacheBySessionId.get(sessionId);
    if (existing) {
      planEventCacheChars = Math.max(0, planEventCacheChars - (existing.accountedChars ?? 0));
      planEventCacheBySessionId.delete(sessionId);
    }
    cache.accountedChars = cache.charCount ?? 0;
    planEventCacheChars += cache.accountedChars;
    planEventCacheBySessionId.set(sessionId, cache);
    while (
      planEventCacheBySessionId.size > PLAN_EVENT_CACHE_MAX_SESSIONS
      || planEventCacheChars > PLAN_EVENT_CACHE_MAX_CHARS
    ) {
      const oldestSessionId = planEventCacheBySessionId.keys().next().value;
      if (oldestSessionId === undefined) break;
      deletePlanEventCache(oldestSessionId);
    }
  };

  const createPlanEventCache = ({ sessionId, userMessageId = null, userPart = null, hasSentinel = false }) => {
    const userParts = userPart ? new Map([[userPart.id || 'plan-mode', userPart]]) : new Map();
    return {
      sessionId,
      userMessageId,
      userInfo: userMessageId
        ? { id: userMessageId, sessionID: sessionId, role: 'user', time: { created: Date.now() } }
        : null,
      userParts,
      assistants: new Map(),
      hasSentinel,
      charCount: userPart ? readPartText(userPart).length : 0,
      accountedChars: 0,
    };
  };

  const trimPlanPartForCache = (part, { synthetic = false } = {}) => {
    if (!part || typeof part !== 'object') return null;
    const id = typeof part.id === 'string' && part.id.length > 0
      ? part.id
      : `${part.type || 'part'}:${part.messageID || part.messageId || 'unknown'}`;
    if (part.type === 'text' || part.type === 'reasoning') {
      const text = readPartText(part).slice(0, PLAN_EVENT_CACHE_MAX_PART_CHARS);
      return { id, type: part.type, text, ...(synthetic ? { synthetic: true } : {}) };
    }
    if (part.type === 'tool') {
      return {
        id,
        type: 'tool',
        state: { status: part.state?.status },
      };
    }
    return null;
  };

  const setCachedPlanPart = (cache, parts, part) => {
    const existing = parts.get(part.id);
    const existingChars = existing ? readPartText(existing).length : 0;
    const charCountWithoutExisting = Math.max(0, cache.charCount - existingChars);
    const availableChars = Math.max(
      0,
      PLAN_EVENT_CACHE_MAX_CHARS_PER_SESSION - charCountWithoutExisting,
    );
    const partText = readPartText(part);
    const cachedPart = partText.length > availableChars
      ? { ...part, text: partText.slice(0, availableChars) }
      : part;

    parts.set(cachedPart.id, cachedPart);
    cache.charCount = charCountWithoutExisting + readPartText(cachedPart).length;
    while (parts.size > PLAN_EVENT_CACHE_MAX_PARTS_PER_MESSAGE) {
      const oldestPartId = parts.keys().next().value;
      if (oldestPartId === undefined) break;
      const oldestPart = parts.get(oldestPartId);
      cache.charCount = Math.max(0, cache.charCount - readPartText(oldestPart).length);
      parts.delete(oldestPartId);
    }
  };

  const removeCachedAssistantText = (cache) => {
    for (const assistant of cache.assistants.values()) {
      for (const [partId, part] of assistant.parts) {
        if (part.type !== 'text' && part.type !== 'reasoning') continue;
        cache.charCount = Math.max(0, cache.charCount - readPartText(part).length);
        assistant.parts.delete(partId);
      }
    }
  };

  const getOrCreateCachedAssistant = (cache, messageId) => {
    let assistant = cache.assistants.get(messageId);
    if (!assistant) {
      assistant = { info: null, parts: new Map() };
      cache.assistants.set(messageId, assistant);
      while (cache.assistants.size > PLAN_EVENT_CACHE_MAX_MESSAGES) {
        const oldestMessageId = cache.assistants.keys().next().value;
        if (oldestMessageId === undefined) break;
        const oldestAssistant = cache.assistants.get(oldestMessageId);
        if (oldestAssistant) {
          for (const part of oldestAssistant.parts.values()) {
            cache.charCount = Math.max(0, cache.charCount - readPartText(part).length);
          }
        }
        cache.assistants.delete(oldestMessageId);
      }
    }
    return assistant;
  };

  const maybeCachePlanEvent = (payload, sessionId) => {
    if (!sessionId) return;

    if (payload.type === 'message.part.updated') {
      const part = payload.properties?.part;
      const messageId = part?.messageID ?? part?.messageId;
      if (!part || typeof messageId !== 'string' || messageId.length === 0) return;

      const partText = readPartText(part);
      const isPlanModeInstruction = part.type === 'text'
        && partText.trim().startsWith(PLAN_MODE_INSTRUCTION_PREFIX);
      const hasSentinel = part.type === 'text' && partText.includes(PLAN_CARD_SENTINEL);

      let cache = planEventCacheBySessionId.get(sessionId);
      if (isPlanModeInstruction) {
        const cachedPart = trimPlanPartForCache(part, { synthetic: true });
        cache = createPlanEventCache({
          sessionId,
          userMessageId: messageId,
          userPart: cachedPart,
          hasSentinel,
        });
        cachePlanSession(sessionId, cache);
        return;
      }

      if (!cache && hasSentinel) {
        cache = createPlanEventCache({ sessionId, hasSentinel: true });
        cachePlanSession(sessionId, cache);
      }
      if (!cache) return;

      if (messageId === cache.userMessageId) {
        const cachedPart = trimPlanPartForCache(part);
        if (cachedPart) setCachedPlanPart(cache, cache.userParts, cachedPart);
        cachePlanSession(sessionId, cache);
        return;
      }

      const cachedPart = trimPlanPartForCache(part);
      if (!cachedPart) return;
      const assistant = getOrCreateCachedAssistant(cache, messageId);
      if (hasSentinel) removeCachedAssistantText(cache);
      setCachedPlanPart(cache, assistant.parts, cachedPart);
      if (hasSentinel) cache.hasSentinel = true;
      cachePlanSession(sessionId, cache);
      return;
    }

    if (payload.type !== 'message.updated') return;
    const info = payload.properties?.info;
    if (!info || typeof info.id !== 'string') return;
    const cache = planEventCacheBySessionId.get(sessionId);
    if (!cache) return;

    if (info.role === 'user') {
      if (cache.userMessageId && info.id !== cache.userMessageId) {
        deletePlanEventCache(sessionId);
        return;
      }
      cache.userMessageId = info.id;
      cache.userInfo = { ...info, time: info.time ? { ...info.time } : info.time };
      cachePlanSession(sessionId, cache);
      return;
    }

    if (info.role !== 'assistant') return;
    if (cache.userMessageId && info.parentID && info.parentID !== cache.userMessageId) return;
    if (!cache.userMessageId && typeof info.parentID === 'string') {
      cache.userMessageId = info.parentID;
      cache.userInfo = {
        id: info.parentID,
        sessionID: sessionId,
        role: 'user',
        time: { created: Math.max(0, (info.time?.created ?? Date.now()) - 1) },
      };
    }

    const assistant = getOrCreateCachedAssistant(cache, info.id);
    assistant.info = { ...info, time: info.time ? { ...info.time } : info.time };
    const inlineParts = info.parts || payload.properties?.parts;
    if (assistant.parts.size === 0 && Array.isArray(inlineParts)) {
      for (const part of inlineParts) {
        const cachedPart = trimPlanPartForCache(part);
        if (cachedPart) setCachedPlanPart(cache, assistant.parts, cachedPart);
      }
    }
    cachePlanSession(sessionId, cache);
  };

  const buildCachedPlanMessages = (sessionId) => {
    const cache = planEventCacheBySessionId.get(sessionId);
    if (!cache?.userMessageId || !cache.userInfo) return [];
    const assistants = [...cache.assistants.values()]
      .filter((entry) => entry.info?.role === 'assistant')
      .sort((left, right) => (left.info.time?.created ?? 0) - (right.info.time?.created ?? 0))
      .map((entry) => ({ info: entry.info, parts: [...entry.parts.values()] }));
    return [
      { info: cache.userInfo, parts: [...cache.userParts.values()] },
      ...assistants,
    ];
  };

  const formatMode = (raw) => {
    const value = typeof raw === 'string' ? raw.trim() : '';
    const normalized = value.length > 0 ? value : 'agent';
    return normalized
      .split(/[-_\s]+/)
      .filter(Boolean)
      .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
      .join(' ');
  };

  const formatModelId = (raw) => {
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) {
      return 'Assistant';
    }

    const tokens = value.split(/[-_]+/).filter(Boolean);
    const result = [];
    for (let i = 0; i < tokens.length; i += 1) {
      const current = tokens[i];
      const next = tokens[i + 1];
      if (/^\d+$/.test(current) && next && /^\d+$/.test(next)) {
        result.push(`${current}.${next}`);
        i += 1;
        continue;
      }
      result.push(current);
    }

    return result
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  };

  const getSessionStatusFromPayload = (payload) => {
    if (!payload || payload.type !== 'session.status') return null;
    const status = payload.properties?.status;
    const info = payload.properties?.info;
    const raw = typeof status?.type === 'string'
      ? status.type
      : (typeof info?.type === 'string' ? info.type : '');
    const value = raw.trim();
    return value || null;
  };

  const hasActiveAssistantWork = (parts) => {
    if (!Array.isArray(parts)) return false;
    return parts.some((part) => {
      if (!part || typeof part !== 'object') return false;
      if (part.type === 'reasoning') {
        const time = part.time;
        return !time || typeof time.end === 'undefined';
      }
      if (part.type === 'tool') {
        const status = part.state?.status;
        return status === 'running' || status === 'pending';
      }
      return false;
    });
  };

  const isCompletedAssistantMessage = (payload) => {
    const info = payload?.properties?.info;
    if (!info || info.role !== 'assistant' || info.finish !== 'stop') {
      return false;
    }

    const completedAt = typeof info.time?.completed === 'number' ? info.time.completed : undefined;
    const hasCompletedFlag = completedAt > 0 || info.status === 'completed';
    const hasCompletionField = info.time?.completed !== undefined || info.status !== undefined;
    // Some OpenCode versions omit explicit completion fields on message.updated.
    // Treat finish=stop as compatible only when those fields are absent, while
    // still rejecting active reasoning/tool parts so thinking does not notify.
    if (hasCompletionField && !hasCompletedFlag) {
      return false;
    }

    const parts = info.parts || payload?.properties?.parts;
    return !hasActiveAssistantWork(parts);
  };

  const isSettledAssistantTurnUpdate = (payload) => {
    const info = payload?.properties?.info;
    if (!info || info.role !== 'assistant' || info.streaming === true || info.finish === 'error') {
      return false;
    }
    const status = typeof info.status === 'string' ? info.status.trim().toLowerCase() : '';
    if (status === 'running' || status === 'pending' || status === 'streaming') return false;
    const completedAt = typeof info.time?.completed === 'number' ? info.time.completed : 0;
    if (status !== 'complete' && status !== 'completed' && status !== 'done' && completedAt <= 0) {
      return false;
    }
    const parts = info.parts || payload?.properties?.parts;
    return !hasActiveAssistantWork(parts);
  };

  const prepareLastMessageForNotification = ({ message, settings }) => {
    return prepareNotificationLastMessage({
      message,
      settings,
      summarize: async (text, length) => {
        const zenModel = await resolveZenModel(settings?.zenModel);
        return summarizeText(text, length, zenModel);
      },
    });
  };

  const resolvePlanRevisionForCompletion = async ({ payload, sessionId, allowGenericCompletion }) => {
    const info = payload.properties?.info;
    const cachedMessages = buildCachedPlanMessages(sessionId);
    const cachedRevision = detectPlanReadyRevision(cachedMessages);
    if (cachedRevision) return cachedRevision;

    const payloadParts = info?.parts || payload.properties?.parts;
    const fallbackMessages = info && Array.isArray(payloadParts)
      ? [{ info, parts: payloadParts }]
      : [];
    const payloadRevision = detectPlanReadyRevision(fallbackMessages);
    if (payloadRevision) return payloadRevision;

    const planCache = planEventCacheBySessionId.get(sessionId);
    const shouldFetchCompatibilityHistory = Boolean(planCache) || !allowGenericCompletion;
    if (!shouldFetchCompatibilityHistory) return null;

    try {
      let messages = await fetchSessionMessages(sessionId, PLAN_HISTORY_LIMIT);
      const includesCurrentMessage = () => !info?.id
        || messages.some((message) => message?.info?.id === info.id);

      for (const retryDelayMs of PLAN_HISTORY_RETRY_DELAYS_MS) {
        if (includesCurrentMessage()) break;
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        messages = await fetchSessionMessages(sessionId, PLAN_HISTORY_LIMIT);
      }

      return detectPlanReadyRevision(
        messages.length > 0 && includesCurrentMessage() ? messages : fallbackMessages,
      );
    } catch (error) {
      console.warn('[Notification] Plan classification failed:', error?.message || error);
      return null;
    }
  };

  const sendCompletionNotification = async ({ payload, sessionId, allowGenericCompletion = true }) => {
    const info = payload.properties?.info;
    const notificationTarget = await resolveSessionNotificationTarget(sessionId);
    if (!notificationTarget) return null;
    if (!notificationTarget.isVisible) return true;

    const settings = await readSettingsFromDisk();
    const isSubtask = notificationTarget.isSubtask;
    if (settings.notifyOnSubtasks === false && isSubtask) return true;

    const planRevision = await resolvePlanRevisionForCompletion({
      payload,
      sessionId,
      allowGenericCompletion,
    });

    if (planRevision) {
      // A plan-producing turn owns the completion event. Turning this event off
      // intentionally suppresses the alert instead of falling through to the
      // generic Session Completion notification.
      if (settings.notifyOnPlanReady === false) return true;
      if (shouldSkipForFocusedWindow(settings)) return true;
      const planRevisionKey = completionMessageKey(sessionId, planRevision.sourceMessageId);
      if (processedPlanRevisionKeys.has(planRevisionKey)) return true;

      let title = PLAN_READY_DEFAULT_TEMPLATE.title;
      let body = PLAN_READY_DEFAULT_TEMPLATE.message;

      try {
        const planTemplate = (settings.notificationTemplates || {}).planReady || PLAN_READY_DEFAULT_TEMPLATE;
        const variables = await buildTemplateVariables(payload, sessionId);
        variables.last_message = await prepareLastMessageForNotification({
          message: planRevision.planText,
          settings,
        });

        const resolvedTitle = resolveNotificationTemplate(planTemplate.title, variables);
        const resolvedBody = resolveNotificationTemplate(planTemplate.message, variables);
        if (resolvedTitle) title = resolvedTitle;
        if (shouldApplyResolvedTemplateMessage(planTemplate.message, resolvedBody, variables)) body = resolvedBody;
      } catch (error) {
        console.warn('[Notification] Plan Ready template resolution failed, using defaults:', error?.message || error);
      }

      const tag = `plan-ready-${sessionId}-${planRevision.sourceMessageId}`;
      let delivered = false;
      if (settings.nativeNotificationsEnabled) {
        const notificationPayload = {
          title,
          body,
          tag,
          kind: 'plan-ready',
          sessionId,
          sourceMessageId: planRevision.sourceMessageId,
          requireHidden: settings.notificationMode !== 'always',
        };
        emitDesktopNotification(notificationPayload);
        broadcastUiNotification(notificationPayload);
        delivered = true;
      }

      try {
        await sendPushToAllUiSessions(
          {
            title,
            body,
            tag,
            data: {
              url: buildSessionDeepLinkUrl(sessionId),
              sessionId,
              sourceMessageId: planRevision.sourceMessageId,
              type: 'plan-ready',
            },
          },
          { requireNoSse: true },
        );
        delivered = true;
      } catch (error) {
        console.warn('[Notification] Plan Ready push delivery failed:', error?.message || error);
      }
      if (!delivered) return false;
      rememberSettlementKey(processedPlanRevisionKeys, planRevisionKey);
      return true;
    }

    if (!allowGenericCompletion) return true;
    if (!isSubtask && settings.notifyOnCompletion === false) return true;
    if (shouldSkipForFocusedWindow(settings)) return true;

    let title = isSubtask ? `${formatMode(info?.mode)} agent is ready` : 'Session complete';
    let body = isSubtask
      ? `${formatModelId(info?.modelID)} completed the task`
      : 'The requested work is ready to review';

    try {
      const templates = settings.notificationTemplates || {};
      const completionTemplate = isSubtask && settings.notifyOnSubtasks !== false
        ? (templates.subtask || templates.completion || { title: '{agent_name} is ready', message: '{model_name} completed the task' })
        : (templates.completion || { title: 'Session complete', message: '{session_name} is ready to review' });

      const variables = await buildTemplateVariables(payload, sessionId);

      const messageId = info?.id;
      let lastMessage = extractLastMessageText(payload);
      if (!lastMessage) {
        lastMessage = await fetchLastAssistantMessageText(sessionId, messageId);
      }

      variables.last_message = await prepareLastMessageForNotification({
        message: lastMessage,
        settings,
      });

      const resolvedTitle = resolveNotificationTemplate(completionTemplate.title, variables);
      const resolvedBody = resolveNotificationTemplate(completionTemplate.message, variables);
      if (resolvedTitle) title = resolvedTitle;
      if (shouldApplyResolvedTemplateMessage(completionTemplate.message, resolvedBody, variables)) body = resolvedBody;
    } catch (error) {
      console.warn('[Notification] Template resolution failed, using defaults:', error?.message || error);
    }

    let delivered = false;
    if (settings.nativeNotificationsEnabled) {
      const notificationPayload = {
        title,
        body,
        tag: `ready-${sessionId}`,
        kind: 'ready',
        sessionId,
        requireHidden: settings.notificationMode !== 'always',
      };
      emitDesktopNotification(notificationPayload);
      broadcastUiNotification(notificationPayload);
      delivered = true;
    }

    try {
      await sendPushToAllUiSessions(
        {
          title,
          body,
          tag: `ready-${sessionId}`,
          data: {
            url: buildSessionDeepLinkUrl(sessionId),
            sessionId,
            type: 'ready',
          },
        },
        { requireNoSse: true },
      );
      delivered = true;
    } catch (error) {
      console.warn('[Notification] Completion push delivery failed:', error?.message || error);
    }
    return delivered;
  };

  const enqueueSessionWork = (sessionId, work) => {
    if (!sessionId) return Promise.resolve().then(work);
    const previous = sessionProcessingById.get(sessionId) ?? Promise.resolve();
    const current = previous
      .catch(() => {})
      .then(work)
      .finally(() => {
        if (sessionProcessingById.get(sessionId) === current) {
          sessionProcessingById.delete(sessionId);
        }
      });
    sessionProcessingById.set(sessionId, current);
    return current;
  };

  const scheduleCompletionRetry = (sessionId, candidate, { metadata = false } = {}) => {
    if (completionRetryTimers.has(sessionId)) return;
    const retryField = metadata ? 'metadataRetryCount' : 'retryCount';
    const retryCount = candidate[retryField] ?? 0;
    const delay = COMPLETION_RETRY_DELAYS_MS[Math.min(
      retryCount,
      COMPLETION_RETRY_DELAYS_MS.length - 1,
    )];
    candidate[retryField] = retryCount + 1;
    const timer = setTimeout(() => {
      completionRetryTimers.delete(sessionId);
      void enqueueSessionWork(sessionId, () => settlePendingCompletionForIdleSession(sessionId));
    }, delay);
    completionRetryTimers.set(sessionId, timer);
  };

  const completionCanSettle = (sessionId, candidate) => {
    if (
      !sessionId
      || sessionStatusById.get(sessionId) !== 'idle'
      || sessionsWithIncompleteTodos.has(sessionId)
      || sessionsWithPendingAttention.has(sessionId)
    ) {
      return false;
    }

    if (!candidate) return false;
    const statusEventOrder = sessionStatusEventOrderById.get(sessionId) ?? 0;
    return statusEventOrder > candidate.eventOrder;
  };

  const consumeCompletionCandidate = (sessionId, candidate, messageKey) => {
    if (completionCandidatesBySessionId.get(sessionId) === candidate) {
      completionCandidatesBySessionId.delete(sessionId);
    }
    const messageId = candidate.payload?.properties?.info?.id;
    if (messageId && messageKey) {
      rememberSettlementKey(processedCompletionMessageKeys, messageKey);
    }
  };

  const settlePendingCompletionForIdleSession = async (sessionId) => {
    const candidate = completionCandidatesBySessionId.get(sessionId);
    if (!completionCanSettle(sessionId, candidate)) return;

    const messageId = candidate.payload?.properties?.info?.id;
    const messageKey = messageId ? completionMessageKey(sessionId, messageId) : null;
    if (messageKey && processedCompletionMessageKeys.has(messageKey)) {
      completionCandidatesBySessionId.delete(sessionId);
      return;
    }

    try {
      const processed = await sendCompletionNotification(candidate);
      if (processed === null) {
        const metadataRetryCount = candidate.metadataRetryCount ?? 0;
        if (metadataRetryCount >= COMPLETION_RETRY_DELAYS_MS.length) {
          consumeCompletionCandidate(sessionId, candidate, messageKey);
          return;
        }
        scheduleCompletionRetry(sessionId, candidate, { metadata: true });
        return;
      }
      if (!processed) {
        scheduleCompletionRetry(sessionId, candidate);
        return;
      }
      consumeCompletionCandidate(sessionId, candidate, messageKey);
    } catch (error) {
      console.warn('[Notification] Completion settlement failed; retaining candidate:', error?.message || error);
      scheduleCompletionRetry(sessionId, candidate);
    }
  };

  const maybeSchedulePendingCompletionForIdleSession = async (sessionId) => {
    const candidate = completionCandidatesBySessionId.get(sessionId);
    if (!completionCanSettle(sessionId, candidate) || completionSettleTimers.has(sessionId)) return;

    if (completionSettleMs === 0) {
      await settlePendingCompletionForIdleSession(sessionId);
      return;
    }

    const timer = setTimeout(() => {
      completionSettleTimers.delete(sessionId);
      void enqueueSessionWork(sessionId, () => settlePendingCompletionForIdleSession(sessionId));
    }, completionSettleMs);
    completionSettleTimers.set(sessionId, timer);
  };

  const processTriggerPayload = async (payload, eventOrder) => {
    maybeCacheSessionParentFromPayload(payload);

    const sessionId = extractSessionIdFromPayload(payload);
    if (payload.type === 'session.deleted' && sessionId) {
      forgetSession(sessionId);
      return;
    }
    maybeCachePlanEvent(payload, sessionId);
    if (payload.type === 'todo.updated' && sessionId) {
      const todos = Array.isArray(payload.properties?.todos) ? payload.properties.todos : [];
      const hasIncompleteTodos = todos.some((todo) => {
        const status = typeof todo?.status === 'string'
          ? todo.status.trim().toLowerCase().replaceAll(' ', '_')
          : '';
        return status === 'pending' || status === 'in_progress';
      });
      if (hasIncompleteTodos) {
        sessionsWithIncompleteTodos.add(sessionId);
        clearCompletionSettleTimer(sessionId);
      } else {
        sessionsWithIncompleteTodos.delete(sessionId);
        await maybeSchedulePendingCompletionForIdleSession(sessionId);
      }
      return;
    }
    if (payload.type === 'session.status' && sessionId) {
      const status = getSessionStatusFromPayload(payload);
      if (status) {
        sessionStatusById.set(sessionId, status);
        sessionStatusEventOrderById.set(sessionId, eventOrder);
        if (status === 'idle') {
          await maybeSchedulePendingCompletionForIdleSession(sessionId);
        } else {
          clearCompletionSettleTimer(sessionId);
        }
      }
      return;
    }

    if (payload.type === 'message.updated') {
      const info = payload.properties?.info;
      const allowGenericCompletion = isCompletedAssistantMessage(payload);
      const alreadyProcessed = info?.id
        && processedCompletionMessageKeys.has(completionMessageKey(sessionId, info.id));
      if (
        sessionId
        && !alreadyProcessed
        && (allowGenericCompletion || isSettledAssistantTurnUpdate(payload))
      ) {
        const existingCandidate = completionCandidatesBySessionId.get(sessionId);
        const isSameMessage = existingCandidate?.payload?.properties?.info?.id === info?.id;
        clearCompletionSettleTimer(sessionId);
        if (!isSameMessage) clearCompletionRetryTimer(sessionId);
        completionCandidatesBySessionId.set(sessionId, {
          payload,
          sessionId,
          eventOrder,
          allowGenericCompletion: allowGenericCompletion
            || (isSameMessage && existingCandidate.allowGenericCompletion === true),
          retryCount: isSameMessage
            ? existingCandidate.retryCount
            : 0,
          metadataRetryCount: isSameMessage
            ? existingCandidate.metadataRetryCount
            : 0,
        });
        await maybeSchedulePendingCompletionForIdleSession(sessionId);
      }

      if (info?.role === 'assistant' && info?.finish === 'error' && sessionId) {
        if (await isHiddenNotificationSession(sessionId)) return;
        const settings = await readSettingsFromDisk();
        if (settings.notifyOnError === false) return;

        if (shouldSkipForFocusedWindow(settings)) {
          return;
        }

        let title = 'Tool error';
        let body = 'An error occurred';

        try {
          const variables = await buildTemplateVariables(payload, sessionId);
          const errorMessageId = info?.id;
          let lastMessage = extractLastMessageText(payload);
          if (!lastMessage) {
            lastMessage = await fetchLastAssistantMessageText(sessionId, errorMessageId);
          }

          variables.last_message = await prepareLastMessageForNotification({
            message: lastMessage,
            settings,
          });

          const errorTemplate = (settings.notificationTemplates || {}).error || { title: 'Tool error', message: '{last_message}' };
          const resolvedTitle = resolveNotificationTemplate(errorTemplate.title, variables);
          const resolvedBody = resolveNotificationTemplate(errorTemplate.message, variables);
          if (resolvedTitle) title = resolvedTitle;
          if (shouldApplyResolvedTemplateMessage(errorTemplate.message, resolvedBody, variables)) body = resolvedBody;
        } catch (error) {
          console.warn('[Notification] Error template resolution failed, using defaults:', error?.message || error);
        }

        if (settings.nativeNotificationsEnabled) {
          const notificationPayload = {
            title,
            body,
            tag: `error-${sessionId}`,
            kind: 'error',
            sessionId,
            requireHidden: settings.notificationMode !== 'always',
          };
          emitDesktopNotification(notificationPayload);
          broadcastUiNotification(notificationPayload);
        }

        await sendPushToAllUiSessions(
          {
            title,
            body,
            tag: `error-${sessionId}`,
            data: {
              url: buildSessionDeepLinkUrl(sessionId),
              sessionId,
              type: 'error',
            },
          },
          { requireNoSse: true },
        );
      }

      return;
    }

    if (payload.type === 'question.asked' && sessionId) {
      sessionsWithPendingAttention.add(sessionId);
      clearCompletionSettleTimer(sessionId);
      const existingTimer = pushQuestionDebounceTimers.get(sessionId);
      if (existingTimer) {
        clearTimeout(existingTimer);
      }

      const timer = setTimeout(async () => {
        pushQuestionDebounceTimers.delete(sessionId);

        if (await isHiddenNotificationSession(sessionId)) return;

        const settings = await readSettingsFromDisk();
        if (settings.notifyOnQuestion === false) {
          return;
        }

        if (shouldSkipForFocusedWindow(settings)) {
          return;
        }

        const firstQuestion = payload.properties?.questions?.[0];
        const header = typeof firstQuestion?.header === 'string' ? firstQuestion.header.trim() : '';
        const questionText = typeof firstQuestion?.question === 'string' ? firstQuestion.question.trim() : '';

        let title = /plan\s*mode/i.test(header)
          ? 'Switch to plan mode'
          : /build\s*agent/i.test(header)
            ? 'Switch to build mode'
            : header || 'Input needed';
        let body = questionText || 'Agent is waiting for your response';

        try {
          const variables = await buildTemplateVariables(payload, sessionId);
          variables.last_message = questionText || header || '';

          const templates = settings.notificationTemplates || {};
          const questionTemplate = templates.question || { title: 'Input needed', message: '{last_message}' };

          const resolvedTitle = resolveNotificationTemplate(questionTemplate.title, variables);
          const resolvedBody = resolveNotificationTemplate(questionTemplate.message, variables);
          if (resolvedTitle) title = resolvedTitle;
          if (shouldApplyResolvedTemplateMessage(questionTemplate.message, resolvedBody, variables)) body = resolvedBody;
        } catch (error) {
          console.warn('[Notification] Question template resolution failed, using defaults:', error?.message || error);
        }

        if (settings.nativeNotificationsEnabled) {
          emitDesktopNotification({
            kind: 'question',
            title,
            body,
            tag: `question-${sessionId}`,
            sessionId,
            requireHidden: settings.notificationMode !== 'always',
          });

          broadcastUiNotification({
            kind: 'question',
            title,
            body,
            tag: `question-${sessionId}`,
            sessionId,
            requireHidden: settings.notificationMode !== 'always',
          });
        }

        void sendPushToAllUiSessions(
          {
            title,
            body,
            tag: `question-${sessionId}`,
            data: {
              url: buildSessionDeepLinkUrl(sessionId),
              sessionId,
              type: 'question',
            },
          },
          { requireNoSse: true },
        );
      }, PUSH_QUESTION_DEBOUNCE_MS);

      pushQuestionDebounceTimers.set(sessionId, timer);
      return;
    }

    if ((payload.type === 'question.replied' || payload.type === 'question.rejected') && sessionId) {
      sessionsWithPendingAttention.delete(sessionId);
      const pendingQuestionTimer = pushQuestionDebounceTimers.get(sessionId);
      if (pendingQuestionTimer) {
        clearTimeout(pendingQuestionTimer);
        pushQuestionDebounceTimers.delete(sessionId);
      }
      await maybeSchedulePendingCompletionForIdleSession(sessionId);
      return;
    }

    if (payload.type === 'permission.replied' && sessionId) {
      sessionsWithPendingAttention.delete(sessionId);
      const requestId = payload.properties?.requestID ?? payload.properties?.requestId ?? payload.properties?.id;
      const requestKey = typeof requestId === 'string' ? `${sessionId}:${requestId}` : null;
      const pendingNotification = pushPermissionDebounceTimers.get(sessionId);
      if (!pendingNotification) {
        await maybeSchedulePendingCompletionForIdleSession(sessionId);
        return;
      }

      // Some runtimes may omit requestID on permission.replied.
      // When request ID is missing, clear session debounce to avoid
      // showing stale permission notifications for auto-approved prompts.
      if (!requestKey || !pendingNotification.requestKey || pendingNotification.requestKey === requestKey) {
        clearTimeout(pendingNotification.timer);
        pushPermissionDebounceTimers.delete(sessionId);
      }
      await maybeSchedulePendingCompletionForIdleSession(sessionId);
      return;
    }

    if (payload.type === 'permission.asked' && sessionId) {
      sessionsWithPendingAttention.add(sessionId);
      clearCompletionSettleTimer(sessionId);
      const requestId = payload.properties?.id ?? payload.properties?.requestID ?? payload.properties?.requestId;
      const permission = payload.properties?.permission;
      const requestKey = typeof requestId === 'string' ? `${sessionId}:${requestId}` : null;
      if (requestKey && notifiedPermissionRequests.has(requestKey)) {
        return;
      }

      // Client may be in Permission Auto-Accept for this session (or any
      // ancestor). Skip the whole notification path — the client responds
      // directly and the user has opted out of approval prompts.
      if (await isSessionAutoAccepting(sessionId)) {
        if (requestKey) rememberNotifiedPermissionRequest(requestKey);
        return;
      }

      const existingTimer = pushPermissionDebounceTimers.get(sessionId);
      if (existingTimer) {
        clearTimeout(existingTimer.timer);
      }

      const timer = setTimeout(async () => {
        pushPermissionDebounceTimers.delete(sessionId);

        if (await isHiddenNotificationSession(sessionId)) return;
        if (await isSessionAutoAccepting(sessionId)) {
          if (requestKey) rememberNotifiedPermissionRequest(requestKey);
          return;
        }

        const settings = await readSettingsFromDisk();

        if (settings.notifyOnQuestion === false) {
          return;
        }

        if (shouldSkipForFocusedWindow(settings)) {
          return;
        }

        const sessionTitle = payload.properties?.sessionTitle;
        const permissionText = typeof permission === 'string' && permission.length > 0 ? permission : '';
        const fallbackMessage = typeof sessionTitle === 'string' && sessionTitle.trim().length > 0
          ? sessionTitle.trim()
          : permissionText || 'Agent is waiting for your approval';

        let title = 'Permission required';
        let body = fallbackMessage;

        try {
          const variables = await buildTemplateVariables(payload, sessionId);
          variables.last_message = fallbackMessage;

          const templates = settings.notificationTemplates || {};
          const questionTemplate = templates.question || { title: 'Permission required', message: '{last_message}' };

          const resolvedTitle = resolveNotificationTemplate(questionTemplate.title, variables);
          const resolvedBody = resolveNotificationTemplate(questionTemplate.message, variables);
          if (resolvedTitle) title = resolvedTitle;
          if (shouldApplyResolvedTemplateMessage(questionTemplate.message, resolvedBody, variables)) body = resolvedBody;
        } catch (error) {
          console.warn('[Notification] Permission template resolution failed, using defaults:', error?.message || error);
        }

        if (settings.nativeNotificationsEnabled) {
          emitDesktopNotification({
            kind: 'permission',
            title,
            body,
            tag: requestKey ? `permission-${requestKey}` : `permission-${sessionId}`,
            sessionId,
            requireHidden: settings.notificationMode !== 'always',
          });

          broadcastUiNotification({
            kind: 'permission',
            title,
            body,
            tag: requestKey ? `permission-${requestKey}` : `permission-${sessionId}`,
            sessionId,
            requireHidden: settings.notificationMode !== 'always',
          });
        }

        if (requestKey) {
          rememberNotifiedPermissionRequest(requestKey);
        }

        void sendPushToAllUiSessions(
          {
            title,
            body,
            tag: `permission-${sessionId}`,
            data: {
              url: buildSessionDeepLinkUrl(sessionId),
              sessionId,
              type: 'permission',
            },
          },
          { requireNoSse: true },
        );
      }, PUSH_PERMISSION_DEBOUNCE_MS);

      pushPermissionDebounceTimers.set(sessionId, { timer, requestKey });
    }
  };

  const maybeSendPushForTrigger = (payload) => {
    if (!payload || typeof payload !== 'object') {
      return Promise.resolve();
    }
    triggerEventOrder += 1;
    const eventOrder = triggerEventOrder;
    const sessionId = extractSessionIdFromPayload(payload);
    return enqueueSessionWork(sessionId, () => processTriggerPayload(payload, eventOrder));
  };

  return {
    maybeSendPushForTrigger,
    setAutoAcceptSession,
    setGetIsWindowFocused,
    forgetSession,
  };
};
