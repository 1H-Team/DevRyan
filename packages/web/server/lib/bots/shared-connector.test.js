import { describe, expect, it, vi } from 'vitest';

import { createBotSharedConnector } from './shared-connector.js';

const BOT_ID = 'b0000000-0000-4000-8000-000000000001';
const CHANNEL_ID = 'c0000000-0000-4000-8000-000000000001';
const RUN_ID = 'd0000000-0000-4000-8000-000000000001';
const USER_ID = 'a0000000-0000-4000-8000-000000000001';

describe('Bot explicit Shared publication connector', () => {
  it('validates canonical bounded bytes and publishes only the named file', async () => {
    let receivedBytes = null;
    const publishBotFile = vi.fn(async ({ bytes }) => {
      receivedBytes = Buffer.from(bytes);
      return {
        id: 'e0000000-0000-4000-8000-000000000001',
        filename: 'result.txt',
        copyState: 'ready',
      };
    });
    const connector = createBotSharedConnector({ sharedFileService: { publishBotFile } });
    const contentBase64 = Buffer.from('exact result').toString('base64');
    const validated = await connector.validate({
      action: 'publish',
      target: {
        filename: 'result.txt',
        contentType: 'text/plain',
        goal: 'Publish this file to the current conversation Shared folder',
      },
      args: { contentBase64 },
    });
    expect(validated).toMatchObject({ operationKind: 'write' });

    const execution = await connector.execute({
      botId: BOT_ID,
      channelId: CHANNEL_ID,
      runId: RUN_ID,
      principalId: USER_ID,
      action: 'publish',
      target: validated.target,
      args: validated.args,
    });
    expect(publishBotFile).toHaveBeenCalledWith(expect.objectContaining({
      botId: BOT_ID,
      channelId: CHANNEL_ID,
      runId: RUN_ID,
      principalId: USER_ID,
      filename: 'result.txt',
    }));
    expect(receivedBytes).toEqual(Buffer.from('exact result'));
    expect(execution).toMatchObject({
      result: { sharedFile: { filename: 'result.txt', copyState: 'ready' } },
      connectorReceipt: { nativeExactlyOnce: false, writeGuarantee: 'durable_shared_mapping' },
    });
  });

  it('rejects non-canonical publication content', async () => {
    const connector = createBotSharedConnector({
      sharedFileService: { publishBotFile: vi.fn() },
    });
    await expect(connector.validate({
      action: 'publish',
      target: {
        filename: 'result.txt',
        contentType: 'text/plain',
        goal: 'Publish this file to the current conversation Shared folder',
      },
      args: { contentBase64: 'not base64' },
    })).rejects.toMatchObject({ code: 'bot_shared_publication_invalid' });
  });
});
