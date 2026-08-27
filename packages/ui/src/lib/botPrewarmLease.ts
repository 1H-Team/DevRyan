import { botsApi, type BotPrewarmState } from './botsApi';

type CachedLease = Readonly<{
  state: BotPrewarmState;
  promise: Promise<BotPrewarmState> | null;
}>;

const leases = new Map<string, CachedLease>();

const isUsable = (state: BotPrewarmState) => (
  state.leaseId !== null
  && state.expiresAt !== null
  && Date.parse(state.expiresAt) > Date.now()
);

export const warmBotChannel = (channelId: string): Promise<BotPrewarmState> => {
  const current = leases.get(channelId);
  if (current?.promise) return current.promise;
  if (current && isUsable(current.state)) return Promise.resolve(current.state);
  const promise = botsApi.prewarmChannel(channelId).then((state) => {
    leases.set(channelId, { state, promise: null });
    return state;
  }).catch((error) => {
    leases.delete(channelId);
    throw error;
  });
  leases.set(channelId, {
    state: { state: 'warming', leaseId: null, revisionId: '', expiresAt: null, reason: null },
    promise,
  });
  return promise;
};

export const takeBotPrewarmLease = (channelId: string): string | null => {
  const current = leases.get(channelId);
  if (!current || !isUsable(current.state)) return null;
  leases.delete(channelId);
  return current.state.leaseId;
};

export const releaseBotChannelPrewarm = async (channelId: string): Promise<void> => {
  const current = leases.get(channelId);
  leases.delete(channelId);
  const state = current?.promise ? await current.promise.catch(() => null) : current?.state;
  if (!state?.leaseId) return;
  const replacement = leases.get(channelId);
  const replacementState = replacement?.promise
    ? await replacement.promise.catch(() => null)
    : replacement?.state;
  if (replacementState?.leaseId === state.leaseId) return;
  await botsApi.releasePrewarmChannel(channelId, state.leaseId).catch(() => undefined);
};

export const resetBotPrewarmLeasesForTests = () => leases.clear();
