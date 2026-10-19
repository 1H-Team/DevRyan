import assert from 'node:assert/strict';
import test from 'node:test';
import { gradeStartupCalibration, pairedMedianInterval } from './audit-statistics.mjs';

test('paired resampling is deterministic and retains paired differences', () => {
  const pairs = [[100, 110], [1000, 1010], [20, 30], [500, 510], [90, 100]];
  const interval = pairedMedianInterval(pairs);
  assert.deepEqual(interval, pairedMedianInterval(pairs));
  assert.equal(interval.lowerMs, 10); assert.equal(interval.upperMs, 10);
  assert.equal(gradeStartupCalibration(pairs).frozenComparisonPairs, 5);
});

test('noisy calibration expands complete blocks then remains unqualified', () => {
  const pairs = [[100, 0], [100, 1000], [100, 100], [100, 800], [100, 0]];
  assert.equal(gradeStartupCalibration(pairs).nextCalibrationPairs, 10);
  assert.equal(gradeStartupCalibration([...pairs, ...pairs]).nextCalibrationPairs, 15);
  const final = gradeStartupCalibration([...pairs, ...pairs, ...pairs]);
  assert.equal(final.verdict, 'unqualified'); assert.equal(final.frozenComparisonPairs, null);
  assert.throws(() => gradeStartupCalibration(pairs.slice(1)), /complete five-pair blocks/);
  assert.throws(() => pairedMedianInterval([[1, NaN], [1, 2]]), /Finite paired times/);
});
