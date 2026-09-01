import { randomUUID } from 'node:crypto';

import { validateUuid } from './validation.js';

export async function runBotStructuredTask({
  adapter,
  run,
  contract,
  binding,
  prompt,
  schema,
  title,
  system = '',
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
  const prepared = await adapter.prepareRevision({
    run: Object.freeze({ ...run, id: runId }),
    contract,
    binding,
    attachmentIds: [],
    libraryVersionIds: [],
    persistence: 'ephemeral',
  });
  try {
    return await adapter.completeStructured({
      runId,
      binding,
      prepared,
      prompt,
      schema,
      title,
      system,
    });
  } finally {
    await adapter.closeRun({ runId, binding }).catch(() => undefined);
  }
}
