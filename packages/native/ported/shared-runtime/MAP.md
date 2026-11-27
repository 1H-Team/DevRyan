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
| `lib/cache-efficiency-policy.js` | not ported: URL parser | - | - | 41 | - | Rests on WHATWG `new URL()` (host normalization, IDNA); a faithful port needs the `url` crate, a new dependency. |

The other files of `lib/` are not attempted yet. Several hold async network or process work
(`commit-message-draft`, `free-zen-generation`, `quota-adapters`, `config-apply-coordinator`) or
the file system (`safe-archive`, `data-root`); the smaller pure ones (`assistant-image-sources`,
`free-zen-model-catalog`, `model-selection-availability`, `helper-model-selection`, ...) are the
next candidates.
