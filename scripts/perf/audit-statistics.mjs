import assert from 'node:assert/strict';

const median = values => {
  const sorted = values.toSorted((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

// Freeze this protocol on both arms. Resample whole paired differences, never
// choose a favourable subset of runs or a different seed after seeing results.
export const AUDIT_BOOTSTRAP = Object.freeze({ seed: 20261020, resamples: 10000, confidence: 0.95 });
export function pairedMedianInterval(pairs) {
  assert.ok(Array.isArray(pairs) && pairs.length > 1 && pairs.every(pair => Array.isArray(pair)
    && pair.length === 2 && pair.every(value => Number.isFinite(value) && value >= 0)), 'Finite paired times required');
  const differences = pairs.map(([baseline, candidate]) => candidate - baseline);
  let state = AUDIT_BOOTSTRAP.seed;
  const random = () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const samples = Array.from({ length: AUDIT_BOOTSTRAP.resamples }, () => median(
    Array.from({ length: pairs.length }, () => differences[Math.floor(random() * pairs.length)]),
  )).sort((a, b) => a - b);
  const lowerMs = samples[Math.floor(samples.length * 0.025)];
  const upperMs = samples[Math.ceil(samples.length * 0.975) - 1];
  return { pairedMedianDifferenceMs: median(differences), lowerMs, upperMs,
    halfWidthMs: (upperMs - lowerMs) / 2, protocol: AUDIT_BOOTSTRAP };
}

export function gradeStartupCalibration(pairs) {
  assert.ok([5, 10, 15].includes(pairs.length), 'Calibration uses complete five-pair blocks');
  const baselineMedianMs = median(pairs.map(([baseline]) => baseline));
  const allowanceMs = Math.max(0.05 * baselineMedianMs, 50);
  const interval = pairedMedianInterval(pairs);
  const qualified = interval.halfWidthMs <= allowanceMs / 2;
  return { pairs: pairs.length, baselineMedianMs, allowanceMs, interval,
    verdict: qualified ? 'qualified' : pairs.length === 15 ? 'unqualified' : 'expand',
    frozenComparisonPairs: qualified ? pairs.length : null,
    nextCalibrationPairs: qualified || pairs.length === 15 ? null : pairs.length + 5 };
}
