// Only caller-owned phase labels and durations are logged, never subprocess data.
export function createPhaseTimings({ now = () => performance.now(), log = console.log } = {}) {
  const started = now(), phases = [];
  const record = (name, from, passed) => {
    const row = { phase: name, offsetMs: Math.round(from - started), durationMs: Math.round(now() - from), passed };
    phases.push(row);
    log(`[qualification] ${name}: ${row.durationMs}ms (${passed ? 'ok' : 'failed'})`);
  };
  return {
    phases,
    async measure(name, operation) {
      const from = now(); let passed = false;
      try { const result = await operation(); passed = true; return result; }
      finally { record(name, from, passed); }
    },
    measureSync(name, operation) {
      const from = now(); let passed = false;
      try { const result = operation(); passed = true; return result; }
      finally { record(name, from, passed); }
    },
  };
}
