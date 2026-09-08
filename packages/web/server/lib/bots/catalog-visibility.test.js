import { describe, expect, it, vi } from 'vitest';
import { createBotCatalogVisibility } from './catalog-visibility.js';
import { createBotEventStream } from './event-stream.js';

const human = { id: 'human', role: 'admin' };
const fixtureUser = { id: 'fixture-user', role: 'admin' };
const bots = [
  { id: 'real', name: 'Verify Bot', created_by: human.id },
  { id: 'fixture', name: 'Verify Bot', created_by: fixtureUser.id },
  { id: 'e2e', name: 'Bot End-to-End', created_by: fixtureUser.id },
];
const setup = () => {
  const store = {
    get: vi.fn(async (_table, { id }) => bots.find((bot) => bot.id === id)),
    listUserAccountKinds: vi.fn(async () => new Map([[human.id, 'human'], [fixtureUser.id, 'agent_test']])),
  };
  return { store, visibility: createBotCatalogVisibility({ store }) };
};

describe('Bot fixture catalog visibility', () => {
  it('uses creator account kind for human admins and members, never matching names', async () => {
    const { visibility, store } = setup();
    for (const role of ['admin', 'developer']) {
      expect(await visibility.filterBots({ ...human, role }, bots)).toEqual([bots[0]]);
    }
    expect(await visibility.filterBots(fixtureUser, bots)).toEqual(bots);
    expect(store.listUserAccountKinds).toHaveBeenCalledTimes(3);
  });

  it('filters every snapshot projection and live events without widening the audience', async () => {
    const { visibility, store } = setup();
    const snapshot = {
      bots, channels: [{ id: 'private', botId: 'fixture' }, { id: 'normal', botId: 'real' }],
      channelPreviews: [{ channelId: 'private', text: 'fixture' }, { channelId: 'normal', text: 'normal' }],
      memberships: [{ botId: 'fixture' }, { botId: 'real' }],
      pendingApprovals: [{ botId: 'fixture' }], computerActivity: [{ botId: 'fixture', channelId: 'private' }],
    };
    const stream = createBotEventStream({ loadSnapshot: async () => snapshot, filterSnapshot: visibility.filterSnapshot, canDeliver: visibility.isVisible });
    const humanEvents = [], testEvents = [];
    await stream.open({ principal: human, send: async (event) => humanEvents.push(event) });
    await stream.open({ principal: fixtureUser, send: async (event) => testEvents.push(event) });
    expect(humanEvents[0].payload).toEqual({ bots: [bots[0]], channels: [snapshot.channels[1]], channelPreviews: [snapshot.channelPreviews[1]], memberships: [{ botId: 'real' }], pendingApprovals: [], computerActivity: [] });
    expect(testEvents[0].payload).toEqual(snapshot);
    const reads = store.listUserAccountKinds.mock.calls.length;
    await stream.publish({ kind: 'bot.updated', botId: 'fixture', audienceUserIds: [human.id, fixtureUser.id], payload: { bot: bots[1] } });
    expect(humanEvents).toHaveLength(1);
    expect(testEvents).toHaveLength(2);
    expect(store.listUserAccountKinds).toHaveBeenCalledTimes(reads);
    await stream.publish({ kind: 'bot.updated', botId: 'real', audienceUserIds: [human.id], payload: { bot: bots[0] } });
    expect(humanEvents).toHaveLength(2);
    expect(testEvents).toHaveLength(2);
    stream.shutdown();
  });

  it('does not expose fixture rows when the classification read fails', async () => {
    const { visibility, store } = setup();
    store.listUserAccountKinds.mockRejectedValueOnce(new Error('directory unavailable'));
    await expect(visibility.filterBots(human, bots)).rejects.toThrow('directory unavailable');
  });
});
