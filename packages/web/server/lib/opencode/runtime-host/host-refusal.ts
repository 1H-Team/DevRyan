import { AsyncLocalStorage } from 'node:async_hooks';
import { Effect } from 'effect';

/** A host defect deliberately preserves native SDK `never` error channels. */
export class HostRefusal extends Error {
  readonly name = 'HostRefusal';
  constructor(readonly code: string, readonly status: 403 | 409 | 503,
    readonly operation: string, readonly sessionID?: string) {
    super(`DevRyan refused ${operation}: ${code}`);
  }
}
const requests = new AsyncLocalStorage<{ refusal?: HostRefusal }>();
export const refuseHost = (refusal: HostRefusal): Effect.Effect<never> => Effect.suspend(() => {
  const request = requests.getStore();
  if (request) request.refusal = refusal;
  return Effect.die(refusal);
});

/** Native HTTP can catch defects; retain only this request's known refusal. */
export async function runWithHostRefusal<A>(action: () => Promise<A>): Promise<
  { readonly ok: true; readonly value: A } | { readonly ok: false; readonly refusal: HostRefusal }
> {
  const state: { refusal?: HostRefusal } = {};
  return requests.run(state, async () => {
    try {
      const value = await action();
      return state.refusal ? { ok: false, refusal: state.refusal } : { ok: true, value };
    } catch (error) {
      if (state.refusal) return { ok: false, refusal: state.refusal };
      if (error instanceof HostRefusal) return { ok: false, refusal: error };
      throw error;
    }
  });
}
