import assert from 'node:assert/strict';
import { test } from 'node:test';

import { packLanes, readUnitTimings } from './test-ci-lanes.mjs';
import { mergeUnitTimings } from './update-test-timings.mjs';

test('lanes are packed longest first onto the least-loaded lane, deterministically', () => {
  const units = ['a', 'b', 'c', 'd', 'e'].map((name) => ({ name }));
  const timings = { a: 100, b: 60, c: 50, d: 40 };
  const lanes = packLanes(units, ['one', 'two'], timings);
  // e has no recording and costs the median (60).
  assert.deepEqual(Object.fromEntries(Object.entries(lanes).map(([lane, rows]) => [lane, rows.map((row) => row.name)])),
    { one: ['a', 'c'], two: ['b', 'e', 'd'] });
  assert.deepEqual(packLanes([...units].reverse(), ['one', 'two'], timings), lanes);
});

test('recorded timings refresh only from passed units and stay sorted', () => {
  const recording = { schemaVersion: 1, units: [{ name: 'b', status: 'passed', ms: 300 }, { name: 'a', status: 'failed', ms: 1 }, { name: 'c', status: 'passed', ms: 10 }] };
  assert.deepEqual(mergeUnitTimings({ b: 100, a: 50 }, [recording]), { a: 50, b: 200, c: 10 });
  assert.throws(() => mergeUnitTimings({}, [{ units: [] }]), /Unsupported timing recording/);
  assert.ok(Object.values(readUnitTimings()).every((ms) => Number.isSafeInteger(ms) && ms >= 0));
});

test('units sharing an exclusive resource spread across lanes before the rest', () => {
  const units = [{ name: 'big' }, { name: 'g1', resource: 'native-graph' }, { name: 'g2', resource: 'native-graph' }, { name: 'small' }];
  const lanes = packLanes(units, ['one', 'two'], { big: 300, g1: 100, g2: 90, small: 10 });
  assert.deepEqual(Object.fromEntries(Object.entries(lanes).map(([lane, rows]) => [lane, rows.map((row) => row.name)])),
    { one: ['g1', 'small'], two: ['g2', 'big'] });
});
