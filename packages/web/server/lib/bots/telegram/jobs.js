const LIMITS = Object.freeze({
  command: { group: 'control', global: 2, perBot: 1 },
  message: { group: 'ingress', global: 8, perBot: 3 },
  media: { group: 'ingress', global: 3, perBot: 1 },
  voice: { group: 'ingress', global: 2, perBot: 1 },
  reconcile: { group: 'reconcile', global: 4, perBot: 1 },
  delivery: { group: 'delivery', global: 4, perBot: 2 },
  synthesis: { group: 'synthesis', global: 2, perBot: 1 },
});
const GROUP_LIMITS = Object.freeze({ ingress: { global: 8, perBot: 4 } });

/** No queued payloads: callers retain durable rows and retry fair scans later. */
export function createTelegramJobScheduler() {
  const active = new Map();
  return Object.freeze({
    has: (id) => active.has(id),
    active: () => [...active.values()].map(({ metadata }) => metadata),
    start({ id, botId, pairingId, userId, generation, lane, operation }) {
      const limit = LIMITS[lane];
      if (!limit || typeof operation !== 'function') throw new TypeError('Invalid Telegram job');
      if (active.has(id)) return null;
      const entries = [...active.values()].map(({ metadata }) => metadata);
      const sameLane = entries.filter((entry) => entry.lane === lane);
      if (sameLane.length >= limit.global || sameLane.filter((entry) => entry.botId === botId).length >= limit.perBot) return null;
      const group = GROUP_LIMITS[limit.group];
      const sameGroup = entries.filter((entry) => LIMITS[entry.lane].group === limit.group);
      if (group && (sameGroup.length >= group.global || sameGroup.filter((entry) => entry.botId === botId).length >= group.perBot)) return null;
      const controller = new AbortController();
      const metadata = Object.freeze({ id, botId, pairingId, userId, generation, lane });
      const entry = { metadata, controller, promise: null };
      const promise = Promise.resolve().then(() => operation(controller.signal)).finally(() => {
        if (active.get(id) === entry) active.delete(id);
      });
      entry.promise = promise;
      active.set(id, entry);
      void promise.catch(() => undefined);
      return promise;
    },
    abortWhere(predicate, reason) {
      for (const { metadata, controller } of active.values()) if (predicate(metadata)) controller.abort(reason);
    },
    wait: () => Promise.allSettled([...active.values()].map(({ promise }) => promise)),
  });
}
