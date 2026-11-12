// Harness-owned toy flow module (self-test corpus of the client conformance
// harness): inputs whose consequences interleave. An answer to a port call, a
// timer an entry awaits and a callback a port invokes each own what the
// module does after them; a call into another family goes through its port.
import { guard } from './toy-guard.mjs';

export function createFlow(sdk, { onEvent }) {
  return {
    async slow(key) {
      const value = await sdk.lookup(key);
      onEvent(`slow:${value}`);
      return value;
    },
    async microtask(key) {
      await null;
      onEvent(`micro:${key}`);
      return key;
    },
    quick(key) {
      onEvent(`quick:${key}`);
      return key;
    },
    async sleep(ms, key) {
      await new Promise((resolve) => { setTimeout(resolve, ms); });
      onEvent(`slept:${key}`);
    },
    subscribe() {
      const heard = [];
      sdk.on((value) => { heard.push(value); onEvent(`heard:${value}`); });
      return heard.length;
    },
    check(status) {
      const verdict = guard(status);
      onEvent(`verdict:${verdict}`);
      return verdict;
    },
    abort(name) {
      throw new DOMException(`stopped by ${name}`, name);
    },
    same(value) { return value; },
    copy(value) { return { ...value }; },
  };
}
