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
