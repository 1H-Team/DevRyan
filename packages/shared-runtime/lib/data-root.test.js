import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { defaultDataRootPaths, explicitDataRoot, isLegacyDataRootInPlace, resolveDevRyanDataRoot } from './data-root.js';

const homes = [];
afterEach(async () => { await Promise.all(homes.splice(0).map(home => fs.rm(home, { recursive: true, force: true }))); });
const fixture = async () => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-resolve-')));
  homes.push(home);
  await fs.mkdir(path.join(home, '.config'));
  return { home, ...defaultDataRootPaths(home) };
};

describe('DevRyan data root resolution', () => {
  test('explicit roots win; a configured default location counts as the default', async () => {
    const { home, root, legacy } = await fixture();
    expect(explicitDataRoot({ DEVRYAN_DATA_DIR: ' /qa/data ' }, home)).toBe('/qa/data');
    expect(explicitDataRoot({ OPENCHAMBER_DATA_DIR: '/qa/legacy' }, home)).toBe('/qa/legacy');
    expect(explicitDataRoot({ DEVRYAN_DATA_DIR: legacy }, home)).toBeNull();
    expect(explicitDataRoot({ DEVRYAN_DATA_DIR: root }, home)).toBeNull();
    expect(explicitDataRoot({ DEVRYAN_DATA_DIR: '  ' }, home)).toBeNull();
  });

  test('the legacy folder stays in use only while it holds the data', async () => {
    const { home, root, legacy } = await fixture();
    expect(resolveDevRyanDataRoot({ env: {}, home })).toBe(root);
    await fs.mkdir(legacy);
    expect(isLegacyDataRootInPlace(home)).toBe(true);
    expect(resolveDevRyanDataRoot({ env: { DEVRYAN_DATA_DIR: legacy }, home })).toBe(legacy);
    await fs.rename(legacy, root);
    await fs.symlink('devryan', legacy);
    expect(isLegacyDataRootInPlace(home)).toBe(false);
    expect(resolveDevRyanDataRoot({ env: {}, home })).toBe(root);
    await fs.unlink(legacy);
    await fs.writeFile(legacy, 'not a folder');
    expect(resolveDevRyanDataRoot({ env: {}, home })).toBe(root);
  });
});
