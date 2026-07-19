import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DevRyanBuilderTodoContinuationPlugin } from './devryan-builder-todo-continuation.mjs';

const SESSION_ID = 'ses_builder';

const todoEvent = (statuses) => ({
  type: 'todo.updated',
  properties: {
    sessionID: SESSION_ID,
    todos: statuses.map((status, index) => ({
      content: `Task ${index + 1}`,
      priority: 'medium',
      status,
    })),
  },
});

const completionEvent = ({
  id = 'msg_done',
  agent = 'builder',
  finish = 'stop',
} = {}) => ({
  type: 'message.updated',
  properties: {
    info: {
      id,
      sessionID: SESSION_ID,
      role: 'assistant',
      agent,
      finish,
      providerID: 'openai',
      modelID: 'gpt-5.5',
      variant: 'high',
      time: { completed: 10 },
    },
  },
});

const idleEvent = () => ({
  type: 'session.idle',
  properties: { sessionID: SESSION_ID },
});

const userEvent = (id = 'msg_user') => ({
  type: 'message.updated',
  properties: {
    info: {
      id,
      sessionID: SESSION_ID,
      role: 'user',
      time: { created: 1 },
    },
  },
});

const createPlugin = async () => {
  const promptAsync = vi.fn(async () => ({ data: undefined }));
  const plugin = await DevRyanBuilderTodoContinuationPlugin({
    client: { session: { promptAsync } },
    directory: '/project',
  });
  const emit = async (event) => plugin.event({ event });
  return { emit, promptAsync };
};

describe('DevRyan Builder todo continuation plugin', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('continues the same Builder model after a premature 3/5 completion', async () => {
    const { emit, promptAsync } = await createPlugin();
    await emit(todoEvent(['completed', 'completed', 'completed', 'in_progress', 'pending']));
    await emit(completionEvent());
    await emit(idleEvent());

    expect(promptAsync).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);

    expect(promptAsync).toHaveBeenCalledTimes(1);
    expect(promptAsync).toHaveBeenCalledWith({
      path: { id: SESSION_ID },
      query: { directory: '/project' },
      body: {
        agent: 'builder',
        model: { providerID: 'openai', modelID: 'gpt-5.5' },
        variant: 'high',
        parts: [{
          type: 'text',
          synthetic: true,
          text: expect.stringContaining('incomplete todos'),
        }],
      },
    }, { throwOnError: false });
  });

  it('does not continue a Builder response after all todos reach 5/5', async () => {
    const { emit, promptAsync } = await createPlugin();
    await emit(todoEvent(['completed', 'completed', 'completed', 'completed', 'completed']));
    await emit(completionEvent());
    await emit(idleEvent());
    await vi.advanceTimersByTimeAsync(250);

    expect(promptAsync).not.toHaveBeenCalled();
  });

  it('does not continue another agent or an errored Builder turn', async () => {
    const { emit, promptAsync } = await createPlugin();
    await emit(todoEvent(['in_progress', 'pending']));
    await emit(completionEvent({ id: 'msg_plan', agent: 'plan' }));
    await emit(idleEvent());
    await vi.advanceTimersByTimeAsync(250);
    await emit(completionEvent({ id: 'msg_error', finish: 'error' }));
    await emit(idleEvent());
    await vi.advanceTimersByTimeAsync(250);

    expect(promptAsync).not.toHaveBeenCalled();
  });

  it('does not resume stale incomplete todos after a new manual request that never updated them', async () => {
    const { emit, promptAsync } = await createPlugin();
    await emit(todoEvent(['completed', 'in_progress', 'pending']));
    await emit(userEvent('msg_new_request'));
    await emit(completionEvent({ id: 'msg_new_answer' }));
    await emit(idleEvent());
    await vi.advanceTimersByTimeAsync(250);

    expect(promptAsync).not.toHaveBeenCalled();
  });

  it('coalesces duplicate idle events and stops after two stagnant continuations', async () => {
    const { emit, promptAsync } = await createPlugin();
    await emit(todoEvent(['completed', 'in_progress', 'pending']));

    await emit(completionEvent({ id: 'msg_1' }));
    await emit(idleEvent());
    await emit(idleEvent());
    await vi.advanceTimersByTimeAsync(250);
    expect(promptAsync).toHaveBeenCalledTimes(1);

    await emit(completionEvent({ id: 'msg_2' }));
    await emit(idleEvent());
    await vi.advanceTimersByTimeAsync(250);
    expect(promptAsync).toHaveBeenCalledTimes(2);

    await emit(completionEvent({ id: 'msg_3' }));
    await emit(idleEvent());
    await vi.advanceTimersByTimeAsync(250);
    expect(promptAsync).toHaveBeenCalledTimes(2);
  });
});
