const AUTO_CONTINUE_DELAY_MS = 250;
const MAX_AUTO_CONTINUATIONS_PER_TASK_SET = 12;
const MAX_STAGNANT_CONTINUATIONS = 2;
const INCOMPLETE_TODO_STATUSES = new Set(['pending', 'in_progress']);
const BUILDER_AGENT_NAMES = new Set(['build', 'builder']);

const CONTINUATION_PROMPT = [
  'Your previous response stopped while Builder still has incomplete todos.',
  'Continue now from the first pending or in-progress todo. Preserve the existing todo order and total.',
  'Do not summarize or produce a completion response until every actionable todo is completed and verification has run.',
  'If you are genuinely blocked after reasonable attempts, state the exact blocker and leave the affected todo incomplete instead of claiming completion.',
].join(' ');

const normalizeText = (value) => (typeof value === 'string' ? value.trim() : '');

const normalizeStatus = (value) => normalizeText(value).toLowerCase().replaceAll(' ', '_');

const isIncompleteTodo = (todo) => (
  todo
  && typeof todo === 'object'
  && INCOMPLETE_TODO_STATUSES.has(normalizeStatus(todo.status))
);

const hasIncompleteTodos = (todos) => Array.isArray(todos) && todos.some(isIncompleteTodo);

const getAgentName = (info) => {
  const direct = normalizeText(info?.agent).toLowerCase();
  if (direct) return direct;
  return normalizeText(info?.mode).toLowerCase();
};

const isSuccessfulBuilderCompletion = (info) => {
  if (!info || info.role !== 'assistant' || !BUILDER_AGENT_NAMES.has(getAgentName(info))) {
    return false;
  }
  if (info.error) return false;

  const finish = normalizeText(info.finish).toLowerCase();
  if (finish && finish !== 'stop') return false;
  if (finish === 'stop') return true;

  const status = normalizeStatus(info.status);
  const completedAt = info.time?.completed;
  return status === 'complete'
    || status === 'completed'
    || status === 'done'
    || (typeof completedAt === 'number' && Number.isFinite(completedAt) && completedAt > 0);
};

const todoTaskSetSignature = (todos) => JSON.stringify((Array.isArray(todos) ? todos : []).map((todo) => ({
  content: normalizeText(todo?.content),
  priority: normalizeStatus(todo?.priority),
})));

const todoProgressSignature = (todos) => JSON.stringify((Array.isArray(todos) ? todos : []).map((todo) => ({
  content: normalizeText(todo?.content),
  status: normalizeStatus(todo?.status),
})));

const continuationModel = (info) => {
  const providerID = normalizeText(info?.providerID || info?.model?.providerID);
  const modelID = normalizeText(info?.modelID || info?.model?.modelID);
  return providerID && modelID ? { providerID, modelID } : null;
};

export const DevRyanBuilderTodoContinuationPlugin = async ({ client, directory } = {}) => {
  const sessions = new Map();

  const getSession = (sessionID) => {
    let state = sessions.get(sessionID);
    if (!state) {
      state = {
        autoContinuationCount: 0,
        awaitingSyntheticUserMessage: false,
        idle: false,
        inFlight: false,
        lastHandledCompletionID: null,
        lastResumeProgressSignature: null,
        latestCompletion: null,
        stagnantContinuationCount: 0,
        taskSetSignature: null,
        timer: null,
        todosUpdatedForCurrentRequest: false,
        todos: [],
      };
      sessions.set(sessionID, state);
    }
    return state;
  };

  const clearTimer = (state) => {
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
  };

  const log = (event, details) => {
    console.error(JSON.stringify({
      plugin: 'devryan-builder-todo-continuation',
      event,
      ...details,
    }));
  };

  const requestContinuation = async (sessionID, state) => {
    state.timer = null;
    const completion = state.latestCompletion;
    if (
      !completion
      || !state.idle
      || state.inFlight
      || !hasIncompleteTodos(state.todos)
      || !state.todosUpdatedForCurrentRequest
      || completion.id === state.lastHandledCompletionID
    ) {
      return;
    }

    const progressSignature = todoProgressSignature(state.todos);
    const sameProgress = state.lastResumeProgressSignature === progressSignature;
    const nextStagnantCount = sameProgress ? state.stagnantContinuationCount + 1 : 0;
    if (
      state.autoContinuationCount >= MAX_AUTO_CONTINUATIONS_PER_TASK_SET
      || nextStagnantCount >= MAX_STAGNANT_CONTINUATIONS
    ) {
      state.lastHandledCompletionID = completion.id;
      log('continuation-cap-reached', {
        sessionID,
        autoContinuationCount: state.autoContinuationCount,
        stagnantContinuationCount: nextStagnantCount,
      });
      return;
    }

    state.inFlight = true;
    state.awaitingSyntheticUserMessage = true;
    state.lastHandledCompletionID = completion.id;
    state.lastResumeProgressSignature = progressSignature;
    state.stagnantContinuationCount = nextStagnantCount;
    state.autoContinuationCount += 1;

    const model = continuationModel(completion.info);
    const variant = normalizeText(completion.info?.variant);
    try {
      const result = await client?.session?.promptAsync?.({
        path: { id: sessionID },
        ...(normalizeText(directory) ? { query: { directory: normalizeText(directory) } } : {}),
        body: {
          agent: 'builder',
          ...(model ? { model } : {}),
          ...(variant ? { variant } : {}),
          parts: [{ type: 'text', text: CONTINUATION_PROMPT, synthetic: true }],
        },
      }, { throwOnError: false });
      if (result?.error) {
        const message = normalizeText(result.error?.message) || 'promptAsync returned an error';
        throw new Error(message);
      }
      state.idle = false;
      state.latestCompletion = null;
      log('continued-incomplete-todos', {
        sessionID,
        autoContinuationCount: state.autoContinuationCount,
      });
    } catch (error) {
      state.awaitingSyntheticUserMessage = false;
      state.lastHandledCompletionID = null;
      log('continuation-failed', {
        sessionID,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      state.inFlight = false;
    }
  };

  const scheduleContinuation = (sessionID, state) => {
    if (
      state.timer
      || state.inFlight
      || !state.idle
      || !state.latestCompletion
      || !hasIncompleteTodos(state.todos)
      || !state.todosUpdatedForCurrentRequest
      || state.latestCompletion.id === state.lastHandledCompletionID
    ) {
      return;
    }
    state.timer = setTimeout(() => {
      void requestContinuation(sessionID, state);
    }, AUTO_CONTINUE_DELAY_MS);
    state.timer.unref?.();
  };

  const handleTodoUpdated = (event) => {
    const sessionID = normalizeText(event?.properties?.sessionID);
    if (!sessionID) return;
    const state = getSession(sessionID);
    const todos = Array.isArray(event.properties?.todos) ? event.properties.todos : [];
    const nextTaskSetSignature = todoTaskSetSignature(todos);
    if (state.taskSetSignature !== nextTaskSetSignature) {
      state.autoContinuationCount = 0;
      state.lastResumeProgressSignature = null;
      state.stagnantContinuationCount = 0;
      state.taskSetSignature = nextTaskSetSignature;
    }
    state.todos = todos;
    state.todosUpdatedForCurrentRequest = true;

    if (!hasIncompleteTodos(todos)) {
      clearTimer(state);
      state.autoContinuationCount = 0;
      state.lastResumeProgressSignature = null;
      state.latestCompletion = null;
      state.stagnantContinuationCount = 0;
      return;
    }
    scheduleContinuation(sessionID, state);
  };

  const handleMessageUpdated = (event) => {
    const info = event?.properties?.info;
    const sessionID = normalizeText(info?.sessionID);
    if (!sessionID) return;
    const state = getSession(sessionID);
    if (info?.role === 'user') {
      clearTimer(state);
      state.idle = false;
      state.latestCompletion = null;
      if (state.awaitingSyntheticUserMessage) {
        state.awaitingSyntheticUserMessage = false;
      } else {
        state.todosUpdatedForCurrentRequest = false;
      }
      return;
    }
    if (isSuccessfulBuilderCompletion(info)) {
      state.latestCompletion = { id: normalizeText(info.id), info };
      scheduleContinuation(sessionID, state);
      return;
    }
    if (info?.role === 'assistant' && BUILDER_AGENT_NAMES.has(getAgentName(info))) {
      clearTimer(state);
      state.latestCompletion = null;
    }
  };

  const handleStatus = (event) => {
    const sessionID = normalizeText(event?.properties?.sessionID);
    if (!sessionID) return;
    const state = getSession(sessionID);
    const status = normalizeStatus(event.properties?.status?.type || event.properties?.info?.type);
    state.idle = status === 'idle';
    if (!state.idle) {
      clearTimer(state);
      return;
    }
    scheduleContinuation(sessionID, state);
  };

  const handleIdle = (event) => {
    const sessionID = normalizeText(event?.properties?.sessionID);
    if (!sessionID) return;
    const state = getSession(sessionID);
    state.idle = true;
    scheduleContinuation(sessionID, state);
  };

  const handleError = (event) => {
    const sessionID = normalizeText(event?.properties?.sessionID);
    if (!sessionID) return;
    const state = getSession(sessionID);
    clearTimer(state);
    state.idle = true;
    state.latestCompletion = null;
  };

  const handleDeleted = (event) => {
    const sessionID = normalizeText(event?.properties?.sessionID || event?.properties?.info?.id);
    if (!sessionID) return;
    const state = sessions.get(sessionID);
    if (state) clearTimer(state);
    sessions.delete(sessionID);
  };

  return {
    event: async ({ event } = {}) => {
      switch (event?.type) {
        case 'todo.updated':
          handleTodoUpdated(event);
          break;
        case 'message.updated':
          handleMessageUpdated(event);
          break;
        case 'session.status':
          handleStatus(event);
          break;
        case 'session.idle':
          handleIdle(event);
          break;
        case 'session.error':
          handleError(event);
          break;
        case 'session.deleted':
          handleDeleted(event);
          break;
      }
    },
  };
};

export default DevRyanBuilderTodoContinuationPlugin;
