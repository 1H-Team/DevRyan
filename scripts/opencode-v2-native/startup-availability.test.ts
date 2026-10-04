import { expect, test } from 'bun:test';
import { assertNativeCatalog } from '../../packages/web/server/lib/opencode/runtime-host/startup-catalog.ts';

test('an empty catalog allows provider setup and retains the exact unavailable saved selection', async () => {
  const selection = { source: { kind: 'agent' as const, id: 'builder' }, providerID: 'openai', modelID: 'saved-model', variant: 'high' };
  const result = await assertNativeCatalog({ directories: ['/isolated/project'],
    requirements: { agents: [], plugins: [], tools: [], models: [], selections: [selection] },
    handler: async () => Response.json({ location: { directory: '/isolated/project' }, data: [] }), tools: async () => [],
  });
  expect(result.asserted).toBe(true);
  expect(result.availability.selections).toEqual([{ directory: '/isolated/project', ...selection, status: 'unavailable', reason: 'provider_missing' }]);
});

test('malformed and foreign location catalogs remain intrinsic startup failures', async () => {
  for (const body of [{ location: { directory: '/foreign' }, data: [] }, { location: { directory: '/isolated/project' }, data: {} }]) {
    await expect(assertNativeCatalog({ directories: ['/isolated/project'], requirements: { agents: [], plugins: [], tools: [], models: [] },
      handler: async () => Response.json(body), tools: async () => [],
    })).rejects.toThrow();
  }
});
