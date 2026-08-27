import { describe, expect, it, vi } from 'vitest';

import { createBotWorkspaceConnector } from './workspace-connector.js';

const BOT_ID = 'b0000000-0000-4000-8000-000000000001';
const CHANNEL_ID = 'c0000000-0000-4000-8000-000000000001';

describe('Bot workspace connector', () => {
  it('validates, authorizes, and writes only one bounded top-level file', async () => {
    const writeWorkspace = vi.fn(async (input) => ({
      written: true,
      path: input.path,
      bytes: Buffer.byteLength(input.content),
      sha256: 'a'.repeat(64),
    }));
    const connector = createBotWorkspaceConnector({ dockerProvider: { writeWorkspace } });
    const validated = await connector.validate({
      action: 'write',
      target: { path: 'approval-check.txt' },
      args: { content: 'BOT_APPROVAL_OK' },
    });
    expect(validated).toEqual({
      target: { path: 'approval-check.txt' },
      args: { content: 'BOT_APPROVAL_OK' },
      operationKind: 'write',
    });
    await expect(connector.authorize({
      action: { tool: 'connector:workspace', action: 'write' },
      policyDecision: { operationKind: 'write' },
    })).resolves.toEqual({ authorized: true });
    await expect(connector.execute({
      botId: BOT_ID,
      channelId: CHANNEL_ID,
      target: { ...validated.target, operationKind: 'write' },
      args: validated.args,
    })).resolves.toMatchObject({
      result: { written: true, path: 'approval-check.txt', bytes: 15 },
      connectorReceipt: { writeGuarantee: 'idempotent_content_replace' },
    });
    expect(writeWorkspace).toHaveBeenCalledWith({
      botId: BOT_ID,
      channelId: CHANNEL_ID,
      path: 'approval-check.txt',
      content: 'BOT_APPROVAL_OK',
    });
  });

  it('denies traversal and marks only uncertain host transport failures for reconciliation', async () => {
    const error = Object.assign(new Error('lost response'), {
      code: 'bot_runtime_supervisor_unavailable',
    });
    const connector = createBotWorkspaceConnector({
      dockerProvider: { writeWorkspace: vi.fn(async () => { throw error; }) },
    });
    await expect(connector.validate({
      action: 'write',
      target: { path: '../outside' },
      args: { content: 'blocked' },
    })).rejects.toMatchObject({ code: 'bot_workspace_write_invalid' });
    await expect(connector.execute({
      botId: BOT_ID,
      channelId: CHANNEL_ID,
      target: { path: 'safe.txt' },
      args: { content: 'value' },
    })).rejects.toBe(error);
    expect(error.transportUncertain).toBe(true);
  });
});
