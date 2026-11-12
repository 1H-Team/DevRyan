// Known engine discrepancies of the extended JSON run: cases where a
// JavaScript engine returned something other than what ECMA-262's
// JSON.parse/JSON.stringify and the other engine return. Each entry is still
// checked on every run (applyKnownDiscrepancies in generate-json.mjs):
// - under the engine it names, that engine must return exactly `observed`;
//   the row is then written with `specification` (what the Rust must
//   produce) and named `known-engine-discrepancy:<id>`, and the extended run
//   and tests/json.rs report it as a known engine discrepancy;
// - if that engine now returns `specification`, or anything other than
//   `observed`, generation fails and says to update this list;
// - under other engines the row is written from the engine's own answer, as
//   every row is, so any further disagreement fails as before.
// Any discrepancy not listed here fails the run.

export const KNOWN_ENGINE_DISCREPANCIES = Object.freeze([
  {
    id: 'electron-v8-duplicate-escaped-key',
    // generate-json.mjs, renderJson(count >= 440,718): the row named below.
    seed: 20261112,
    row: 'random-440717',
    engine: 'electron',
    seen: 'Electron Node v24.22.0, V8 15.2.124.43-electron.0, ICU 78.2 (2026-11-12); reproduction: reports/L1a-v8-duplicate-key-repro.mjs in the plan folder',
    // The input's two keys are both "\u0015" (an escaped duplicate key):
    //   {"\u0015":<tab>[],"\u0015":{...}<tab>}
    input: 'eyJcdTAwMTUiOglbXSwiXHUwMDE1Ijp7Ilx1ZGE0NFx1REQyRFx1ZmVmZu24gCIKOiI6XHVkYWY5XHVERjM4XHTwn5iAPENcdTAwMkZcL1x1MDAwOVxcXHRcdTAwMUXtv78ifQl9',
    // Electron, inside the long generator run (also under --jitless, though
    // one --jitless run was correct): the second key comes back as
    // "\\" (a backslash) and the duplicate is not merged:
    //   {"\u0015":[],"\\":{...}}
    observed: 'eyJcdTAwMTUiOltdLCJcXCI6eyLyoYSt77u/XHVkZTAwIjoiOvOOnLhcdPCfmIA8Qy8vXHRcXFx0XHUwMDFlXHVkZmZmIn19',
    // ECMA-262 (a duplicate key keeps its first position and takes the last
    // value), Node v26.13.0 (V8 14.6), the same text parsed in a fresh
    // Electron process, and the Rust:
    //   {"\u0015":{...}}
    specification: 'eyJcdTAwMTUiOnsi8qGEre+7v1x1ZGUwMCI6Ijrzjpy4XHTwn5iAPEMvL1x0XFxcdFx1MDAxZVx1ZGZmZiJ9fQ==',
    // Why the ledger cannot produce such input, and where that reasoning stops:
    // every ledger record (Git blobs of the change store, list pages,
    // snapshot pages in session-changes-snapshot.js) is JSON.stringify of a
    // JavaScript object, and an object cannot hold two equal keys, so no
    // record the ledger wrote has a duplicate key. The ledger also parses
    // JSON it did not write with JSON.stringify:
    // - termination.json receipts (session-execution.js, read at
    //   `readSessionExecutionReceipt`) and the Windows process identity
    //   (session-execution.js `parseWindowsExecutionProcessIdentity`): both
    //   are printed by the confined launchers (native/session-execution.c,
    //   native/session-execution-windows.c) from fixed formats with distinct
    //   keys, so they cannot hold a duplicate either;
    // - the launcher manifest `<launcher>.json` (session-execution.js): a
    //   build artifact, checked by identity before use;
    // - `no-execution-socket.json` (session-execution.js): no product code
    //   writes it, so it is written by a person or a tool and CAN hold a
    //   duplicate key; it is at most 4 KiB, must have version 1 and is
    //   accepted only with the keys `version` and `disabled`;
    // - lock files and other atomic-file.js records read by readJson: written
    //   by JSON.stringify, possibly by another app version.
    // So the reasoning holds for every record except a hand-written
    // `no-execution-socket.json`, whose parsed keys are validated.
  },
]);
