# Ported units of `packages/orchestration-runtime`

Rust ports made with `rust-anything` 5.0.1 (reference: Node), one standalone crate per unit
(`<unit>-rs/`, each with an empty `[workspace]` table). Nothing in the product calls, loads or
ships them. Columns as in `../MAP.md`. The units are JavaScript, so the fuzzer has little or no
generator for their parameters and `--from-tests` captures nothing of arrow-function exports; hand
cases (`--inputs`) carry the proof. Every crate's thrown errors are also checked by
`node scripts/rust-anything/error-texts.mjs` (class and text; `error-sources.json`). Not ported
here: the modules `packages/native/crates/scheduler-policy` already ports by hand, and
`scheduler.js`.

| Unit | State | Recorded | Fuzz | JS | Rust | Notes |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| `harness-policies.js` | done | 44/44 | 0/0 | 29 | 116 | `environment = {}` applies to `undefined` only; `null` throws. |
| `provider-capabilities.js` | done | 213/213 | 0/0 | 29 | 89 | A `null` options object throws V8's "Cannot read properties of null (reading 'cursorReadOnly')" (the destructuring default applies to `undefined` only). |
| `provider-prompt-tools.js` | done | 410/410 | 743/743 | 55 | 121 | Returns `undefined` when no override applies. |
| `designer-step-budget.js` | done | 153/153 | 1/1 | 32 | 169 | 45 hand budgets, one per rule; every rule throws the same `TypeError`. |
| `agent-contracts.js` | done | 116/116 | 0/0 | 69 | 109 | A `null` argument throws V8's destructuring text for the `= {}` default (`(intermediate value)...`), matched exactly. |
| `abort-sources.js` | done | 241/241 | 4947/4947 | 86 | 195 | Through the test wrapper `abort-sources-rs/scenario-js/` (crate `scenario/`): `normalizeAbortSource`, and step sequences on one `createAbortSourceRegistry` registry with a clock the steps set (the factory returns closures, so it cannot cross the bridge itself). The wrapper always passes an options object. |
| `terminal-error-registry.js` | done | 240/240 | 4956/4956 | 89 | 293 | Through the test wrapper `terminal-error-registry-rs/scenario-js/` (crate `scenario/`): step sequences (`record`, `observe`, `read`, `remove`, `clear`, `size`) on one registry, clock set per step. `...step.args` reproduces V8 spread rules (strings spread their characters). |
| `operator-abort-registry.js` | done | 213/213 | 4951/4951 | 80 | 283 | Through the test wrapper `operator-abort-registry-rs/scenario-js/` (crate `scenario/`): step sequences (`record`, `withdraw`, `accept`, `read`, `observe`, `clear`, `size`). `accept` mutates the stored entry in place, seen by later reads. |
| `xai-tool-catalog.js` | done (4 of 5 exports) | 160/160 | 0/0 | 188 | 230 | `createXaiToolCatalogCache` (closures) stays in JS. `stableJson` sorts keys by UTF-16 code units where JS uses `localeCompare`; only equality of two encodings is read, which agrees unless two distinct keys collate as equal. |
| `tool-output-limits.js` | done (4 of 5 exports) | 212/212 | 0/0 | 75 | 268 | `fitManagedToolOutput` (page-factory callback) stays in JS. Errors are `Error`s whose message is the code (their `code`/`statusCode` properties do not cross). `compactManagedTaskToolResult` returns the same value when nothing is suppressed, tracked by a changed flag. |
| `assistant-activity.js` | done (1 of 2 exports) | 29/29 | 0/0 | 140 | 57 | `isManagedAssistantActivityPart`; the registry factory (closures, subscriber callbacks) stays in JS. |
| `compact-result-header.js` | done (1 of 2 exports) | 45/45 | 0/0 | 53 | 82 | `readManagedResultReport`, its fence and marker regexes by hand on UTF-16 lines. `createCompactResultHeader` stays in JS: it rests on `contract`, `required-checks`, `auto-resume-policy` and `provider-retry-policy`, which `scheduler-policy` already ports. |
| `model-availability.js` | done (gate: size over the tool's bound, 275 Rust lines for 64 TS/JS; every behavioural check passes) | 827/827 | 9690/9690 | 43 | 325 | `inspectModelSelection` of `@devryan/shared-runtime/lib/model-selection-availability.js` inlined. Identifiers are cut at 180 UTF-16 units; a lone surrogate in an identifier reads as U+FFFD here (none in the recordings). Over the bound because `inspectModelSelection` is ported alongside and the JS is dense one-line code. |

Not ported, with the reason: `plan-mode-instructions.js` and `index.js` (constants and re-exports
only); `single-flight.js` (promises); `continuation-assignment.js`, `managed-recovery-instruction.js`,
`managed-wait.js`, `managed-result-projection.js`, `managed-result-sections.js` and
`createCompactResultHeader` (they rest on `contract`, `required-checks`, `task-prerequisites`,
`auto-resume-policy`, `provider-retry-policy` and `codec-primitives`, which `scheduler-policy`
ports by hand; `managed-result-sections` is also async); `createXaiToolCatalogCache` and the
assistant-activity registry (closures, subscriber callbacks); `fitManagedToolOutput` (callback);
`open-code-executor.js` (process work).
