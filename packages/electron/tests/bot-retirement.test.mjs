import { expect, test } from 'bun:test';
import { stopRetiredBots } from '../bot-retirement.mjs';
import { prepareBotRuntimeReleaseManifest } from '../scripts/stage-bot-manifest.mjs';
import { assertBotsEnabled } from '../../shared-runtime/lib/product-capabilities.js';

test('retirement requires no manifest and cannot be overridden by settings', async () => {
  await prepareBotRuntimeReleaseManifest({ required: true });
  expect(assertBotsEnabled).toThrow('Bots are retired.');
});

test('retirement leaves absent installations alone', async () => {
  expect(await stopRetiredBots({ readDeploymentId: async () => null,
    run: async () => { throw new Error('Must not probe Docker'); } })).toEqual({ status: 'absent' });
});

test('retirement stops only containers scoped to the existing deployment and retains their data', async () => {
  const calls = [], id = 'a'.repeat(64), deployment = `deployment-${'b'.repeat(24)}`;
  const result = await stopRetiredBots({ readDeploymentId: async () => deployment,
    run: async (command, args, options) => {
      calls.push([command, args]);
      expect(options.signal).toBeInstanceOf(AbortSignal);
      return { stdout: args[0] === 'ps' ? `${id}\n` : '' };
    } });
  expect(result).toEqual({ status: 'stopped', count: 1 });
  expect(calls).toEqual([
    ['docker', ['ps', '--all', '--quiet', '--no-trunc', '--filter', 'label=devryan.runtime=production-bots', '--filter', `label=devryan.deployment=${deployment}`]],
    ['docker', ['update', '--restart=no', id]], ['docker', ['stop', '--time', '5', id]],
  ]);
});

test('failed cleanup is nonthrowing and cannot become a startup failure', async () => {
  expect(await stopRetiredBots({ readDeploymentId: async () => { throw new Error('Key unavailable'); } }))
    .toEqual({ status: 'unavailable' });
  expect(await stopRetiredBots({ readDeploymentId: async () => `deployment-${'a'.repeat(24)}`,
    run: async () => { throw new Error('Docker stopped'); } })).toEqual({ status: 'unavailable' });
});
