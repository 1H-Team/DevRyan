import { describe, expect, it, vi } from 'vitest';

import { createOpenCodeReasoningAdapter } from './opencode-reasoning-adapter.js';

const RUN_ID = 'a0000000-0000-4000-8000-000000000001';

const createProvider = () => ({
  start: vi.fn(async () => {}),
  startReasoningRun: vi.fn(async () => ({ modelSnapshot: {}, prepared: true })),
  createSegment: vi.fn(async () => ({ id: 'session-1' })),
  prompt: vi.fn(async () => ({ accepted: true })),
  inspectSegment: vi.fn(async () => ({})),
  abort: vi.fn(async () => {}),
  stopReasoningRun: vi.fn(async () => {}),
  runNoToolsStructured: vi.fn(async () => '{"ok":true}'),
  setEventHandler: vi.fn(),
});

describe('OpenCode reasoning adapter', () => {
  it('tolerates only an absent runtime during warm release while close remains strict', async () => {
    const provider = createProvider();
    const adapter = createOpenCodeReasoningAdapter({ provider });
    const missing = Object.assign(new Error('absent'), { code: 'bot_opencode_run_not_found' });
    provider.stopReasoningRun.mockRejectedValue(missing);
    await expect(adapter.releaseWarm({ runId: RUN_ID })).resolves.toBeUndefined();
    await expect(adapter.closeRun({ runId: RUN_ID })).rejects.toBe(missing);
    const cleanup = Object.assign(new Error('cleanup failed'), { code: 'bot_container_stop_failed' });
    provider.stopReasoningRun.mockRejectedValue(cleanup);
    await expect(adapter.releaseWarm({ runId: RUN_ID })).rejects.toBe(cleanup);
  });

  it('forwards only the provider structured-completion contract', async () => {
    const provider = createProvider();
    const adapter = createOpenCodeReasoningAdapter({ provider });
    const schema = { type: 'object', additionalProperties: false };

    await expect(adapter.completeStructured({
      runId: RUN_ID,
      binding: { kind: 'opencode' },
      prepared: { internal: true },
      prompt: 'Return JSON.',
      schema,
      title: 'Memory extraction',
      system: 'Return structured memory only.',
    })).resolves.toBe('{"ok":true}');

    expect(provider.runNoToolsStructured).toHaveBeenCalledWith({
      runId: RUN_ID,
      prompt: 'Return JSON.',
      schema,
      title: 'Memory extraction',
      system: 'Return structured memory only.',
    });
  });
});
