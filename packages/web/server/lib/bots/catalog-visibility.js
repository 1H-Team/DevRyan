// Catalog presentation, not authorization. All membership and channel checks
// still apply to test accounts. Never infer fixture status from a Bot's name.
const CACHE_LIMIT = 512;
const CACHE_TTL_MS = 60_000;

export function createBotCatalogVisibility({ store, now = Date.now }) {
  const decisions = new Map();
  const cacheKey = (principal, botId) => `${principal.id}:${botId}`;
  const remember = (principal, botId, visible) => {
    const key = cacheKey(principal, botId);
    decisions.delete(key);
    decisions.set(key, { visible, expiresAt: now() + CACHE_TTL_MS });
    while (decisions.size > CACHE_LIMIT) decisions.delete(decisions.keys().next().value);
  };

  const filterBots = async (principal, bots) => {
    if (bots.length === 0) return bots;
    const kinds = await store.listUserAccountKinds([
      principal.id, ...bots.map((bot) => bot.created_by).filter(Boolean),
    ]);
    const testViewer = kinds.get(principal.id) === 'agent_test';
    return bots.filter((bot) => {
      const visible = testViewer || kinds.get(bot.created_by) !== 'agent_test';
      remember(principal, bot.id, visible);
      return visible;
    });
  };

  const isVisible = async (principal, botId) => {
    if (!botId) return true;
    const cached = decisions.get(cacheKey(principal, botId));
    if (cached && cached.expiresAt > now()) return cached.visible;
    const bot = await store.get('bots', { id: botId });
    // Removal events must reach an existing view even after the row is gone.
    if (!bot) return true;
    return (await filterBots(principal, [bot])).length > 0;
  };

  const filterSnapshot = async (principal, snapshot) => {
    const botIds = new Set((snapshot.bots || []).map((bot) => bot.id));
    for (const rows of Object.values(snapshot)) {
      if (Array.isArray(rows)) for (const row of rows) if (row?.botId) botIds.add(row.botId);
    }
    const hidden = new Set();
    await Promise.all([...botIds].map(async (id) => { if (!await isVisible(principal, id)) hidden.add(id); }));
    if (hidden.size === 0) return snapshot;
    const hiddenChannels = new Set((snapshot.channels || []).filter((channel) => hidden.has(channel.botId)).map((channel) => channel.id));
    return Object.fromEntries(Object.entries(snapshot).map(([key, rows]) => [key, Array.isArray(rows)
      ? rows.filter((row) => !hidden.has(key === 'bots' ? row.id : row?.botId) && !hiddenChannels.has(row?.channelId))
      : rows]));
  };

  return Object.freeze({ filterBots, filterSnapshot, isVisible });
}
