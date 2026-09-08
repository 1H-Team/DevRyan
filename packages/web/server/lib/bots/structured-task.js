import { randomUUID } from 'node:crypto';

import { validateUuid } from './validation.js';
import { withBotAbort } from './request-lifetime.js';

export async function runBotStructuredTask({
  adapter,
  run,
  contract,
  binding,
  prompt,
  schema,
  title,
  system = '',
  signal,
  uuid = randomUUID,
} = {}) {
  if (!adapter || typeof adapter.prepareRevision !== 'function'
    || typeof adapter.completeStructured !== 'function'
    || typeof adapter.closeRun !== 'function'
    || !run || typeof run !== 'object'
    || typeof prompt !== 'string' || !prompt
    || !schema || typeof schema !== 'object' || Array.isArray(schema)
    || typeof title !== 'string' || !title
    || typeof system !== 'string' || typeof uuid !== 'function') {
    throw new TypeError('Bot structured task is misconfigured');
  }
  const runId = validateUuid(run.id || uuid(), 'structuredTask.runId');
  signal?.throwIfAborted();
  const preparation = adapter.prepareRevision({
    run: Object.freeze({ ...run, id: runId }),
    contract,
    binding,
    attachmentIds: [],
    libraryVersionIds: [],
    persistence: 'ephemeral',
    ...(signal ? { signal } : {}),
  });
  const cleanup = async () => {
    const cleanupSignal = AbortSignal.timeout(5_000);
    try {
      await withBotAbort(adapter.closeRun({ runId, binding, signal: cleanupSignal }), cleanupSignal);
    } catch {
      // Cleanup cannot replace the original completion or cancellation result.
    }
  };
  let prepared;
  try {
    prepared = await withBotAbort(preparation, signal);
    return await withBotAbort(adapter.completeStructured({
      runId,
      binding,
      prepared,
      prompt,
      schema,
      title,
      system,
      ...(signal ? { signal } : {}),
    }), signal);
  } finally {
    if (!prepared && signal?.aborted) void Promise.resolve(preparation).then(cleanup, () => {});
    await cleanup();
  }
}
