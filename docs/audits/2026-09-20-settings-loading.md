# Settings opening and loading verification — 2026-09-20

## Result

Settings navigation, home and Back now render synchronously in the shared web/Electron UI. Cold destinations display a compact content-area placeholder. Feature sections and store activation remain lazy, with separate full/managed data boundaries. Appearance/Chat, Shortcuts, Sessions, Notifications, Voice and Tunnel no longer share one eagerly imported preference implementation.

The user's existing fixed-width Settings navigation changes were retained. No dependencies, backend contracts, persisted settings formats or legacy Tauri features changed.

## Measurements

The comparison used the current working tree before this task as its baseline, built into `.cache/settings-loading/baseline`. `scripts/qa/settings-loading.mjs` ran the real production web output with a synthetic loopback OpenCode fixture and private home/data/browser profiles. It disabled idle preparation, disabled the browser cache, and applied 200 ms network latency and 1 MB/s throughput after application readiness. Entry used the Settings keyboard action with Shortcuts as the remembered destination. Mobile used a 390×844 touch viewport; desktop used 1280×800.

Times measure the first animation frame after the relevant DOM appears. These are individual controlled samples, not population percentiles or a general guarantee for every section/provider.

| Surface | Cold frame before → after | Cold Shortcuts content before → after | Warm frame after |
| --- | --- | --- | --- |
| Web desktop | 763.1 → 12.9 ms | 2043.4 → 405.5 ms | 12.1 ms |
| Web touch-mobile | 545.0 → 10.5 ms | 1244.9 → 470.4 ms | 12.3 ms |
| Packaged Electron, macOS arm64 | not measured → 16.4 ms | not measured → 412.2 ms | 12.4 ms |

All measured updated frames met the 100 ms target. The before build displayed a full-screen loading fallback; the updated web/mobile/Electron builds did not. The updated web Shortcuts entry requested its own 2,754-byte module. The old entry loaded the Settings shell and the combined preference implementation plus dependencies such as About, Git, and model selectors. Request-window totals also include unrelated startup syntax/WASM/worker activity, so they must not be attributed wholly to Settings.

The eager frame increased the measured gzip startup graph from 1,391,110 to 1,405,212 bytes (+14,102 bytes, approximately 1.0%). The existing 1,456,388-byte budget passes without relaxation. Administrator/managed data modules remain prohibited from the startup graph.

## Evidence and visual review

Local raw evidence is retained under:

- `.cache/settings-loading/web-als4If/`: before/after timings, desktop and touch-mobile cold/ready/warm screenshots, process logs, and browser errors.
- `.cache/settings-loading/electron-buq2nh/`: actual packaged Electron timing, screenshots, and isolated-host evidence.
- `.cache/qa/packaged-electron-WvLDU7/package-evidence.json`: packaged main/server/preload/UI identities and passing SQLite/PTY checks.
- `.cache/settings-loading/`: build, validation, bundle, lint/type-check and focused-test logs.

Every PNG in these two completed visual runs was inspected. The baseline cold screenshots replace all navigation with the centered loading screen. The updated web cold screenshots preserve desktop navigation or the mobile header/Back and confine Loading to the content area. Ready/warm screenshots preserve the existing controls and layout. The native captures preserve macOS titlebar clearance. No browser exceptions were recorded. The final Agents alias-effect correction was separately tested and rebuilt; it does not affect the measured Shortcuts path.

The packaged fixture uses production main/preload/server code with the existing QA bootstrap, private data/profile/home, a mock keychain, disabled Bot service and suppressed global protocol registration. Signing, updater installation, physical-device interaction and live managed-account authentication were not tested. Managed policy behavior was tested with deterministic mounted components.

## Validation

- `bun run validate:full`: workspace lint, type checks and documentation validation passed; the first test run stopped at an unrelated gateway-relay `ECONNRESET`. Its isolated rerun passed (9 tests), followed by a passing complete `bun run test:full` rerun. The web suite passed 387 files / 4,168 tests.
- Subsequent affected UI type checks, lint and deterministic tests passed after the final data-effect correction. New coverage exercises cold/warm full and managed frames, mobile Back, close-during-load, rapid navigation, direct/store navigation, revocation, forbidden destinations, idle cancellation, independent preference readiness, and lazy data-effect behavior. Existing import timeout/retry coverage remains in place.
- `bun run build` and `bun run bundle:check` passed on the final source. Startup budgets and heavyweight import exclusions were preserved and extended to the new data boundaries.
- Documentation validation passed; unrelated existing documentation warnings remain.
- Both completed QA runners exited successfully and stopped only their owned fixture processes.

## Reproduction

Run from the repository root after building. To compare an earlier build, save it before making source changes:

```sh
bun run --cwd packages/web build --outDir ../../.cache/settings-loading/baseline
# Apply the change, then build the candidate.
bun run build
node scripts/qa/settings-loading.mjs --baseline .cache/settings-loading/baseline
```

For current-build web verification alone, omit `--baseline`. For packaged Electron, create an isolated candidate with `scripts/qa/package-electron.mjs` as documented in `docs/QA.md`, then pass its repository-local executable to `node scripts/qa/settings-loading.mjs --electron <binary>`. No passwords or live provider credentials are required.
