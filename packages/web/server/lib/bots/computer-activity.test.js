import { describe, expect, test } from 'vitest';
import { createBotComputerActivity } from './computer-activity.js';

describe('channel-authorized ephemeral computer activity', () => {
  test('fences old automatic viewers before publishing and ignores a previous run completion', async () => {
    const events = []; const closed = [];
    const activity = createBotComputerActivity({
      authorization: { requireChannelRead: async () => {} },
      audienceForChannel: async (id) => [`owner:${id}`],
      publish: async (event) => events.push(event),
      closeViews: (botId, runId) => closed.push([botId, runId]),
    });
    const first = { bot_id: 'bot', channel_id: 'a', id: 'run-a' };
    const second = { bot_id: 'bot', channel_id: 'b', id: 'run-b' };
    await activity.begin(first);
    const handoff = activity.begin(second);
    expect(closed).toEqual([['bot', 'run-a'], ['bot', 'run-b']]);
    await handoff;
    await activity.endRun(first);
    expect(activity.get('bot').runId).toBe('run-b');
    expect(events.map((e) => [e.channelId, e.payload.activity.state])).toEqual([['a', 'active'], ['a', 'idle'], ['b', 'active']]);
    expect(events[1].payload.activity.revision).toBeLessThan(events[2].payload.activity.revision);
    expect(events[2].audienceUserIds).toEqual(['owner:b']);
    await activity.endRun(second);
    expect(activity.get('bot')).toBeNull();
    expect(closed.at(-1)).toEqual(['bot', null]);
  });
  test('snapshots omit revoked and replaced ownership and contain no screen data', async () => {
    let resolve;
    const authorized = new Promise((r) => { resolve = r; });
    const activity = createBotComputerActivity({
      audienceForChannel: async () => [], publish: async () => {},
      authorization: { requireChannelRead: async (principal, _bot, channel) => { if (principal.id !== channel) throw Error('denied'); await authorized; } },
    });
    await activity.begin({ bot_id: 'bot', channel_id: 'a', id: 'first' });
    const snapshot = activity.snapshotForPrincipal({ id: 'a' });
    await activity.begin({ bot_id: 'bot', channel_id: 'b', id: 'second' });
    resolve();
    expect(await snapshot).toEqual({ computerActivity: [] });
    expect(await activity.snapshotForPrincipal({ id: 'a' })).toEqual({ computerActivity: [] });
    const visible = await activity.snapshotForPrincipal({ id: 'b' });
    expect(Object.keys(visible.computerActivity[0]).sort()).toEqual(['botId', 'channelId', 'revision', 'runId', 'state']);
  });
});
