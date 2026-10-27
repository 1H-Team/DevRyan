const writers = new Set(['write', 'edit', 'patch', 'apply_patch', 'ast_grep_replace']);

/** Only known verification consumers need this barrier; reads stay parallel. */
export const isVerificationCommand = command => typeof command === 'string'
  && /(?:^|[\s;&|/])(?:vitest|jest|playwright|tsc|pytest|cargo\s+test|go\s+test|(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?(?:test|build|lint|check|type-check|typecheck|validate)(?=[\s:;&|]|$))/.test(command);

/** Publication, not process exit or a sleep, releases a dependent snapshot. */
export async function awaitVerificationPublications({ input, parts, leaseForCall, activeJob, signal }) {
  const command = input.authorization?.input?.input?.command;
  if (input.kind !== 'shell' || !isVerificationCommand(command)) return;
  for (const part of parts ?? []) {
    if (part.type !== 'tool' || part.callID === input.callID || !writers.has(part.tool)) continue;
    signal?.throwIfAborted();
    const scope = { directory: input.directory, sessionID: input.sessionID, messageID: input.messageID, callID: part.callID };
    let lease = await leaseForCall(scope);
    if (lease?.state === 'published') continue;
    const job = activeJob(scope);
    if (job?.settled) {
      if (!signal) await job.settled;
      else await new Promise((resolve, reject) => {
        const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
        Promise.resolve(job.settled).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
      });
      signal?.throwIfAborted();
      lease = await leaseForCall(scope);
      if (lease?.state === 'published') continue;
    }
    // A tool may be registered in the native step before its host job exists.
    // Reject before capturing a view; the next step can retry after publication.
    throw Object.assign(new Error('Await the edit result before running verification; sleeping inside a captured view cannot refresh it.'), {
      code: 'native_verification_publication_pending', status: 409, statusCode: 409,
    });
  }
}
