export const createNotificationTriggerRuntime = (deps) => {
  const {
    readSettingsFromDisk,
    prepareNotificationLastMessage,
    summarizeText,
    resolveZenModel,
    buildTemplateVariables,
    extractLastMessageText,
    fetchLastAssistantMessageText,
    resolveNotificationTemplate,
    shouldApplyResolvedTemplateMessage,
    emitDesktopNotification,
    broadcastUiNotification,
    sendPushToAllUiSessions,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
  } = deps;

  let getIsWindowFocused = typeof deps.getIsWindowFocused === 'function'
    ? deps.getIsWindowFocused
    : null;

  const setGetIsWindowFocused = (cb) => {
    getIsWindowFocused = typeof cb === 'function' ? cb : null;
  };

  const shouldSkipForFocusedWindow = (settings) => {
    return settings.notificationMode !== 'always' && getIsWindowFocused?.();
  };

  const PUSH_READY_COOLDOWN_MS = 5000;
  const PUSH_QUESTION_DEBOUNCE_MS = 500;
  const PUSH_PERMISSION_DEBOUNCE_MS = 500;
  // Soft cap so a long-running server with churn doesn't grow this set
  // without bound. The set's only purpose is to dedupe notifications for
  // recently-seen permission requests; oldest entries fall off first.
  const NOTIFIED_PERMISSION_REQUESTS_MAX = 1024;
  const pushQuestionDebounceTimers = new Map();
  const pushPermissionDebounceTimers = new Map();
  // Map insertion order = LRU. Trim oldest when the cap is exceeded.
  const notifiedPermissionRequests = new Set();
  const lastReadyNotificationAt = new Map();
  const sessionStatusById = new Map();
  const sessionStatusEventOrderById = new Map();
  const completionCandidatesBySessionId = new Map();
  const sessionsWithIncompleteTodos = new Set();
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
    lastReadyNotificationAt.delete(sessionId);
    sessionStatusById.delete(sessionId);
    sessionStatusEventOrderById.delete(sessionId);
    completionCandidatesBySessionId.delete(sessionId);
    sessionsWithIncompleteTodos.delete(sessionId);
    sessionParentIdCache.delete(sessionId);
    autoAcceptingSessions.delete(sessionId);
    const prefix = `${sessionId}:`;
    for (const key of notifiedPermissionRequests) {
      if (key.startsWith(prefix)) {
        notifiedPermissionRequests.delete(key);
      }
    }
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
    const sessionId = extractSessionIdFromPayload(payload);
    if (typeof sessionId !== 'string' || sessionId.length === 0) return;
    const parentID = getParentIdFromPayload(payload);
    setCachedSessionParentId(sessionId, parentID);
  };

  const readSessionParentIdFromResponse = (data) => {
    if (!data || typeof data !== 'object') return undefined;
    return readParentIdFromSessionInfo(data);
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

  const sendCompletionNotification = async ({ payload, sessionId }) => {
    const info = payload.properties?.info;
    const settings = await readSettingsFromDisk();

    if (settings.notifyOnSubtasks === false) {
      const parentIDFromPayload = getParentIdFromPayload(payload);
      const parentID = parentIDFromPayload !== undefined
        ? parentIDFromPayload
        : await fetchSessionParentId(sessionId);

      if (parentID) {
        return;
      }
    }

    if (settings.notifyOnCompletion === false) {
      return;
    }

    if (shouldSkipForFocusedWindow(settings)) {
      return;
    }

    const now = Date.now();
    const lastAt = lastReadyNotificationAt.get(sessionId) ?? 0;
    if (now - lastAt < PUSH_READY_COOLDOWN_MS) {
      return;
    }
    lastReadyNotificationAt.set(sessionId, now);

    let title = `${formatMode(info?.mode)} agent is ready`;
    let body = `${formatModelId(info?.modelID)} completed the task`;

    try {
      const templates = settings.notificationTemplates || {};
      const isSubtask = await fetchSessionParentId(sessionId);
      const completionTemplate = isSubtask && settings.notifyOnSubtasks !== false
        ? (templates.subtask || templates.completion || { title: '{agent_name} is ready', message: '{model_name} completed the task' })
        : (templates.completion || { title: '{agent_name} is ready', message: '{model_name} completed the task' });

      const variables = await buildTemplateVariables(payload, sessionId);

      const messageId = info?.id;
      let lastMessage = extractLastMessageText(payload);
      if (!lastMessage) {
        lastMessage = await fetchLastAssistantMessageText(sessionId, messageId);
      }

      const notifZenModel = await resolveZenModel(settings?.zenModel);
      variables.last_message = await prepareNotificationLastMessage({
        message: lastMessage,
        settings,
        summarize: (text, len) => summarizeText(text, len, notifZenModel),
      });

      const resolvedTitle = resolveNotificationTemplate(completionTemplate.title, variables);
      const resolvedBody = resolveNotificationTemplate(completionTemplate.message, variables);
      if (resolvedTitle) title = resolvedTitle;
      if (shouldApplyResolvedTemplateMessage(completionTemplate.message, resolvedBody, variables)) body = resolvedBody;
    } catch (error) {
      console.warn('[Notification] Template resolution failed, using defaults:', error?.message || error);
    }

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
    }

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
  };

  const maybeSendPendingCompletionForIdleSession = async (sessionId) => {
    if (
      !sessionId
      || sessionStatusById.get(sessionId) !== 'idle'
      || sessionsWithIncompleteTodos.has(sessionId)
    ) {
      return;
    }

    const candidate = completionCandidatesBySessionId.get(sessionId);
    if (!candidate) {
      return;
    }

    const statusEventOrder = sessionStatusEventOrderById.get(sessionId) ?? 0;
    if (statusEventOrder <= candidate.eventOrder) {
      return;
    }

    completionCandidatesBySessionId.delete(sessionId);
    await sendCompletionNotification(candidate);
  };

  const maybeSendPushForTrigger = async (payload) => {
    if (!payload || typeof payload !== 'object') {
      return;
    }

    triggerEventOrder += 1;
    maybeCacheSessionParentFromPayload(payload);

    const sessionId = extractSessionIdFromPayload(payload);
    if (payload.type === 'session.deleted' && sessionId) {
      forgetSession(sessionId);
      return;
    }
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
        completionCandidatesBySessionId.delete(sessionId);
      } else {
        sessionsWithIncompleteTodos.delete(sessionId);
      }
      return;
    }
    if (payload.type === 'session.status' && sessionId) {
      const status = getSessionStatusFromPayload(payload);
      if (status) {
        sessionStatusById.set(sessionId, status);
        sessionStatusEventOrderById.set(sessionId, triggerEventOrder);
        if (status === 'idle') {
          await maybeSendPendingCompletionForIdleSession(sessionId);
        }
      }
      return;
    }

    if (payload.type === 'message.updated') {
      const info = payload.properties?.info;
      if (
        sessionId
        && !sessionsWithIncompleteTodos.has(sessionId)
        && isCompletedAssistantMessage(payload)
      ) {
        completionCandidatesBySessionId.set(sessionId, { payload, sessionId, eventOrder: triggerEventOrder });
        await maybeSendPendingCompletionForIdleSession(sessionId);
      }

      if (info?.role === 'assistant' && info?.finish === 'error' && sessionId) {
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

          const errZenModel = await resolveZenModel(settings?.zenModel);
          variables.last_message = await prepareNotificationLastMessage({
            message: lastMessage,
            settings,
            summarize: (text, len) => summarizeText(text, len, errZenModel),
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
      const existingTimer = pushQuestionDebounceTimers.get(sessionId);
      if (existingTimer) {
        clearTimeout(existingTimer);
      }

      const timer = setTimeout(async () => {
        pushQuestionDebounceTimers.delete(sessionId);

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

    if (payload.type === 'permission.replied' && sessionId) {
      const requestId = payload.properties?.requestID ?? payload.properties?.requestId ?? payload.properties?.id;
      const requestKey = typeof requestId === 'string' ? `${sessionId}:${requestId}` : null;
      const pendingNotification = pushPermissionDebounceTimers.get(sessionId);
      if (!pendingNotification) {
        return;
      }

      // Some runtimes may omit requestID on permission.replied.
      // When request ID is missing, clear session debounce to avoid
      // showing stale permission notifications for auto-approved prompts.
      if (!requestKey || !pendingNotification.requestKey || pendingNotification.requestKey === requestKey) {
        clearTimeout(pendingNotification.timer);
        pushPermissionDebounceTimers.delete(sessionId);
      }
      return;
    }

    if (payload.type === 'permission.asked' && sessionId) {
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

  return {
    maybeSendPushForTrigger,
    setAutoAcceptSession,
    setGetIsWindowFocused,
    forgetSession,
  };
};
