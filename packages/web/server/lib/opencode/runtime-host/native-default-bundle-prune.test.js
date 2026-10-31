import { afterEach, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pruneSupersededBundles } from './native-default-bundle.js';

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

const controlRoot = async ({ bundles, selection, activation, rebind }) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-bundle-prune-')));
  roots.push(root);
  for (const [bundleID, createdAt] of Object.entries(bundles)) {
    const directory = path.join(root, 'bundles', bundleID);
    await fs.mkdir(path.join(directory, 'web-data'), { recursive: true });
    await fs.writeFile(path.join(directory, 'web-data', 'data.txt'), bundleID);
    if (createdAt !== null) await fs.writeFile(path.join(directory, 'descriptor.json'), JSON.stringify({ bundleID, createdAt }));
  }
  await fs.writeFile(path.join(root, 'selection.json'), JSON.stringify({ schema: 1, revision: 9, transition: 'activate',
    reconciliationRequired: false, previousBundleID: null, ...selection }));
  if (activation) await fs.writeFile(path.join(root, 'claude-activation.json'), JSON.stringify(activation));
  if (rebind) {
    await fs.mkdir(path.join(root, 'rebind'));
    await fs.writeFile(path.join(root, 'rebind', 'intent.json'), JSON.stringify(rebind));
  }
  return root;
};
const remaining = async root => (await fs.readdir(path.join(root, 'bundles'))).sort();

test('removes only bundles nothing can select again', async () => {
  const root = await controlRoot({
    bundles: { 'default-native': 1, 'native-a-r1': 2, 'native-b-r2': 3, 'native-c-r3': 4, 'native-d-r4': 5, 'native-pending-r4': 6, 'native-partial-r4': null },
    selection: { selectedBundleID: 'native-d-r4', previousBundleID: 'native-c-r3' },
  });
  expect((await pruneSupersededBundles(root)).sort()).toEqual(['default-native', 'native-a-r1', 'native-b-r2']);
  // Selected, rollback target, a newer pending candidate and an undescribed (in-flight) copy stay.
  expect(await remaining(root)).toEqual(['native-c-r3', 'native-d-r4', 'native-partial-r4', 'native-pending-r4']);
});

test('a leftover Claude activation record from the retired Claude updater holds nothing back', async () => {
  for (const activation of [
    { state: 'pending', sourceSelection: { selectedBundleID: 'native-b-r2', previousBundleID: 'native-a-r1' } },
    { state: 'pending' },
    'not a record',
  ]) {
    const root = await controlRoot({
      bundles: { 'native-a-r1': 1, 'native-b-r2': 2, 'native-c-r3': 3 },
      selection: { selectedBundleID: 'native-c-r3', previousBundleID: 'native-b-r2' },
      activation,
    });
    expect(await pruneSupersededBundles(root)).toEqual(['native-a-r1']);
    expect(await remaining(root)).toEqual(['native-b-r2', 'native-c-r3']);
  }
});

test('an unsettled rebind or a reconciling selection prunes nothing', async () => {
  for (const options of [{ rebind: { state: 'pending' } }, { rebind: { state: 'restoring' } },
    { selection: { selectedBundleID: 'native-b-r2', previousBundleID: null, reconciliationRequired: true } }]) {
    const root = await controlRoot({ bundles: { 'native-a-r1': 1, 'native-b-r2': 2 },
      selection: { selectedBundleID: 'native-b-r2', previousBundleID: null }, ...options });
    expect(await pruneSupersededBundles(root)).toEqual([]);
    expect(await remaining(root)).toEqual(['native-a-r1', 'native-b-r2']);
  }
});
