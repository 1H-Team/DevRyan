import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { botsApi, type BotPrewarmState } from './botsApi';
import { releaseBotChannelPrewarm, resetBotPrewarmLeasesForTests, takeBotPrewarmLease, warmBotChannel } from './botPrewarmLease';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const state = (leaseId: string): BotPrewarmState => ({
  state: 'ready', leaseId, revisionId: 'revision', expiresAt: new Date(Date.now() + 120_000).toISOString(), reason: null,
});
afterEach(() => { resetBotPrewarmLeasesForTests(); });

describe('Bot prewarm request ownership', () => {
  test('releasing an in-flight warm cannot resurrect the returned lease', async () => {
    const pending = deferred<BotPrewarmState>();
    const warm = spyOn(botsApi, 'prewarmChannel').mockImplementation(() => pending.promise);
    const release = spyOn(botsApi, 'releasePrewarmChannel').mockResolvedValue({ released: true });
    try {
      const request = warmBotChannel('channel');
      const released = releaseBotChannelPrewarm('channel');
      pending.resolve(state('old'));
      await Promise.all([request, released]);
      expect(takeBotPrewarmLease('channel')).toBeNull();
      expect(release).toHaveBeenCalledWith('channel', 'old');
    } finally { warm.mockRestore(); release.mockRestore(); }
  });

  test('old request rejection does not delete a replacement warm', async () => {
    const old = deferred<BotPrewarmState>();
    const next = deferred<BotPrewarmState>();
    const warm = spyOn(botsApi, 'prewarmChannel').mockImplementationOnce(() => old.promise).mockImplementationOnce(() => next.promise);
    try {
      const first = warmBotChannel('channel').catch(() => null);
      const released = releaseBotChannelPrewarm('channel');
      const second = warmBotChannel('channel');
      old.reject(new Error('old failed'));
      next.resolve(state('new'));
      await Promise.all([first, released, second]);
      expect(takeBotPrewarmLease('channel')).toBe('new');
    } finally { warm.mockRestore(); }
  });
});
