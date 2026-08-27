import { describe, expect, it, vi } from 'vitest';

import {
  botChannelMemoryNamespace,
  botPrivateMemoryNamespace,
  botSharedMemoryNamespace,
  createBotIndexerClient,
} from './indexer-client.js';

const BOT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const CHANNEL_ID = '33333333-3333-4333-8333-333333333333';

describe('Bot indexer client', () => {
  it('constructs exact shared, private, and channel namespaces', () => {
    expect(botSharedMemoryNamespace(BOT_ID)).toBe(`bot:${BOT_ID}`);
    expect(botPrivateMemoryNamespace(BOT_ID, USER_ID)).toBe(`bot:${BOT_ID}:user:${USER_ID}`);
    expect(botChannelMemoryNamespace(CHANNEL_ID)).toBe(`channel:${CHANNEL_ID}`);
  });

  it('delegates only validated bounded operations to the Electron host', async () => {
    const request = vi.fn(async ({ operation }) => ({ operation, changed: true }));
    const client = createBotIndexerClient({ request });
    await client.upsert({
      namespace: botSharedMemoryNamespace(BOT_ID),
      documentId: 'memory:one',
      version: 'version-1',
      text: 'A reusable deployment fact.',
      metadata: { memoryId: 'one' },
    });
    await client.delete({
      namespace: botSharedMemoryNamespace(BOT_ID),
      documentId: 'memory:one',
      version: 'version-1',
    });
    expect(request).toHaveBeenNthCalledWith(1, expect.objectContaining({
      operation: 'upsert',
      body: { document: expect.objectContaining({ text: 'A reusable deployment fact.' }) },
    }));
    expect(request).toHaveBeenNthCalledWith(2, expect.objectContaining({ operation: 'delete' }));
  });

  it('rejects namespace widening before any host request', () => {
    const request = vi.fn();
    const client = createBotIndexerClient({ request });
    expect(() => client.search({ namespaces: [`bot:${BOT_ID}:*`], query: 'deployment' }))
      .toThrow(expect.objectContaining({ code: 'bot_indexer_request_invalid' }));
    expect(request).not.toHaveBeenCalled();
  });

  it('performs a deterministic full rebuild through one bounded request', async () => {
    const request = vi.fn(async () => ({ documentCount: 1 }));
    const client = createBotIndexerClient({ request });
    await expect(client.rebuild([{
      namespace: botPrivateMemoryNamespace(BOT_ID, USER_ID),
      documentId: 'memory:private',
      version: 'version-2',
      text: 'A private preference.',
      metadata: {},
    }])).resolves.toEqual({ documentCount: 1 });
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'rebuild',
      body: { documents: [expect.objectContaining({ documentId: 'memory:private' })] },
    }));
  });
});
