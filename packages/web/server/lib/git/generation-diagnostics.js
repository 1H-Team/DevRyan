// Use the journal's retained field names; never include prompts or raw provider errors.
export const buildGitGenerationTimingRecord = (req, payload) => ({
  type: 'timing',
  actor: req?.principal?.id
    ? {
        id: req.principal.id,
        role: req.principal.role || null,
        scope: req.principal.scope || null,
      }
    : null,
  mark: payload.event,
  payload: {
    durationMs: payload.totalMs,
    stages: [
      { phase: 'context', durationMs: payload.contextMs },
      { phase: 'model', durationMs: payload.modelMs },
      { phase: 'provider', durationMs: payload.providerMs },
      { phase: 'parsing', durationMs: payload.parseMs },
    ],
    count: payload.selectedFileCount,
    scope: payload.stagedOnly === true ? 'staged-only' : 'staged-and-unstaged',
    outcome: payload.outcome,
    model: payload.model,
    state: payload.catalogState,
    retry: payload.retried === true,
    source: payload.source,
    reason: payload.providerOutcome,
    attempt: payload.attempt,
    statusCode: payload.statusCode,
  },
});
