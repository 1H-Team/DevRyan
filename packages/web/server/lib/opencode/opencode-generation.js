// ---------------------------------------------------------------------------
// Generation dispatch for helper modules that receive `openCodeClient`
// (DESIGN.md E item 13).
//
// The client identity is required and read on every call. Missing, legacy or
// unknown identities fail closed with `opencode_generation_invalid`.
//
// Companion-only capabilities (conversation revert, session retention, the
// execution bridge, Cursor transcript injection) do not exist on unmodified
// OpenCode 2. Their gen-2 paths answer with a typed `capability_absent` result
// until the Phase 3 host and coordinator provide them.
// ---------------------------------------------------------------------------

export const OPENCODE_CAPABILITY_ABSENT = 'capability_absent';
export const OPENCODE_GENERATION_INVALID = 'opencode_generation_invalid';

/**
 * The explicitly identified supported OpenCode runtime.
 * @param {{ generation: () => unknown } | null | undefined} openCodeClient
 * @returns {2}
 */
export const resolveOpenCodeGeneration = (openCodeClient) => {
  if (typeof openCodeClient?.generation !== 'function') {
    throw Object.assign(new Error('openCodeClient.generation is not a function'), {
      code: OPENCODE_GENERATION_INVALID,
      status: 503,
      statusCode: 503,
    });
  }
  const generation = openCodeClient.generation();
  if (generation === 2) return generation;
  throw Object.assign(new Error('The OpenCode runtime generation is unknown'), {
    code: OPENCODE_GENERATION_INVALID,
    status: 503,
    statusCode: 503,
  });
};

/**
 * The error a gen-2 path raises for a capability only the gen-1 companion has.
 * `status` follows the surrounding module's conflict convention (409).
 * @param {string} capability e.g. `conversation_revert`
 * @param {{ status?: number }} [options]
 */
export const createCapabilityAbsentError = (capability, { status = 409 } = {}) => Object.assign(
  new Error(`OpenCode 2 does not provide ${capability} yet`),
  { code: OPENCODE_CAPABILITY_ABSENT, status, capability, generation: 2 },
);

/** True for an error raised by {@link createCapabilityAbsentError}. */
export const isCapabilityAbsentError = (error) => (
  error !== null && typeof error === 'object' && error.code === OPENCODE_CAPABILITY_ABSENT
);
