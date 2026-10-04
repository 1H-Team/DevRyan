import type { Plugin } from '@opencode/plugin/effect/plugin';
import { Effect } from 'effect';
import type { NativePonytailOwner } from './native-ponytail.js';

export function nativePonytailPlugin(owner: Pick<NativePonytailOwner, 'contextInstructions'>): Plugin {
  return { id: 'devryan.ponytail', effect: context => Effect.gen(function* () {
    const directory = context.location.directory;
    yield* context.session.hook('context', event => Effect.gen(function* () {
      const instructions = yield* Effect.promise(() => owner.contextInstructions(directory));
      if (!instructions) return;
      const last = event.system.at(-1);
      if (last) event.system[event.system.length - 1] = { ...last, text: `${last.text}\n\n${instructions}` };
      else event.system.push({ type: 'text', text: instructions });
    }));
  }) };
}
