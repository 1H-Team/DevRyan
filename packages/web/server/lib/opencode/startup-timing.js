let phaseListener = null;
/** The desktop shell turns phase starts into splash progress while the server
 * module is still booting. It receives the fixed phase label only. */
export const setStartupPhaseListener = (listener) => {
  phaseListener = typeof listener === 'function' ? listener : null;
};

// Fixed labels only: early boot has no journal owner yet.
export const startStartupTiming = (phase) => {
  try { phaseListener?.(phase); } catch {}
  const startedAt = performance.now();
  return (outcome = 'completed') => {
    console.log('[runtime-bundle] startup phase', JSON.stringify({
      phase, outcome, elapsedMs: performance.now() - startedAt,
    }));
  };
};

export const timeStartupPhase = async (phase, operation) => {
  const finish = startStartupTiming(phase);
  try {
    const result = await operation();
    finish();
    return result;
  } catch (error) {
    finish('failed');
    throw error;
  }
};
