# Ported units of `packages/shared-runtime`

Rust ports made with `rust-anything` 5.0.1 against
`packages/shared-runtime` (plan: 4 units, 3 ready), one standalone crate per unit
(`<unit>-rs/`, each with an empty `[workspace]` table). Nothing in the product calls, loads or
ships them. Columns as in `../MAP.md`. The units are JavaScript with `.d.ts` types, so the fuzzer
has no generator for their parameters (`0/0`); the hand cases (`--inputs`) and test calls carry
the proof.

| Unit | State | Recorded | Fuzz | JS | Rust | Notes |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| `startup-diagnostics.js` | done | 274/274 | 0/0 | 61 | 196 | 163 hand cases + 39 test calls. Its four regexes are ASCII classes, matched by hand. `JSON.stringify(_, null, 2)` is serde_json's pretty printer (same layout); an `attempt` of `-0` prints `0`. |
| `testing/` | skipped: no functions | - | - | 52 | - | Test fixtures (constant arrays) only; `bridge` refuses ("exports no functions"). |
| `index.js` | skipped: no functions | - | - | 12 | - | Re-exports of `lib/` only; `bridge` refuses ("exports no functions"). |
| `lib/` | caution (in part) | - | - | 4003 | - | 22 files, 65 exported functions with async work, classes, `adm-zip`, `fs` and URL parsing; ported file by file below (`bridge` takes a file as the unit). |
| `lib/provider-error-details.js` | done | 136/136 | 0/0 | 42 | 122 | 136 hand cases (no test file). `JSON.parse` is serde_json after two rewrites that keep JS's tolerances where serde refuses (surrogate escapes, numbers beyond f64), with no nesting limit (64 MiB worker stack), all pinned by hand cases. |
| `lib/event-types.js` | done | 24/24 | 0/0 | 3 | 15 | `openchamber:` names read as `devryan:`; any other value comes back as given. |
| `lib/native-message-status.js` | done | 87/87 | 0/0 | 15 | 98 | |
| `lib/helper-model-selection.js` | done | 31/31 | 0/0 | 14 | 83 | Lengths and the control-character test are on UTF-16 units. |
| `lib/upstream-stall.js` | done | 73/73 | 0/0 | 21 | 80 | `JSON.parse` as in `provider-error-details-rs` (an envelope with `1e400` or a lone-surrogate escape elsewhere still passes, as in JS). |
| `lib/model-selection-availability.js` | done (gate: size over the tool's bound, 133 Rust lines for 26 TS/JS; every behavioural check passes) | 256/256 | 876/876 | 28 | 165 | A `null` options argument throws (the `= {}` default applies to `undefined` only). Over the bound because one dense 26-line JS function needs the shared JS-value helpers (property reads, `===`, `String()`) as well. |
| `lib/cache-efficiency-policy.js` | not ported: URL parser | - | - | 41 | - | Rests on WHATWG `new URL()` (host normalization, IDNA); a faithful port needs the `url` crate, a new dependency. |

The other files of `lib/` are not attempted yet. Several hold async network or process work
(`commit-message-draft`, `free-zen-generation`, `quota-adapters`, `config-apply-coordinator`) or
the file system (`safe-archive`, `data-root`); the smaller pure ones (`assistant-image-sources`,
`free-zen-model-catalog`, `usage-observation`, ...) are the next candidates.
