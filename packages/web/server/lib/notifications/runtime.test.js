import { afterEach, describe, expect, it, vi } from 'vitest';

import { createNotificationTriggerRuntime } from './runtime.js';

const createCompletionPayload = (overrides = {}) => ({
  type: 'message.updated',
  properties: {
    info: {
      id: 'msg_1',
      sessionID: 'ses_1',
      role: 'assistant',
      finish: 'stop',
      mode: 'build',
      modelID: 'gpt-5-nano',
      time: { completed: Date.now() },
      parts: [{ type: 'text', text: 'Done' }],
      ...overrides.info,
    },
    ...overrides.properties,
  },
});

const createStatusPayload = (type) => ({
  type: 'session.status',
  properties: {
    sessionID: 'ses_1',
    status: { type },
  },
});

const createTodoPayload = (statuses) => ({
  type: 'todo.updated',
  properties: {
    sessionID: 'ses_1',
    todos: statuses.map((status, index) => ({
      content: `Task ${index + 1}`,
      priority: 'medium',
      status,
    })),
  },
});

const createSessionPayload = (parentID) => ({
  type: 'session.created',
  properties: {
    info: {
      id: 'ses_1',
      parentID,
    },
  },
});

const createRuntime = (settings = {}, options = {}) => {
  const calls = {
    desktop: [],
    ui: [],
    push: [],
  };

  const mocks = {
    readSettingsFromDisk: vi.fn(async () => ({
      nativeNotificationsEnabled: true,
      notificationMode: 'always',
      notifyOnCompletion: true,
      notifyOnSubtasks: true,
      ...settings,
      notificationTemplates: {
        completion: { title: '{agent_name} is ready', message: '{model_name} completed the task' },
        ...settings.notificationTemplates,
      },
    })),
    prepareNotificationLastMessage: vi.fn(async ({ message }) => message),
    summarizeText: vi.fn(async (text) => text),
    resolveZenModel: vi.fn(async () => 'gpt-5-nano'),
    buildTemplateVariables: vi.fn(async (_payload, sessionId) => ({
      project_name: 'Project',
      worktree: '/tmp/project',
      branch: 'main',
      session_name: 'Session title',
      agent_name: 'Build',
      model_name: 'Gpt 5 Nano',
      last_message: '',
      session_id: sessionId,
    })),
    extractLastMessageText: vi.fn(() => 'Done'),
    fetchLastAssistantMessageText: vi.fn(async () => 'Done'),
    resolveNotificationTemplate: vi.fn((template, variables) => template.replace(/\{(\w+)\}/g, (_match, key) => variables[key] ?? '')),
    shouldApplyResolvedTemplateMessage: vi.fn(() => true),
    emitDesktopNotification: vi.fn((payload) => calls.desktop.push(payload)),
    broadcastUiNotification: vi.fn((payload) => calls.ui.push(payload)),
    sendPushToAllUiSessions: vi.fn(async (payload) => calls.push.push(payload)),
    getIsWindowFocused: options.getIsWindowFocused,
  };

  const runtime = createNotificationTriggerRuntime({
    readSettingsFromDisk: mocks.readSettingsFromDisk,
    prepareNotificationLastMessage: mocks.prepareNotificationLastMessage,
    summarizeText: mocks.summarizeText,
    resolveZenModel: mocks.resolveZenModel,
    buildTemplateVariables: mocks.buildTemplateVariables,
    extractLastMessageText: mocks.extractLastMessageText,
    fetchLastAssistantMessageText: mocks.fetchLastAssistantMessageText,
    resolveNotificationTemplate: mocks.resolveNotificationTemplate,
    shouldApplyResolvedTemplateMessage: mocks.shouldApplyResolvedTemplateMessage,
    emitDesktopNotification: mocks.emitDesktopNotification,
    broadcastUiNotification: mocks.broadcastUiNotification,
    sendPushToAllUiSessions: mocks.sendPushToAllUiSessions,
    buildOpenCodeUrl: (path) => path,
    getOpenCodeAuthHeaders: () => ({}),
    ...(mocks.getIsWindowFocused ? { getIsWindowFocused: mocks.getIsWindowFocused } : {}),
  });

  return { runtime, calls, mocks };
};

const completeSession = async (runtime) => {
  await runtime.maybeSendPushForTrigger(createStatusPayload('busy'));
  await runtime.maybeSendPushForTrigger(createCompletionPayload());
  await runtime.maybeSendPushForTrigger(createStatusPayload('idle'));
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('notification trigger runtime completion gating', () => {
  it('waits for session idle before sending a completion notification', async () => {
    const { runtime, calls } = createRuntime();

    await runtime.maybeSendPushForTrigger(createStatusPayload('busy'));
    await runtime.maybeSendPushForTrigger(createCompletionPayload());

    expect(calls.desktop).toHaveLength(0);
    expect(calls.push).toHaveLength(0);

    await runtime.maybeSendPushForTrigger(createStatusPayload('idle'));

    expect(calls.desktop).toHaveLength(1);
    expect(calls.ui).toHaveLength(1);
    expect(calls.push).toHaveLength(1);
    expect(calls.desktop[0]).toMatchObject({ kind: 'ready', sessionId: 'ses_1' });
  });

  it('does not send completion notifications for active reasoning messages', async () => {
    const { runtime, calls } = createRuntime();

    await runtime.maybeSendPushForTrigger(createStatusPayload('busy'));
    await runtime.maybeSendPushForTrigger(createCompletionPayload({
      info: {
        parts: [{ type: 'reasoning', text: 'Thinking' }],
      },
    }));
    await runtime.maybeSendPushForTrigger(createStatusPayload('idle'));

    expect(calls.desktop).toHaveLength(0);
    expect(calls.push).toHaveLength(0);
  });

  it('does not notify at 3/5 and waits for a later 5/5 Builder completion', async () => {
    const { runtime, calls } = createRuntime();

    await runtime.maybeSendPushForTrigger(createStatusPayload('busy'));
    await runtime.maybeSendPushForTrigger(createTodoPayload([
      'completed',
      'completed',
      'completed',
      'in_progress',
      'pending',
    ]));
    await runtime.maybeSendPushForTrigger(createCompletionPayload());
    await runtime.maybeSendPushForTrigger(createStatusPayload('idle'));

    expect(calls.desktop).toHaveLength(0);
    expect(calls.ui).toHaveLength(0);
    expect(calls.push).toHaveLength(0);

    await runtime.maybeSendPushForTrigger(createStatusPayload('busy'));
    await runtime.maybeSendPushForTrigger(createTodoPayload([
      'completed',
      'completed',
      'completed',
      'completed',
      'completed',
    ]));
    await runtime.maybeSendPushForTrigger(createCompletionPayload({ info: { id: 'msg_2' } }));
    await runtime.maybeSendPushForTrigger(createStatusPayload('idle'));

    expect(calls.desktop).toHaveLength(1);
    expect(calls.ui).toHaveLength(1);
    expect(calls.push).toHaveLength(1);
  });

  it('does not send subtask completion notifications when subtask notifications are disabled', async () => {
    const { runtime, calls } = createRuntime({ notifyOnSubtasks: false });

    await runtime.maybeSendPushForTrigger(createSessionPayload('parent_1'));
    await completeSession(runtime);

    expect(calls.desktop).toHaveLength(0);
    expect(calls.ui).toHaveLength(0);
    expect(calls.push).toHaveLength(0);
  });

  it('still sends top-level completion notifications when only subtask notifications are disabled', async () => {
    const { runtime, calls } = createRuntime({ notifyOnSubtasks: false });

    await runtime.maybeSendPushForTrigger(createSessionPayload(null));
    await completeSession(runtime);

    expect(calls.desktop).toHaveLength(1);
    expect(calls.ui).toHaveLength(1);
    expect(calls.push).toHaveLength(1);
    expect(calls.desktop[0]).toMatchObject({ kind: 'ready', sessionId: 'ses_1' });
  });

  it('does not send completion notifications when completion notifications are disabled', async () => {
    const { runtime, calls } = createRuntime({ notifyOnCompletion: false });

    await completeSession(runtime);

    expect(calls.desktop).toHaveLength(0);
    expect(calls.ui).toHaveLength(0);
    expect(calls.push).toHaveLength(0);
  });

  it('skips hidden-only completion notifications before template work when the window is focused', async () => {
    const { runtime, calls, mocks } = createRuntime(
      { notificationMode: 'hidden-only' },
      { getIsWindowFocused: () => true },
    );

    await completeSession(runtime);

    expect(calls.desktop).toHaveLength(0);
    expect(calls.ui).toHaveLength(0);
    expect(calls.push).toHaveLength(0);
    expect(mocks.buildTemplateVariables).not.toHaveBeenCalled();
    expect(mocks.prepareNotificationLastMessage).not.toHaveBeenCalled();
    expect(mocks.summarizeText).not.toHaveBeenCalled();
  });

  it('still sends always-mode completion notifications while the window is focused', async () => {
    const { runtime, calls, mocks } = createRuntime(
      { notificationMode: 'always' },
      { getIsWindowFocused: () => true },
    );

    await completeSession(runtime);

    expect(calls.desktop).toHaveLength(1);
    expect(calls.ui).toHaveLength(1);
    expect(calls.push).toHaveLength(1);
    expect(mocks.buildTemplateVariables).toHaveBeenCalledOnce();
  });

  it('uses fetched session metadata to suppress subtask completions when the message payload omits parentID', async () => {
    const fetchMock = vi.fn(async (url) => {
      if (String(url).endsWith('/session/ses_1')) {
        return Response.json({ id: 'ses_1', parentID: 'parent_1' });
      }
      return Response.json([]);
    });
    vi.stubGlobal('fetch', fetchMock);
    const { runtime, calls } = createRuntime({ notifyOnSubtasks: false });

    await completeSession(runtime);

    expect(fetchMock).toHaveBeenCalledWith('/session/ses_1', expect.objectContaining({ method: 'GET' }));
    expect(calls.desktop).toHaveLength(0);
    expect(calls.ui).toHaveLength(0);
    expect(calls.push).toHaveLength(0);
  });
});
