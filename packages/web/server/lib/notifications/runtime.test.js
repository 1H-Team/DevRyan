import { afterEach, describe, expect, it, vi } from 'vitest';

import { createNotificationTriggerRuntime } from './runtime.js';
import { createNotificationTemplateRuntime } from './template-runtime.js';

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
      title: 'Session title',
      parentID,
    },
  },
});

const createPartPayload = ({
  messageId,
  partId,
  type = 'text',
  text = '',
  state,
}) => ({
  type: 'message.part.updated',
  properties: {
    sessionID: 'ses_1',
    part: {
      id: partId || `${messageId}-${type}`,
      messageID: messageId,
      sessionID: 'ses_1',
      type,
      ...(type === 'tool' ? { state } : { text }),
    },
  },
});

const createPlanMessages = ({ sourceMessageId = 'msg_1', planText } = {}) => {
  const resolvedPlanText = planText || [
    '# Plan Ready Notification',
    '',
    '## Implementation',
    '',
    '- Add the event.',
    '',
    '## Verification',
    '',
    '- Test the alert.',
  ].join('\n');
  return [
    {
      info: {
        id: 'user_plan_1',
        sessionID: 'ses_1',
        role: 'user',
        mode: 'plan',
        time: { created: 1 },
      },
      parts: [{ type: 'text', text: 'Make a plan' }],
    },
    {
      info: {
        id: sourceMessageId,
        parentID: 'user_plan_1',
        sessionID: 'ses_1',
        role: 'assistant',
        finish: 'stop',
        time: { created: 2, completed: 3 },
      },
      parts: [{ type: 'text', text: resolvedPlanText }],
    },
  ];
};

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
      notifyOnPlanReady: true,
      notifyOnSubtasks: true,
      ...settings,
      notificationTemplates: {
        completion: { title: 'Session complete', message: '{session_name} is ready to review' },
        planReady: { title: 'Plan ready', message: 'A plan is ready for review' },
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
    fetchSessionMessages: vi.fn(async () => options.messages || [
      {
        info: { id: 'user_1', sessionID: 'ses_1', role: 'user', time: { created: 1 } },
        parts: [{ type: 'text', text: 'Do the task' }],
      },
      {
        info: {
          id: 'msg_1',
          parentID: 'user_1',
          sessionID: 'ses_1',
          role: 'assistant',
          finish: 'stop',
          time: { created: 2, completed: 3 },
        },
        parts: [{ type: 'text', text: 'Done' }],
      },
    ]),
    fetchSessionInfo: vi.fn(async () => (
      Object.prototype.hasOwnProperty.call(options, 'sessionInfo')
        ? options.sessionInfo
        : { id: 'ses_1', title: 'Session title' }
    )),
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
    fetchSessionMessages: mocks.fetchSessionMessages,
    fetchSessionInfo: mocks.fetchSessionInfo,
    fetchLastAssistantMessageText: mocks.fetchLastAssistantMessageText,
    resolveNotificationTemplate: mocks.resolveNotificationTemplate,
    shouldApplyResolvedTemplateMessage: mocks.shouldApplyResolvedTemplateMessage,
    emitDesktopNotification: mocks.emitDesktopNotification,
    broadcastUiNotification: mocks.broadcastUiNotification,
    sendPushToAllUiSessions: mocks.sendPushToAllUiSessions,
    buildOpenCodeUrl: (path) => path,
    getOpenCodeAuthHeaders: () => ({}),
    completionSettleMs: options.completionSettleMs ?? 0,
    ...(mocks.getIsWindowFocused ? { getIsWindowFocused: mocks.getIsWindowFocused } : {}),
  });

  return { runtime, calls, mocks };
};

const completeSession = async (runtime) => {
  await runtime.maybeSendPushForTrigger(createStatusPayload('busy'));
  await runtime.maybeSendPushForTrigger(createCompletionPayload());
  await runtime.maybeSendPushForTrigger(createStatusPayload('idle'));
};

const primePlanMode = async (runtime, userMessageId = 'user_plan_1') => {
  await runtime.maybeSendPushForTrigger(createPartPayload({
    messageId: userMessageId,
    partId: `${userMessageId}-instruction`,
    text: 'User has requested to enter plan mode. Produce an implementation plan only.',
  }));
};

const completePlanSession = async (runtime, {
  userMessageId = 'user_plan_1',
  sourceMessageId = 'msg_1',
  planText,
} = {}) => {
  const resolvedPlanText = planText || createPlanMessages({ sourceMessageId }).at(-1).parts[0].text;
  await runtime.maybeSendPushForTrigger(createStatusPayload('busy'));
  await primePlanMode(runtime, userMessageId);
  await runtime.maybeSendPushForTrigger(createPartPayload({
    messageId: sourceMessageId,
    partId: `${sourceMessageId}-text`,
    text: `<!--plan-->\n${resolvedPlanText}`,
  }));
  await runtime.maybeSendPushForTrigger(createCompletionPayload({
    info: { id: sourceMessageId, parentID: userMessageId },
  }));
  await runtime.maybeSendPushForTrigger(createStatusPayload('idle'));
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
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

  it('waits for 500ms of stable idle so the green completion indicator settles first', async () => {
    vi.useFakeTimers();
    const { runtime, calls } = createRuntime({}, { completionSettleMs: 500 });

    await runtime.maybeSendPushForTrigger(createStatusPayload('busy'));
    await runtime.maybeSendPushForTrigger(createCompletionPayload());
    await runtime.maybeSendPushForTrigger(createStatusPayload('idle'));

    await vi.advanceTimersByTimeAsync(499);
    expect(calls.desktop).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(calls.desktop).toHaveLength(1);
  });

  it('cancels unstable idle settlement and waits for the next authoritative idle edge', async () => {
    vi.useFakeTimers();
    const { runtime, calls } = createRuntime({}, { completionSettleMs: 500 });

    await runtime.maybeSendPushForTrigger(createStatusPayload('busy'));
    await runtime.maybeSendPushForTrigger(createCompletionPayload());
    await runtime.maybeSendPushForTrigger(createStatusPayload('idle'));
    await vi.advanceTimersByTimeAsync(250);
    await runtime.maybeSendPushForTrigger(createStatusPayload('busy'));
    await vi.advanceTimersByTimeAsync(500);
    expect(calls.desktop).toHaveLength(0);

    await runtime.maybeSendPushForTrigger(createStatusPayload('idle'));
    await vi.advanceTimersByTimeAsync(500);
    expect(calls.desktop).toHaveLength(1);
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

  it('retains a completed candidate until incomplete todos clear', async () => {
    const { runtime, calls } = createRuntime();

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

    await runtime.maybeSendPushForTrigger(createTodoPayload([
      'completed',
      'completed',
      'completed',
      'completed',
      'completed',
    ]));

    expect(calls.desktop).toHaveLength(1);
    expect(calls.ui).toHaveLength(1);
    expect(calls.push).toHaveLength(1);
  });

  it('does not send subtask completion notifications when subtask notifications are disabled', async () => {
    const { runtime, calls } = createRuntime(
      { notifyOnSubtasks: false },
      { sessionInfo: { id: 'ses_1', title: 'Child session', parentID: 'parent_1' } },
    );

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

  it('notifies once for each later user work cycle in the same visible session', async () => {
    const { runtime, calls } = createRuntime();

    await completeSession(runtime);
    await runtime.maybeSendPushForTrigger(createStatusPayload('busy'));
    await runtime.maybeSendPushForTrigger(createCompletionPayload({
      info: { id: 'msg_2', parentID: 'user_2' },
    }));
    await runtime.maybeSendPushForTrigger(createStatusPayload('idle'));

    expect(calls.desktop).toHaveLength(2);
    expect(calls.ui).toHaveLength(2);
    expect(calls.push).toHaveLength(2);
  });

  it.each([
    'smartfetch-secondary',
    'Commit generation workflow',
    'DevRyan title generation (internal)',
  ])(
    'suppresses completion delivery for the hidden helper session %s',
    async (title) => {
      const { runtime, calls, mocks } = createRuntime({}, {
        sessionInfo: { id: 'ses_1', title },
      });

      await completeSession(runtime);

      expect(calls.desktop).toHaveLength(0);
      expect(calls.ui).toHaveLength(0);
      expect(calls.push).toHaveLength(0);
      expect(mocks.readSettingsFromDisk).not.toHaveBeenCalled();
      expect(mocks.buildTemplateVariables).not.toHaveBeenCalled();
    },
  );

  it('suppresses hidden helper errors and questions as user-facing notifications', async () => {
    vi.useFakeTimers();
    const { runtime, calls } = createRuntime({}, {
      sessionInfo: { id: 'ses_1', title: 'smartfetch-secondary' },
    });

    await runtime.maybeSendPushForTrigger(createCompletionPayload({
      info: { finish: 'error' },
    }));
    await runtime.maybeSendPushForTrigger({
      type: 'question.asked',
      properties: {
        sessionID: 'ses_1',
        questions: [{ header: 'Hidden question', question: 'Should not appear' }],
      },
    });
    await vi.advanceTimersByTimeAsync(500);

    expect(calls.desktop).toHaveLength(0);
    expect(calls.ui).toHaveLength(0);
    expect(calls.push).toHaveLength(0);
  });

  it('suppresses a completion candidate after three unresolved metadata retries', async () => {
    vi.useFakeTimers();
    const { runtime, calls, mocks } = createRuntime();
    mocks.fetchSessionInfo.mockResolvedValue(null);

    await completeSession(runtime);
    await vi.advanceTimersByTimeAsync(250);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(3000);

    mocks.fetchSessionInfo.mockResolvedValue({ id: 'ses_1', title: 'Visible session' });
    await runtime.maybeSendPushForTrigger(createStatusPayload('idle'));

    expect(mocks.fetchSessionInfo).toHaveBeenCalledTimes(4);
    expect(calls.desktop).toHaveLength(0);
    expect(calls.ui).toHaveLength(0);
    expect(calls.push).toHaveLength(0);
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

  it('does not fetch plan history or resolve a Zen model for an ordinary unsummarized completion', async () => {
    const { runtime, calls, mocks } = createRuntime({ summarizeLastMessage: false });

    await completeSession(runtime);

    expect(calls.desktop).toHaveLength(1);
    expect(mocks.fetchSessionMessages).not.toHaveBeenCalled();
    expect(mocks.resolveZenModel).not.toHaveBeenCalled();
    expect(mocks.summarizeText).not.toHaveBeenCalled();
  });

  it('deduplicates terminal message and busy/idle repeats by assistant message', async () => {
    const { runtime, calls } = createRuntime();

    await runtime.maybeSendPushForTrigger(createStatusPayload('busy'));
    await runtime.maybeSendPushForTrigger(createCompletionPayload());
    await runtime.maybeSendPushForTrigger(createCompletionPayload({
      info: { finish: undefined, status: 'completed' },
    }));
    await runtime.maybeSendPushForTrigger(createStatusPayload('busy'));
    await runtime.maybeSendPushForTrigger(createStatusPayload('idle'));
    await runtime.maybeSendPushForTrigger(createStatusPayload('idle'));
    await runtime.maybeSendPushForTrigger(createCompletionPayload());
    await runtime.maybeSendPushForTrigger(createStatusPayload('idle'));

    expect(calls.desktop).toHaveLength(1);
    expect(calls.ui).toHaveLength(1);
    expect(calls.push).toHaveLength(1);
  });

  it('delivers an enabled subagent completion exactly once', async () => {
    const { runtime, calls } = createRuntime(
      {
        notificationTemplates: {
          subtask: { title: 'Subagent ready', message: 'Subagent finished' },
        },
      },
      { sessionInfo: { id: 'ses_1', title: 'Child session', parentID: 'parent_1' } },
    );

    await runtime.maybeSendPushForTrigger(createSessionPayload('parent_1'));
    await completeSession(runtime);
    await runtime.maybeSendPushForTrigger(createStatusPayload('idle'));

    expect(calls.desktop).toHaveLength(1);
    expect(calls.desktop[0]).toMatchObject({ kind: 'ready', title: 'Subagent ready' });
    expect(calls.ui).toHaveLength(1);
    expect(calls.push).toHaveLength(1);
  });

  it('keeps subagent completion independent from the root session completion toggle', async () => {
    const { runtime, calls } = createRuntime(
      {
        notifyOnCompletion: false,
        notifyOnSubtasks: true,
        notificationTemplates: {
          subtask: { title: 'Subagent ready', message: 'Subagent finished' },
        },
      },
      { sessionInfo: { id: 'ses_1', title: 'Child session', parentID: 'parent_1' } },
    );

    await completeSession(runtime);

    expect(calls.desktop).toHaveLength(1);
    expect(calls.desktop[0]).toMatchObject({ title: 'Subagent ready' });
  });

  it('retries a retained completion after a transient settings failure', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { runtime, calls, mocks } = createRuntime();
    const recoveredSettings = await mocks.readSettingsFromDisk();
    mocks.readSettingsFromDisk
      .mockReset()
      .mockRejectedValueOnce(new Error('settings temporarily unavailable'))
      .mockResolvedValue(recoveredSettings);

    await completeSession(runtime);
    expect(calls.desktop).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(250);

    expect(calls.desktop).toHaveLength(1);
    expect(calls.ui).toHaveLength(1);
    expect(calls.push).toHaveLength(1);
  });

  it('falls back to generic completion when compatibility history fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { runtime, calls, mocks } = createRuntime();
    mocks.fetchSessionMessages.mockRejectedValue(new Error('history unavailable'));

    await runtime.maybeSendPushForTrigger(createStatusPayload('busy'));
    await primePlanMode(runtime);
    await runtime.maybeSendPushForTrigger(createCompletionPayload({
      info: { parentID: 'user_plan_1' },
    }));
    await runtime.maybeSendPushForTrigger(createStatusPayload('idle'));

    expect(calls.desktop).toHaveLength(1);
    expect(calls.desktop[0].kind).toBe('ready');
    expect(calls.ui).toHaveLength(1);
    expect(calls.push).toHaveLength(1);
  });

  it('uses default completion text when template enrichment fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { runtime, calls, mocks } = createRuntime();
    mocks.buildTemplateVariables.mockRejectedValue(new Error('metadata unavailable'));

    await completeSession(runtime);

    expect(calls.desktop).toHaveLength(1);
    expect(calls.desktop[0]).toMatchObject({
      kind: 'ready',
      title: 'Session complete',
      body: 'The requested work is ready to review',
    });
  });

  it('uses fetched session metadata to suppress subtask completions when the message payload omits parentID', async () => {
    const { runtime, calls, mocks } = createRuntime(
      { notifyOnSubtasks: false },
      { sessionInfo: { id: 'ses_1', title: 'Child session', parentID: 'parent_1' } },
    );

    await completeSession(runtime);

    expect(mocks.fetchSessionInfo).toHaveBeenCalledWith('ses_1');
    expect(calls.desktop).toHaveLength(0);
    expect(calls.ui).toHaveLength(0);
    expect(calls.push).toHaveLength(0);
  });

  it('treats a specific session response without parentID as an authoritative root session', async () => {
    const { runtime, calls, mocks } = createRuntime(
      { notifyOnSubtasks: false },
      { sessionInfo: { id: 'ses_1', title: 'Root session' } },
    );

    await completeSession(runtime);

    expect(mocks.fetchSessionInfo).toHaveBeenCalledWith('ses_1');
    expect(calls.desktop).toHaveLength(1);
    expect(calls.ui).toHaveLength(1);
    expect(calls.push).toHaveLength(1);
  });

  it('replaces generic completion with one Plan Ready notification per plan revision', async () => {
    const { runtime, calls, mocks } = createRuntime({}, { messages: createPlanMessages() });

    await completePlanSession(runtime);

    expect(calls.desktop).toHaveLength(1);
    expect(calls.ui).toHaveLength(1);
    expect(calls.push).toHaveLength(1);
    expect(calls.desktop[0]).toMatchObject({
      kind: 'plan-ready',
      title: 'Plan ready',
      body: 'A plan is ready for review',
      sessionId: 'ses_1',
      sourceMessageId: 'msg_1',
    });
    expect(calls.desktop[0].tag).toBe('plan-ready-ses_1-msg_1');
    expect(calls.push[0].data).toMatchObject({ type: 'plan-ready', sourceMessageId: 'msg_1' });

    await completePlanSession(runtime);
    expect(calls.desktop).toHaveLength(1);

    mocks.fetchSessionMessages.mockResolvedValue(createPlanMessages({ sourceMessageId: 'plan_2' }));
    await completePlanSession(runtime, {
      userMessageId: 'user_plan_2',
      sourceMessageId: 'plan_2',
    });
    expect(calls.desktop).toHaveLength(2);
    expect(calls.desktop[1]).toMatchObject({ kind: 'plan-ready', sourceMessageId: 'plan_2' });
  });

  it('keeps Plan Ready separate and sends Session Completion after implementation settles', async () => {
    const { runtime, calls } = createRuntime();

    await completePlanSession(runtime);
    await runtime.maybeSendPushForTrigger(createStatusPayload('busy'));
    await runtime.maybeSendPushForTrigger({
      type: 'message.updated',
      properties: {
        info: {
          id: 'user_implementation_1',
          sessionID: 'ses_1',
          role: 'user',
          time: { created: 4 },
        },
      },
    });
    await runtime.maybeSendPushForTrigger(createCompletionPayload({
      info: {
        id: 'msg_implementation_1',
        parentID: 'user_implementation_1',
      },
    }));
    await runtime.maybeSendPushForTrigger(createStatusPayload('idle'));

    expect(calls.desktop.map((payload) => payload.kind)).toEqual(['plan-ready', 'ready']);
    expect(calls.desktop[1]).toMatchObject({
      title: 'Session complete',
      body: 'Session title is ready to review',
    });
  });

  it('settles the streamed production Plan Ready sequence exactly once', async () => {
    const { runtime, calls } = createRuntime();
    const planText = createPlanMessages().at(-1).parts[0].text;

    await runtime.maybeSendPushForTrigger(createStatusPayload('busy'));
    await primePlanMode(runtime);
    await runtime.maybeSendPushForTrigger(createPartPayload({
      messageId: 'msg_1',
      partId: 'msg_1-plan',
      text: `<!--plan-->\n${planText}`,
    }));
    await runtime.maybeSendPushForTrigger(createCompletionPayload({
      info: { parentID: 'user_plan_1' },
    }));
    await runtime.maybeSendPushForTrigger(createCompletionPayload({
      info: { parentID: 'user_plan_1', finish: undefined, status: 'completed' },
    }));
    await runtime.maybeSendPushForTrigger(createStatusPayload('busy'));
    await runtime.maybeSendPushForTrigger(createStatusPayload('idle'));
    await runtime.maybeSendPushForTrigger(createStatusPayload('idle'));

    expect(calls.desktop).toHaveLength(1);
    expect(calls.desktop[0]).toMatchObject({ kind: 'plan-ready', sourceMessageId: 'msg_1' });
    expect(calls.ui).toHaveLength(1);
    expect(calls.push).toHaveLength(1);
    expect(calls.push[0].data).toMatchObject({ type: 'plan-ready', sourceMessageId: 'msg_1' });
  });

  it('delivers a cached sentinel plan without history or Zen enrichment', async () => {
    const { runtime, calls, mocks } = createRuntime({ summarizeLastMessage: false });
    mocks.fetchSessionMessages.mockRejectedValue(new Error('history timeout'));

    await completePlanSession(runtime);

    expect(calls.desktop).toHaveLength(1);
    expect(calls.desktop[0].kind).toBe('plan-ready');
    expect(mocks.fetchSessionMessages).not.toHaveBeenCalled();
    expect(mocks.resolveZenModel).not.toHaveBeenCalled();
  });

  it('uses default Plan Ready text when template enrichment fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { runtime, calls, mocks } = createRuntime();
    mocks.buildTemplateVariables.mockRejectedValue(new Error('template enrichment unavailable'));

    await completePlanSession(runtime);

    expect(calls.desktop).toHaveLength(1);
    expect(calls.desktop[0]).toMatchObject({
      kind: 'plan-ready',
      title: 'Plan ready',
      body: 'A plan is ready for review',
    });
  });

  it('retries an empty authoritative snapshot until the settled plan message is available', async () => {
    const { runtime, calls, mocks } = createRuntime();
    mocks.fetchSessionMessages
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(createPlanMessages());

    await runtime.maybeSendPushForTrigger(createStatusPayload('busy'));
    await primePlanMode(runtime);
    await runtime.maybeSendPushForTrigger(createCompletionPayload({
      info: { parentID: 'user_plan_1' },
    }));
    await runtime.maybeSendPushForTrigger(createStatusPayload('idle'));

    expect(mocks.fetchSessionMessages).toHaveBeenCalledTimes(3);
    expect(calls.desktop).toHaveLength(1);
    expect(calls.desktop[0]).toMatchObject({
      kind: 'plan-ready',
      title: 'Plan ready',
      body: 'A plan is ready for review',
    });
    expect(calls.push).toHaveLength(1);
  });

  it('notifies for a settled actionable plan even when the update omits finish', async () => {
    const { runtime, calls } = createRuntime({}, { messages: createPlanMessages() });
    await runtime.maybeSendPushForTrigger(createStatusPayload('busy'));
    await primePlanMode(runtime);
    await runtime.maybeSendPushForTrigger(createCompletionPayload({
      info: { finish: undefined, parentID: 'user_plan_1' },
    }));
    await runtime.maybeSendPushForTrigger(createStatusPayload('idle'));

    expect(calls.desktop).toHaveLength(1);
    expect(calls.desktop[0].kind).toBe('plan-ready');
  });

  it('suppresses both Plan Ready and generic completion when Plan Ready is disabled', async () => {
    const { runtime, calls } = createRuntime(
      { notifyOnPlanReady: false, notifyOnCompletion: true },
      { messages: createPlanMessages() },
    );

    await completePlanSession(runtime);

    expect(calls.desktop).toHaveLength(0);
    expect(calls.ui).toHaveLength(0);
    expect(calls.push).toHaveLength(0);
  });

  it('resolves Plan Ready last_message from canonical plan markdown', async () => {
    const planText = [
      '# Canonical Plan',
      '',
      '## Implementation',
      '',
      '- Preserve this content.',
      '',
      '## Verification',
      '',
      '- Confirm it.',
    ].join('\n');
    const { runtime, calls, mocks } = createRuntime(
      { notificationTemplates: { planReady: { title: 'Review {session_name}', message: '{last_message}' } } },
      { messages: createPlanMessages({ planText }) },
    );

    await completePlanSession(runtime, { planText });

    expect(mocks.prepareNotificationLastMessage).toHaveBeenCalledWith(expect.objectContaining({ message: planText }));
    expect(calls.desktop[0]).toMatchObject({ title: 'Review Session title', body: planText });
  });

  it('uses the projected session name in every Plan Ready delivery channel', async () => {
    const placeholder = 'New session - 2026-08-27T00:26:56.854Z';
    const templateRuntime = createNotificationTemplateRuntime({
      readSettingsFromDisk: async () => ({ projects: [] }),
      persistSettings: vi.fn(async () => {}),
      buildOpenCodeUrl: (path) => path,
      getOpenCodeAuthHeaders: () => ({}),
      resolveGitBinaryForSpawn: () => 'git',
    });
    templateRuntime.maybeCacheSessionInfoFromEvent({
      type: 'session.created',
      properties: { info: { id: 'ses_1', title: placeholder, parentID: null } },
    });
    templateRuntime.maybeCacheSessionInfoFromEvent({
      type: 'session.updated',
      properties: { info: { id: 'ses_1', title: 'Reorder clinic professionals section', parentID: null } },
    });
    templateRuntime.maybeCacheSessionInfoFromEvent({
      type: 'session.updated',
      properties: { info: { id: 'ses_1', title: placeholder, parentID: null } },
    });

    const { runtime, calls, mocks } = createRuntime(
      {
        notificationTemplates: {
          planReady: { title: 'Plan ready', message: '{session_name} has a plan ready for review' },
        },
      },
      { messages: createPlanMessages() },
    );
    mocks.buildTemplateVariables.mockImplementation((payload, sessionId) => (
      templateRuntime.buildTemplateVariables(payload, sessionId)
    ));

    await completePlanSession(runtime);

    const expectedBody = 'Reorder clinic professionals section has a plan ready for review';
    expect(calls.desktop[0]).toMatchObject({ kind: 'plan-ready', body: expectedBody });
    expect(calls.ui[0]).toMatchObject({ kind: 'plan-ready', body: expectedBody });
    expect(calls.push[0]).toMatchObject({ body: expectedBody });
    expect(calls.desktop[0].body).not.toContain(placeholder);
  });

  it('applies hidden-only and subtask gates to Plan Ready notifications', async () => {
    const focused = createRuntime(
      { notificationMode: 'hidden-only' },
      { getIsWindowFocused: () => true, messages: createPlanMessages() },
    );
    await completePlanSession(focused.runtime);
    expect(focused.calls.desktop).toHaveLength(0);
    expect(focused.mocks.buildTemplateVariables).not.toHaveBeenCalled();

    const child = createRuntime(
      { notifyOnSubtasks: false },
      {
        messages: createPlanMessages(),
        sessionInfo: { id: 'ses_1', title: 'Child session', parentID: 'parent_1' },
      },
    );
    await child.runtime.maybeSendPushForTrigger(createSessionPayload('parent_1'));
    await completePlanSession(child.runtime);
    expect(child.calls.desktop).toHaveLength(0);
    expect(child.calls.push).toHaveLength(0);
  });

  it('clears plan revision dedupe when a session is deleted', async () => {
    const { runtime, calls } = createRuntime({}, { messages: createPlanMessages() });
    await completePlanSession(runtime);
    await runtime.maybeSendPushForTrigger({
      type: 'session.deleted',
      properties: { sessionID: 'ses_1' },
    });
    await completePlanSession(runtime);

    expect(calls.desktop).toHaveLength(2);
    expect(calls.desktop.every((call) => call.kind === 'plan-ready')).toBe(true);
  });

  it('waits for pending questions before delivering a completed plan', async () => {
    const { runtime, calls } = createRuntime({}, { messages: createPlanMessages() });
    await runtime.maybeSendPushForTrigger(createStatusPayload('busy'));
    await primePlanMode(runtime);
    await runtime.maybeSendPushForTrigger(createPartPayload({
      messageId: 'msg_1',
      text: `<!--plan-->\n${createPlanMessages().at(-1).parts[0].text}`,
    }));
    await runtime.maybeSendPushForTrigger({
      type: 'question.asked',
      properties: {
        sessionID: 'ses_1',
        questions: [{ header: 'Plan choice', question: 'Which option?' }],
      },
    });
    await runtime.maybeSendPushForTrigger(createCompletionPayload({
      info: { parentID: 'user_plan_1' },
    }));
    await runtime.maybeSendPushForTrigger(createStatusPayload('idle'));
    expect(calls.desktop).toHaveLength(0);

    await runtime.maybeSendPushForTrigger({
      type: 'question.replied',
      properties: { sessionID: 'ses_1' },
    });
    expect(calls.desktop).toHaveLength(1);
    expect(calls.desktop[0].kind).toBe('plan-ready');
  });

  it('retains completion until a pending permission is answered', async () => {
    const { runtime, calls } = createRuntime();
    await runtime.maybeSendPushForTrigger(createStatusPayload('busy'));
    await runtime.maybeSendPushForTrigger({
      type: 'permission.asked',
      properties: {
        sessionID: 'ses_1',
        id: 'perm_1',
        permission: 'write',
      },
    });
    await runtime.maybeSendPushForTrigger(createCompletionPayload());
    await runtime.maybeSendPushForTrigger(createStatusPayload('idle'));
    expect(calls.desktop).toHaveLength(0);

    await runtime.maybeSendPushForTrigger({
      type: 'permission.replied',
      properties: { sessionID: 'ses_1', requestID: 'perm_1' },
    });

    expect(calls.desktop).toHaveLength(1);
    expect(calls.desktop[0].kind).toBe('ready');
    expect(calls.ui).toHaveLength(1);
    expect(calls.push).toHaveLength(1);
  });

  it('sends a Permissions Needed notification with the requested folder', async () => {
    vi.useFakeTimers();
    const { runtime, calls } = createRuntime({
      notifyOnPermission: true,
      notificationTemplates: {
        permission: { title: 'Permissions needed', message: 'Folder access is required: {last_message}' },
      },
    });

    await runtime.maybeSendPushForTrigger({
      type: 'permission.asked',
      properties: {
        sessionID: 'ses_1',
        id: 'perm_folder_1',
        permission: 'external_directory',
        patterns: ['/workspace/shared/**'],
      },
    });
    await vi.advanceTimersByTimeAsync(500);

    expect(calls.desktop).toHaveLength(1);
    expect(calls.desktop[0]).toMatchObject({
      kind: 'permission',
      title: 'Permissions needed',
      body: 'Folder access is required: /workspace/shared/**',
      sessionId: 'ses_1',
    });
    expect(calls.ui).toHaveLength(1);
    expect(calls.push[0].data.type).toBe('permission');
  });

  it('lets Permissions Needed be disabled independently from Agent Questions', async () => {
    vi.useFakeTimers();
    const { runtime, calls } = createRuntime({
      notifyOnQuestion: true,
      notifyOnPermission: false,
    });

    await runtime.maybeSendPushForTrigger({
      type: 'permission.asked',
      properties: {
        sessionID: 'ses_1',
        id: 'perm_folder_2',
        permission: 'external_directory',
        patterns: ['/workspace/private/**'],
      },
    });
    await vi.advanceTimersByTimeAsync(500);

    expect(calls.desktop).toHaveLength(0);
    expect(calls.ui).toHaveLength(0);
    expect(calls.push).toHaveLength(0);
  });
});
