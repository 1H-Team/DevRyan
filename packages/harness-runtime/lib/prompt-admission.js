const DEFAULT_BLOCKS = Object.freeze({
  initializing: Object.freeze({
    code: 'HARNESS_INITIALIZING',
    error: 'DevRyan harness is still initializing',
    retryAfterSeconds: 1,
  }),
  draining: Object.freeze({
    code: 'HARNESS_DRAINING',
    error: 'DevRyan is shutting down',
    retryAfterSeconds: 1,
  }),
});

const normalizeBlock = (name, value = {}) => ({
  name,
  code: typeof value.code === 'string' && value.code.trim()
    ? value.code.trim()
    : 'HARNESS_NOT_ACCEPTING_PROMPTS',
  error: typeof value.error === 'string' && value.error.trim()
    ? value.error.trim()
    : 'DevRyan is temporarily not accepting prompts',
  retryAfterSeconds: Number.isFinite(value.retryAfterSeconds)
    ? Math.max(1, Math.floor(value.retryAfterSeconds))
    : 1,
});

export const createPromptAdmissionController = () => {
  let ready = false;
  let draining = false;
  const holds = new Map();

  const getBlock = () => {
    if (!ready) return { name: 'initializing', ...DEFAULT_BLOCKS.initializing };
    if (draining) return { name: 'draining', ...DEFAULT_BLOCKS.draining };
    return holds.values().next().value ?? null;
  };

  return {
    markReady() {
      ready = true;
    },
    beginDrain() {
      draining = true;
    },
    acquireHold(name, block) {
      const normalizedName = typeof name === 'string' && name.trim()
        ? name.trim()
        : 'unnamed';
      const token = Symbol(normalizedName);
      holds.set(token, normalizeBlock(normalizedName, block));
      let released = false;
      return () => {
        if (released) return false;
        released = true;
        return holds.delete(token);
      };
    },
    isReady: () => ready,
    isAccepting: () => getBlock() === null,
    getBlock,
  };
};
