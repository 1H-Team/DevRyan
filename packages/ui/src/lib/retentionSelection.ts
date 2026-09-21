/** Serialize protection and fence every navigation, including draft round trips. */
export function createRetentionSelection(
  send: (sessionID: string | null, revision: number, committed: boolean) => Promise<unknown>,
  current: () => string | null,
) {
  let queue = Promise.resolve();
  let generation = 0;
  let revision = 0;
  let pending: number | undefined;
  let applying = false;
  const protect = (sessionID: string | null, token: number, apply?: () => void) => {
    const version = ++revision;
    const valid = () => token === generation && (apply ? pending === token : pending === undefined && current() === sessionID);
    const result = queue.then(async () => {
      if (!valid()) return;
      await send(sessionID, version, false);
      if (!valid()) return;
      if (apply) {
        applying = true;
        try { apply(); } finally { applying = false; }
      }
      if (token === generation && current() === sessionID) await send(sessionID, version, true);
    });
    queue = result.catch(() => {});
    return result;
  };
  return {
    observe: (sessionID: string | null) => protect(sessionID, generation),
    // Called synchronously by the store, even when currentSessionId stays null
    // through draft A -> B -> A and React never sees an intermediate render.
    navigationChanged: () => {
      if (applying) return false;
      generation++; pending = undefined;
      return true;
    },
    select: (sessionID: string | null, apply: () => void, onError: (error: Error) => void) => {
      const token = ++generation;
      pending = token;
      const result = protect(sessionID, token, apply).catch((error: unknown) => {
        if (token === generation) onError(error instanceof Error ? error : new Error('Could not protect this session'));
      }).finally(() => {
        if (pending !== token) return;
        pending = undefined;
        if (current() !== sessionID) void protect(current(), generation).catch(() => {});
      });
      // Include request retirement in the queue: subsequent observations must
      // see the completed request cleared, including after failed protection.
      queue = result.catch(() => {});
    },
    settled: () => queue,
  };
}
