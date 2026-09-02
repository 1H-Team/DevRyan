import { describe, expect, it, vi } from 'vitest';

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
