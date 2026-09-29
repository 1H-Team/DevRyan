export class SelectionSupersededError extends Error {
  readonly code = 'selection_superseded';
  constructor() { super('selection_superseded'); }
}

export type SelectionOptions = {
  expectedNavigationRevision?: number;
  onApplied?: () => void;
};

type Operation = {
  sessionID: string | null;
  generation: number;
  controller: AbortController;
  promise: Promise<void>;
};

/** Revisions fence server delivery; generations fence local navigation. No HTTP
 * acknowledgement for an older selection can delay a newer user intent. */
export function createRetentionSelection(
  send: (sessionID: string | null, revision: number, committed: boolean, signal: AbortSignal) => Promise<unknown>,
  current: () => string | null,
  pendingChanged: (sessionID: string | null) => void = () => {},
) {
  let generation = 0;
  let revision = 0;
  let pending: string | null = null;
  let applying = false;
  let restartPending: (() => void) | undefined;
  let operation: Operation | undefined;
  let acknowledged: { sessionID: string | null; generation: number } | undefined;

  const applySynchronously = (apply: () => void) => {
    applying = true;
    try { apply(); } finally { applying = false; }
  };
  const supersede = () => {
    generation++;
    operation?.controller.abort(new SelectionSupersededError());
    operation = undefined;
    acknowledged = undefined;
    pending = null;
    restartPending = undefined;
    pendingChanged(null);
  };
  const protect = (sessionID: string | null, apply?: () => void): Promise<void> => {
    const token = generation;
    const version = ++revision;
    const controller = new AbortController();
    const valid = () => token === generation && !controller.signal.aborted;
    const check = () => { if (!valid()) throw new SelectionSupersededError(); };
    const next: Operation = { sessionID, generation: token, controller, promise: Promise.resolve() };
    operation = next;
    acknowledged = undefined;
    let abort!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new SelectionSupersededError());
      controller.signal.addEventListener('abort', abort, { once: true });
    });
    next.promise = Promise.race([aborted, Promise.resolve().then(async () => {
      check();
      // Clearing a selection needs no new protection; retain prior IDs until
      // the commit arrives. Non-null navigation always stages before applying.
      if (sessionID !== null) await send(sessionID, version, false, controller.signal);
      check();
      if (apply) applySynchronously(apply);
      check();
      if (current() !== sessionID) throw new SelectionSupersededError();
      pending = null;
      restartPending = undefined;
      pendingChanged(null);
      await send(sessionID, version, true, controller.signal);
      check();
      if (current() !== sessionID) throw new SelectionSupersededError();
      acknowledged = { sessionID, generation: token };
    })]).finally(() => {
      controller.signal.removeEventListener('abort', abort);
      if (operation === next) operation = undefined;
    });
    // Callers can await the rejection, but background observers need not own it.
    void next.promise.catch(() => {});
    return next.promise;
  };
  const observe = (sessionID: string | null): Promise<void> => {
    if (operation?.sessionID === sessionID && operation.generation === generation) return operation.promise;
    if (current() !== sessionID || pending !== null && pending !== sessionID) {
      return Promise.reject(new SelectionSupersededError());
    }
    if (acknowledged?.sessionID === sessionID && acknowledged.generation === generation) return Promise.resolve();
    return protect(sessionID);
  };
  return {
    observe,
    navigationRevision: () => generation,
    isConfirmed: (sessionID: string | null) => current() === sessionID
      && acknowledged?.sessionID === sessionID && acknowledged.generation === generation,
    navigationChanged: () => {
      if (applying) return false;
      supersede();
      return true;
    },
    invalidateAcknowledgement: () => {
      operation?.controller.abort(new SelectionSupersededError());
      operation = undefined;
      acknowledged = undefined;
      if (restartPending) restartPending();
      else void observe(current()).catch(() => {});
    },
    invalidateSession: (sessionID: string, clear: () => void) => {
      const clearsPending = pending === sessionID;
      if (clearsPending || current() === sessionID && pending === null) supersede();
      if (current() === sessionID) applySynchronously(clear);
      // Clearing A must not publish a newer null commit over pending B.
      if (pending === null) void observe(current()).catch(() => {});
    },
    select: (sessionID: string | null, apply: () => void, onError: (error: Error) => void, options?: SelectionOptions) => {
      if (options?.expectedNavigationRevision !== undefined && options.expectedNavigationRevision !== generation) return;
      supersede();
      const token = generation;
      let applied = false;
      let attempt = 0;
      const applySelection = () => { apply(); applied = true; options?.onApplied?.(); };
      if (sessionID === null) applySynchronously(applySelection);
      else { pending = sessionID; pendingChanged(sessionID); }
      const start = () => {
        const ownAttempt = ++attempt;
        void protect(sessionID, sessionID === null ? undefined : applySelection).catch((error: unknown) => {
          if (token !== generation || ownAttempt !== attempt) return;
          pending = null;
          restartPending = undefined;
          pendingChanged(null);
          // Commit failure cannot undo a successfully protected and applied view.
          if (!applied && !(error instanceof SelectionSupersededError)) {
            onError(error instanceof Error ? error : new Error('retention_unavailable'));
            void observe(current()).catch(() => {});
          }
        });
      };
      if (sessionID !== null) restartPending = start;
      start();
    },
    settled: () => operation?.promise.catch(() => {}) ?? Promise.resolve(),
  };
}
