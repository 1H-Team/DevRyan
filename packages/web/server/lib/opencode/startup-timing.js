// Fixed labels only: early boot has no journal owner yet.
export const startStartupTiming = (phase) => {
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
