import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stopRetiredBots } from '../bot-retirement.mjs';
import { prepareBotRuntimeReleaseManifest } from '../scripts/stage-bot-manifest.mjs';
import { assertBotsEnabled } from '../../shared-runtime/lib/product-capabilities.js';

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
const dataRoot = async ({ key = false } = {}) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-bot-retirement-'));
  roots.push(root);
  if (key) {
    await fs.mkdir(path.join(root, 'bots', 'keys'), { recursive: true });
    await fs.writeFile(path.join(root, 'bots', 'keys', 'deployment-key.v1'), 'sealed');
  }
  return root;
};
const retired = root => fs.access(path.join(root, 'bots', 'retired.v1')).then(() => true, () => false);
const keyRemoved = root => fs.access(path.join(root, 'bots', 'keys')).then(() => false, () => true);
const noDocker = async () => { throw new Error('Must not probe Docker'); };

test('retirement requires no manifest and cannot be overridden by settings', async () => {
  await prepareBotRuntimeReleaseManifest({ required: true });
  expect(assertBotsEnabled).toThrow('Bots are retired.');
});

test('retirement leaves absent installations alone and never runs again', async () => {
  const root = await dataRoot();
  expect(await stopRetiredBots({ dataDirectory: root, run: noDocker })).toEqual({ status: 'absent' });
  expect(await retired(root)).toBe(true);
  expect(await stopRetiredBots({ dataDirectory: root, run: noDocker })).toEqual({ status: 'retired' });
});

test('retirement stops Bot containers once, retains their data, and deletes the deployment key', async () => {
  const root = await dataRoot({ key: true });
  const calls = [], id = 'a'.repeat(64);
  const result = await stopRetiredBots({ dataDirectory: root,
    run: async (command, args, options) => {
      calls.push([command, args]);
      expect(options.signal).toBeInstanceOf(AbortSignal);
      return { stdout: args[0] === 'ps' ? `${id}\n` : '' };
    } });
  expect(result).toEqual({ status: 'stopped', count: 1 });
  expect(calls).toEqual([
    ['docker', ['ps', '--all', '--quiet', '--no-trunc', '--filter', 'label=devryan.runtime=production-bots']],
    ['docker', ['update', '--restart=no', id]], ['docker', ['stop', '--time', '5', id]],
  ]);
  expect(await keyRemoved(root)).toBe(true);
  expect(await stopRetiredBots({ dataDirectory: root, run: noDocker })).toEqual({ status: 'retired' });
});

test('a missing Docker CLI retires; a stopped Docker daemon is retried next launch', async () => {
  const missing = await dataRoot({ key: true });
  expect(await stopRetiredBots({ dataDirectory: missing,
    run: async () => { throw Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' }); } })).toEqual({ status: 'absent' });
  expect(await retired(missing)).toBe(true);
  const stopped = await dataRoot({ key: true });
  expect(await stopRetiredBots({ dataDirectory: stopped,
    run: async () => { throw Object.assign(new Error('Docker stopped'), { code: 1 }); } })).toEqual({ status: 'unavailable' });
  expect(await retired(stopped)).toBe(false);
  expect(await keyRemoved(stopped)).toBe(false);
});
