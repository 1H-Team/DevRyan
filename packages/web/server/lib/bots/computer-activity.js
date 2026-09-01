// Ephemeral ownership only. Pixels, URLs and action arguments never enter this projection.
export function createBotComputerActivity({ audienceForChannel, authorization, publish, closeViews = () => {} }) {
  const current = new Map();
  let revision = 0;
  const emit = async (activity) => {
    await publish({
      kind: 'computer.activity', botId: activity.botId, channelId: activity.channelId,
      audienceUserIds: await audienceForChannel(activity.channelId), payload: { activity },
    });
  };
  return Object.freeze({
    get: (botId) => current.get(botId) ?? null,
    async begin(run, state = 'active') {
      const previous = current.get(run.bot_id);
      if (previous?.runId === run.id && previous.state === state) return previous;
      const retiredRevision = previous && previous.runId !== run.id ? ++revision : null;
      const activity = Object.freeze({
        botId: run.bot_id, channelId: run.channel_id, runId: run.id,
        revision: ++revision, state,
      });
      current.set(run.bot_id, activity);
      // Fence old automatic viewers before any asynchronous work or next browser command.
      closeViews(run.bot_id, run.id);
      if (previous && previous.runId !== run.id) {
        await emit({ ...previous, revision: retiredRevision, state: 'idle' });
      }
      await emit(activity);
      return activity;
    },
    async endRun(run) {
      const previous = current.get(run.bot_id);
      if (!previous || previous.runId !== run.id) return;
      current.delete(run.bot_id);
      closeViews(run.bot_id, null);
      await emit({ ...previous, revision: ++revision, state: 'idle' });
    },
    async removeBot(botId) {
      const previous = current.get(botId);
      if (previous) await this.endRun({ bot_id: botId, id: previous.runId });
    },
    async snapshotForPrincipal(principal) {
      const activities = [];
      for (const activity of current.values()) {
        try {
          await authorization.requireChannelRead(principal, activity.botId, activity.channelId);
          if (current.get(activity.botId) === activity) activities.push(activity);
        } catch { /* Revoked or unrelated channels have no activity projection. */ }
      }
      return { computerActivity: activities };
    },
    clear() { current.clear(); },
  });
}
