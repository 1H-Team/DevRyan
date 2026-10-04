import { Context, Effect } from 'effect';

export type RegistrationCapability = 'read' | 'write' | 'process' | 'network' | 'managed-task' | 'control' | 'provider';
export interface RegistrationOrigin {
  readonly kind: 'native' | 'plugin';
  readonly id: string;
  readonly manifestDigest: string;
  readonly capabilities: readonly RegistrationCapability[];
}
export const RegistrationOriginRef = Context.Reference<RegistrationOrigin | undefined>(
  'DevRyan/RegistrationOrigin', { defaultValue: () => undefined },
);
export function provideRegistrationOrigin<A, E, R>(origin: RegistrationOrigin, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
  const sealed = Object.freeze({ ...origin, capabilities: Object.freeze([...origin.capabilities]) });
  return Effect.provideService(effect, RegistrationOriginRef, sealed);
}
