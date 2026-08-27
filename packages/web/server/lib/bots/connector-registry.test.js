import { describe, expect, it, vi } from 'vitest';

import {
  BOT_CONNECTOR_METHODS,
  createBotConnectorRegistry,
} from './connector-registry.js';

const connector = (id = 'fixture') => ({
  id,
  describeActions: vi.fn(async () => [{ name: 'lookup', operationKind: 'read' }]),
  validate: vi.fn(async (input) => ({ ...input, validated: true })),
  authorize: vi.fn(async () => ({ authorized: true })),
  execute: vi.fn(async () => ({ receiptId: 'receipt-1' })),
  reconcile: vi.fn(async () => ({ state: 'complete' })),
  revoke: vi.fn(async () => ({ revoked: true })),
});

describe('Bot connector registry', () => {
  it('ships with zero production connectors and denies an unregistered connector', async () => {
    const registry = createBotConnectorRegistry();

    expect(registry.ids()).toEqual([]);
    await expect(registry.execute('gmail', { action: 'send' })).rejects.toMatchObject({
      code: 'bot_connector_unregistered',
      statusCode: 403,
    });
  });

  it('requires the complete connector lifecycle contract', () => {
    expect(BOT_CONNECTOR_METHODS).toEqual([
      'describeActions',
      'validate',
      'authorize',
      'execute',
      'reconcile',
      'revoke',
    ]);
    expect(() => createBotConnectorRegistry({
      connectors: [{ ...connector(), revoke: undefined }],
    })).toThrow(/contract/i);
  });

  it('forwards cloned JSON values through every registered operation', async () => {
    const fixture = connector();
    const registry = createBotConnectorRegistry({ connectors: [fixture] });
    const input = { action: 'lookup', args: { account: 'support' } };

    await expect(registry.validate('fixture', input)).resolves.toMatchObject({ validated: true });
    await expect(registry.authorize('fixture', input)).resolves.toEqual({ authorized: true });
    await expect(registry.execute('fixture', input)).resolves.toEqual({ receiptId: 'receipt-1' });
    await expect(registry.reconcile('fixture', input)).resolves.toEqual({ state: 'complete' });
    await expect(registry.revoke('fixture', input)).resolves.toEqual({ revoked: true });
    await expect(registry.describeActions()).resolves.toEqual([{
      connectorId: 'fixture',
      actions: [{ name: 'lookup', operationKind: 'read' }],
    }]);

    input.args.account = 'changed-after-call';
    expect(fixture.validate.mock.calls[0][0].args.account).toBe('support');
  });
});
