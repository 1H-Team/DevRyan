import { afterEach, describe, expect, it, vi } from 'vitest';

import { runBotStructuredTask } from './structured-task.js';

const RUN_ID = 'a0000000-0000-4000-8000-000000000001';

const createAdapter = () => ({
  prepareRevision: vi.fn(async () => ({ prepared: true })),
  completeStructured: vi.fn(async () => ({ ok: true })),
  closeRun: vi.fn(async () => ({ closed: true })),
});

describe('Bot structured task lifecycle', () => {
  it('prepares synthetic tasks ephemerally and closes the scoped runtime', async () => {
    const adapter = createAdapter();
    await expect(runBotStructuredTask({
      adapter,
      run: { id: RUN_ID, botId: 'bot', channelId: 'channel', revisionId: 'revision' },
      contract: { models: {} },
      binding: { kind: 'opencode' },
      prompt: 'Return JSON',
      schema: { type: 'object' },
      title: 'Memory extraction',
    })).resolves.toEqual({ ok: true });

    expect(adapter.prepareRevision).toHaveBeenCalledWith(expect.objectContaining({
      persistence: 'ephemeral',
      attachmentIds: [],
      libraryVersionIds: [],
      run: expect.objectContaining({ id: RUN_ID }),
    }));
    expect(adapter.completeStructured).toHaveBeenCalledWith({
      runId: RUN_ID,
      binding: { kind: 'opencode' },
      prepared: { prepared: true },
      prompt: 'Return JSON',
      schema: { type: 'object' },
      title: 'Memory extraction',
      system: '',
    });
    expect(adapter.closeRun).toHaveBeenCalledWith({
      runId: RUN_ID,
      binding: { kind: 'opencode' },
      signal: expect.any(AbortSignal),
    });
  });

  it('closes an ephemeral runtime when structured completion fails', async () => {
    const adapter = createAdapter();
    adapter.completeStructured.mockRejectedValueOnce(new Error('invalid output'));

    await expect(runBotStructuredTask({
      adapter,
      run: { id: RUN_ID },
      contract: {},
      binding: { kind: 'ag_ui' },
      prompt: 'Return JSON',
      schema: { type: 'object' },
      title: 'Routine draft',
    })).rejects.toThrow('invalid output');
    expect(adapter.closeRun).toHaveBeenCalledTimes(1);
  });
});

const structuredInput = (adapter, signal) => ({
  adapter, signal, run: { id: RUN_ID }, contract: {}, binding: { kind: 'opencode' },
  prompt: 'Return JSON', schema: { type: 'object' }, title: 'Memory extraction',
});

const fakeDeadlines = () => {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), ms);
    return controller.signal;
  });
};

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('structured extraction deadlines', () => {
  it('bounds hung cleanup to five seconds after successful completion', async () => {
    fakeDeadlines();
    const adapter = createAdapter();
    adapter.closeRun.mockImplementation(() => new Promise(() => {}));
    const result = runBotStructuredTask(structuredInput(adapter));
    let settled = false;
    void result.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toEqual({ ok: true });
  });

  it('propagates inline cancellation through completion and uses a fresh cleanup signal', async () => {
    const adapter = createAdapter();
    const controller = new AbortController();
    adapter.completeStructured.mockImplementation(() => new Promise(() => {}));
    const result = runBotStructuredTask(structuredInput(adapter, controller.signal));
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(adapter.completeStructured).toHaveBeenCalled());
    controller.abort();
    await rejected;
    expect(adapter.prepareRevision.mock.calls[0][0].signal).toBe(controller.signal);
    expect(adapter.completeStructured.mock.calls[0][0].signal).toBe(controller.signal);
    expect(adapter.closeRun.mock.calls[0][0].signal.aborted).toBe(false);
  });

  it('cleans a runtime that finishes preparing after cancellation', async () => {
    const adapter = createAdapter();
    const controller = new AbortController();
    let finish;
    adapter.prepareRevision.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const result = runBotStructuredTask(structuredInput(adapter, controller.signal));
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await rejected;
    finish({ prepared: true });
    await vi.waitFor(() => expect(adapter.closeRun).toHaveBeenCalledTimes(2));
    expect(adapter.completeStructured).not.toHaveBeenCalled();
  });
});
