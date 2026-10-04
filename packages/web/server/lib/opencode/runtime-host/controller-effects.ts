import { Effect, Logger } from 'effect';

/** Private commands start a new Effect runtime: keep native logs off the JSON-lines protocol. */
export function runControllerEffect<A, E>(effect: Effect.Effect<A, E>) {
  return Effect.runPromise(effect.pipe(Effect.provide(Logger.layer([Logger.withConsoleError(Logger.formatLogFmt)], { mergeWithExisting: false }))));
}
