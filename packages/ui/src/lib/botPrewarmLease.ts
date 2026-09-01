import { botsApi, type BotsApi, type BotPrewarmState } from './botsApi';

type CachedLease = Readonly<{
  state: BotPrewarmState;
  promise: Promise<BotPrewarmState> | null;
}>;

const isUsable = (state: BotPrewarmState) => (
  state.leaseId !== null
  && state.expiresAt !== null
  && Date.parse(state.expiresAt) > Date.now()
);

export const createBotPrewarmLeaseManager = (api: Pick<BotsApi, 'prewarmChannel' | 'releasePrewarmChannel'> = botsApi) => {
  const leases = new Map<string, CachedLease>();

  const warmBotChannel = (channelId: string): Promise<BotPrewarmState> => {
    const current = leases.get(channelId);
    if (current?.promise) return current.promise;
    if (current && isUsable(current.state)) return Promise.resolve(current.state);
    const promise = api.prewarmChannel(channelId).then((state) => {
      // Release/channel changes invalidate this exact request. A late warm reply
      // still resolves for cleanup, but must not recreate a consumable lease.
      if (leases.get(channelId)?.promise === promise) {
        leases.set(channelId, { state, promise: null });
      }
      return state;
    }).catch((error) => {
      if (leases.get(channelId)?.promise === promise) leases.delete(channelId);
      throw error;
    });
    leases.set(channelId, {
      state: { state: 'warming', leaseId: null, revisionId: '', expiresAt: null, reason: null },
      promise,
    });
    return promise;
  };

  const takeBotPrewarmLease = (channelId: string): string | null => {
    const current = leases.get(channelId);
    if (!current || !isUsable(current.state)) return null;
    leases.delete(channelId);
    return current.state.leaseId;
  };

  const releaseBotChannelPrewarm = async (channelId: string): Promise<void> => {
    const current = leases.get(channelId);
    leases.delete(channelId);
    const state = current?.promise ? await current.promise.catch(() => null) : current?.state;
    if (!state?.leaseId) return;
    const replacement = leases.get(channelId);
    const replacementState = replacement?.promise
      ? await replacement.promise.catch(() => null)
      : replacement?.state;
    if (replacementState?.leaseId === state.leaseId) return;
    await api.releasePrewarmChannel(channelId, state.leaseId).catch(() => undefined);
  };

  return { warmBotChannel, takeBotPrewarmLease, releaseBotChannelPrewarm, reset: () => leases.clear() };
};

const manager = createBotPrewarmLeaseManager();
export const { warmBotChannel, takeBotPrewarmLease, releaseBotChannelPrewarm } = manager;
export const resetBotPrewarmLeasesForTests = manager.reset;
