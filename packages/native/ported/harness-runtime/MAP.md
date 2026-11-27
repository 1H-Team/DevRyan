# Ported units of `packages/harness-runtime/lib`

Rust ports made with `rust-anything` 5.0.1 (reference: Node), one standalone crate per unit
(`<unit>-rs/`, each with an empty `[workspace]` table). Nothing in the product calls, loads or
ships them. Columns as in `../MAP.md`. JavaScript units: hand cases (`--inputs`) carry the proof
(the fuzzer has little generator for untyped parameters, and `--from-tests` does not capture
arrow-function exports). Thrown errors are checked by `node scripts/rust-anything/error-texts.mjs`
(`error-sources.json`). Not ported: what the native ledger already ports, and what touches the
file system, Git, processes, locks or the real clock.

| Unit | State | Recorded | Fuzz | JS | Rust | Notes |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| `objective-progress.js` | done (gate: size over the tool's bound, 221 Rust lines for 46 TS/JS; every behavioural check passes) | 322/322 | 0/0 | 54 | 270 | `RegExp.test` reads `String(v)`, so a one-element array holding a hash passes, as in JS. Over the bound because seven dense one-line JS validators expand into explicit Rust checks over a JS-value prelude. |
| `session-tool-effects.js` | done | 35/35 | 0/0 | 29 | 147 | `descriptors[tool]` also reads inherited `Object.prototype` members (`toString`, `__proto__`, ...), whose `kind`/`id` are `undefined`, as in JS. The capabilities test (`JSON.stringify` equality) is an order-sensitive JSON-equivalence walk. |
| `session-id.js` | done | 80/80 | 0/0 | 52 | 160 | `canonicalDevRyanEventType` of `@devryan/shared-runtime/lib/event-types.js` inlined (`openchamber:` names read as `devryan:`). |
| `objective-identity.js` | done | 304/304 | 578/578 | 30 | 192 | `isNativeStatusRecord` of `@devryan/shared-runtime/lib/native-message-status.js` inlined. A synthetic text part whose `text` is not a string throws V8's `part.text?.startsWith is not a function`, as in JS. |
| `prompt-admission.js` | done | 213/213 | 4990/4990 | 62 | 144 | Through the test wrapper `prompt-admission-rs/scenario-js/` (crate `scenario/`): steps on one controller; `acquireHold` returns a release closure, so the wrapper hands back its index and `release` calls it. |
| `host-stall-clock.js` | done (the factory) | 213/213 | 4980/4980 | 77 | 243 | Through the test wrapper `host-stall-clock-rs/scenario-js/` (crate `scenario/`): `createHostStallClock` with the time the steps set and an interval stub that schedules nothing; returns every result and the stalls `onStall` saw. JS `+` is kept: a string start concatenates (`"5" + "1"` is `"51"`). The kill switch is read from the process environment. The shared clock (`hostStallClock`, real `setInterval`) stays in JS. |

Not ported, with the reason: the units the coordinator excluded (native-ledger ports, file system,
Git, processes, locks, the real clock); `paths.js` (`path.resolve` reads the working directory);
`journal-trim.js` (only a trimmer factory with timers); `usage.js` and `trace.js` (large collectors,
`trace` hashes with `node:crypto`); `builder-todo-continuation.js` and `session-reboot-recovery.js`
(SHA-256 of `node:crypto`; no hashing crate without a new dependency);
`provider-recovery-policy.js` and `managed-collection-continuation.js` (not reached this session).
