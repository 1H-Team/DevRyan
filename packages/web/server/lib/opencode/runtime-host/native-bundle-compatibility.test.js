import { expect, test } from 'vitest';
import { isReviewedNativeClonePair, REVIEWED_NATIVE_CLONE_RELEASES, REVIEWED_NATIVE_CLONE_LAYOUT,
  verifyNativeCloneCompatibility } from './native-bundle-compatibility.js';

const manifest = version => ({ opencodeVersion: version, inputs: { coreDigest: REVIEWED_NATIVE_CLONE_RELEASES[version] },
  compiledContracts: ['devryan-v2-clone/1', 'devryan.bundle.credentials/2', 'devryan.bundle.credential-owners/2'] });
test.each([['2.0.20', '2.0.24'], ['2.0.24', '2.0.20']])('only the reviewed exact release graphs and layout permit %s to %s', (source, target) => {
  const left = manifest(source), right = manifest(target);
  expect(isReviewedNativeClonePair(left, right, REVIEWED_NATIVE_CLONE_LAYOUT)).toBe(true);
  for (const version of ['2.0.21', '2.0.25', `${source}-dev`, ` ${source} `, null, undefined]) {
    expect(isReviewedNativeClonePair({ ...left, opencodeVersion: version }, right, REVIEWED_NATIVE_CLONE_LAYOUT)).toBe(false);
    expect(isReviewedNativeClonePair(left, { ...right, opencodeVersion: version }, REVIEWED_NATIVE_CLONE_LAYOUT)).toBe(false);
  }
  for (const coreDigest of ['0'.repeat(64), right.inputs.coreDigest, '', undefined]) {
    expect(isReviewedNativeClonePair({ ...left, inputs: { coreDigest } }, right, REVIEWED_NATIVE_CLONE_LAYOUT)).toBe(false);
  }
  for (const coreDigest of ['0'.repeat(64), left.inputs.coreDigest, '', undefined]) {
    expect(isReviewedNativeClonePair(left, { ...right, inputs: { coreDigest } }, REVIEWED_NATIVE_CLONE_LAYOUT)).toBe(false);
  }
  for (const [key, value] of [['schemaSha256', '0'.repeat(64)], ['migrationsSha256', '0'.repeat(64)], ['userVersion', 1]]) {
    expect(isReviewedNativeClonePair(left, right, { ...REVIEWED_NATIVE_CLONE_LAYOUT, [key]: value })).toBe(false);
  }
  expect(isReviewedNativeClonePair(left, right, undefined)).toBe(false);
});
test('same-core compatibility is preserved, and cross-release database evidence cannot be omitted', () => {
  const left = manifest('2.0.20');
  expect(() => verifyNativeCloneCompatibility({ left, right: structuredClone(left) })).not.toThrow();
  expect(() => verifyNativeCloneCompatibility({ left, right: manifest('2.0.24'), databasePath: '/does-not-exist' }))
    .toThrow('bundle_v2_upgrade_compatibility_required');
  for (const contract of ['devryan-v2-clone/1', 'devryan.bundle.credentials/2']) {
    const right = { ...left, compiledContracts: left.compiledContracts.filter(value => value !== contract) };
    expect(() => verifyNativeCloneCompatibility({ left, right })).toThrow('bundle_v2_upgrade_compatibility_required');
  }
});
