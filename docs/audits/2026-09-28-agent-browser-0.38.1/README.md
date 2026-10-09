# agent-browser 0.38.1 upgrade acceptance — 2026-09-28

The managed runtime is pinned to **0.38.1**, replacing 0.33.2. Local macOS arm64
source Electron and native confinement acceptance pass. This is not universal
platform or release-package qualification; the remaining gates are below.

## Implementation

- Installer status and Electron fallback states share one version constant.
  Native execution and `bun install --ignore-scripts` remain in use. All seven
  existing platform filenames exist in the published package. Only the host
  macOS arm64 binary was executed. The actual managed fresh install, no-op,
  Repair and upgrade from an installed 0.33.2 package passed with Bun 1.3.14.
- The package declares Node >=24 for its JavaScript CLI. DevRyan invokes the
  native executable, whose actual `--version` succeeds with an empty PATH.
  No DevRyan engine-floor change was needed for this integration. This does not
  claim the upstream Node wrapper works on older Node versions.
- FFmpeg comes from pinned b6.1.1 assets, with SHA-256-verified binary, license
  and source/build notices. The arm64 macOS asset identifies itself as FFmpeg
  **6.0** despite the release tag; both actual libvpx and libx264 encoding probes
  pass. Downloads, probes, staging, activation/rollback, separate readiness and
  Repair are owned by the existing managed installer. No npm wrapper was added.
- Sequences validate 1–32 steps before acquiring one lease. They share the
  daemon, turn scope, a <=120-second execution deadline and bounded aggregate
  output. There is no action replay or nested scripting language. Failed steps
  retain indexed results; a recording gets up to 10 seconds of independent
  cleanup, with finalized/incomplete artifact reporting. Confined standalone
  starts are rejected. Existing single-command calls retain their interface.
- The bridge exposes only its pinned target through `Target.getTargetInfo`.
  Recording gets one separate native debugger attachment on that guest, with
  validated command/event routing and bounded, fenced attachment operations.
  Detach leaves primary interaction usable. Browser-wide and WebMCP commands
  remain blocked. Capture suppresses DevRyan's pointer overlay so the recorder
  produces one cursor.

## Compatibility bugs found with the actual binary

1. Sending `--no-webmcp` after `connect` causes 0.38.1 to switch from external
   CDP to local browser launch. It is therefore forbidden as a caller override;
   WebMCP is disabled at the bridge. No local-launch flags are added to the
   managed command prefix.
2. Confined Rust does not fall back when the kernel denies `posix_spawn`.
   Browser children now retain only the manifest/hash-verified native supervisor
   fork/exec adapter on macOS. Actual confined FFmpeg launch and recording pass;
   the kernel policy and process-group restrictions are unchanged.
3. A never-presented macOS parking host could acknowledge mouse commands while
   dropping their DOM events, on both 0.33.2 and 0.38.1. Agent parking now uses an
   invisible, noninteractive, nonfocusable native host; manual hosts remain
   hidden/throttled. Before the first pointer event after navigation or native
   view movement, the surface waits for one compositor capture to establish
   hit-test data. It does not capture every event in a human pointer path.

## Evidence and acceptance

The [fixture README](../../../packages/electron/tests/browser-inspection/README.md)
contains exact entrypoints. Every fixture uses repository-local disposable
state, an ephemeral partition and a deterministic loopback page. It does not
access the installed DevRyan app, provider credentials or live project data.

The source fixture runs Electron 41.2.1 / Chromium 146.0.7680.188 and executes
the actual native CLI through the production plugin and CDP bridge. It checks:

- Core navigation, snapshots, click/fill, inspect/eval, screenshot and close,
  including a surface that has never been shown to the user.
- Persistent refs after same-node changes; rejected old refs after replacement
  and navigation; full/delta/unchanged baselines and explicit refresh.
- Conditional screenshot threshold/skip, with no invented artifact path.
- Human click/drag actions, WebM/MP4 FPS controls, navigation during recording,
  cursor/contact-sheet output and simultaneous observation while parked.
- Real native confined sequences and cooperative cancellation, a denied write
  outside the private view, finalized recordings and supervisor receipts.
- Complete decoding of all four videos, contact-sheet creation, no surviving
  lease/debugger capability and retained process-ancestry cleanup with no rescue
  termination signals.

The 0.33.2 core baseline is run against the same final bridge and surface host;
this compares CLI behavior, not an unchanged historical DevRyan build. Unit
contracts cover foreign target/session rejection, reconnects, concurrent leases,
command budgets, late capture attachment cleanup, environment scrubbing,
sequence limits, failed recording finalization, download/checksum/codec failures,
nonfatal recording status and preservation of user-modified skills.

`bun run validate:full`, `bun run build`, `bun run bundle:check` and
`bun run docs:validate` pass. The final full run includes 3,968 UI tests and
4,634 web tests, alongside the remaining workspace suites. Documentation
validation retains existing/generated-target warnings. Final suite results
and sanitized fixture evidence are recorded in [evidence.json](evidence.json). Screenshots/contact sheets are reviewed visually;
videos are fully decoded, with the visual review based on their contact sheets.
The final [0.38.1 screenshot](common.png) and the 0.33.2 baseline screenshot
had identical SHA-256 hashes (the byte-identical baseline copy was removed 2026-10). Reviewed recording contact sheets cover
[WebM](recording-webm.contact-sheet.png), [MP4](recording-mp4.contact-sheet.png),
[confined execution](confined-false.contact-sheet.png) and
[confined cancellation](confined-true.contact-sheet.png). The raw `.webm`/`.mp4`
recordings were removed 2026-10; regenerate via
`node packages/electron/tests/browser-inspection/upgrade-run.mjs <install-root>`.

## Remaining release gates

- `package-prepared --dir --mac --arm64` stops at
  `bot_runtime_release_source_invalid`: the required signed
  `packages/electron/resources/bot-runtime/images.release.json` is absent.
  No development manifest was substituted. A signed packaged-app acceptance run
  is therefore unavailable, including on the current arm64 host.
- macOS x64, Linux glibc/musl x64/arm64 and Windows x64 binaries were checked for
  package layout but not executed on this host. Windows arm64 remains unsupported
  by DevRyan's existing native mapping. Codec readiness on other platforms is
  established at installation time, not inferred from this arm64 run.
- The existing loopback duplicate serializer workflow passes on OpenCode
  1.18.33, but is explicitly synthetic-fixture-only. Its plugin inventory does
  not qualify the changed browser plugin. Required matched live behavior trials
  and release-profile requalification are unavailable without a prepared live
  qualification host/credential setup. Original hashes and acceptance reports are unchanged. All six affected
  profiles are explicitly stale, so the default optimization policy is off
  until live requalification supplies new evidence.
- The isolated native fixture uses a scoped test lease endpoint. It does not
  claim live OpenCode/provider or production publication acceptance. Abrupt
  forced termination can leave an incomplete video; only cooperative cancellation
  has a bounded recording-finalization opportunity.

## Rollback

Revert these upgrade changes (preserving unrelated work), restoring the exact
0.33.2 pin, then use Repair. Keep browser profiles and user files. The separate
managed FFmpeg cache need not be deleted to restore core browsing.

## References

- [Upstream 0.38.1 changelog](https://github.com/vercel-labs/agent-browser/blob/v0.38.1/CHANGELOG.md)
- [Upstream local-launch decision](https://github.com/vercel-labs/agent-browser/blob/v0.38.1/cli/src/main.rs)
- [Electron debugger session routing](https://www.electronjs.org/docs/latest/api/debugger)
- [Pinned FFmpeg distribution and source notices](https://github.com/eugeneware/ffmpeg-static/releases/tag/b6.1.1)
- [Existing duplicate-output qualification workflow](../../HARNESS_OPTIMIZATION.md#duplicate-output-acceptance)

## Earlier CDP bridge compatibility spike (0.33.2, 2026-08-02)

Folded in from the former standalone CDP spike document. These results used 0.33.2 and do not qualify 0.38.1. They gated `packages/electron/browser-cdp-bridge.mjs`; its contract now lives in `packages/electron/codemap.md`.

Verdict: GO. `agent-browser connect <ws-url>` works against a bare page WebSocket with no HTTP CDP discovery (headless Chrome 150 on loopback, direct page URL as emitted for a lease). Navigation, `snapshot -i` and screenshot capture succeeded. A `ws` server created with `port: 0` has no address until `listening`, so the bridge must await that event before publishing a capability URL, and tests must model the asynchronous lifecycle.

Connect-time handshake: root `Runtime.evaluate` probe, `Target.setDiscoverTargets`, `Target.getTargets`, `Target.attachToTarget {flatten:true}` (returns `sessionId`), then session-scoped `Runtime.evaluate`, `Page.enable` / `Runtime.enable` / `Network.enable`, `Target.setAutoAttach`, `Runtime.runIfWaitingForDebugger`, and a repeated root `Browser.getVersion` before operation batches. After attach everything uses flat-session messaging (`DOM.*`, `Accessibility.*`, `Runtime.*`, `Input.*`, `Page.navigate`, `Page.captureScreenshot`).

Bridge requirements the spike established:

1. One shared loopback listener, usable only after `listening`, stopped after the last lease closes.
2. Per-lease capability path, pinned guest, controlling client, synthetic target and session IDs and in-flight budget.
3. Synthetic root layer for `Browser.getVersion` and the `Target.*` discovery/attach/detach methods around exactly one guest per lease.
4. Strip the synthetic `sessionId` before `webContents.debugger.sendCommand` and restore it on replies and events.
5. Browser-level domain fence: in-session `Target.setAutoAttach` is synthesized as `{}` and every other session-scoped `Target.*` or `Browser.*` method is rejected, because forwarding them could enumerate or mutate sibling Electron targets.
6. Tag intercepted `Input.*` activity with the owning lease so only the observing window sees it.
7. A reconnect test must repeat the attach handshake and a real session-scoped command; a clean client disconnect releases only the client and the same capability accepts the next one, with late results of the previous client fenced.

Packaged Electron acceptance (arm64, 2026-08-02) used a small four-page local site (`<HOME>/Repositories/test/site`). One Builder root held a single lease across repeated navigation/snapshot operations while the root-scoped menu showed one row. A second root ran concurrently and closed its own lease without affecting the first. A builder edited the live site and verified the change through the same browser tool. The acceptance exposed that `Page.captureScreenshot` stalled while an inactive lease `<webview>` used `visibility:hidden`; lease panes now stay full-sized and paintable with `opacity:0`, z-order isolation and `pointer-events:none`, and a hidden-capture run while a manual tab was selected recorded no capture timeout. Agent Browser Control reported expected and installed `0.33.2`, status `Ready`, and the global active count went from 1 to 0 after the explicit close. Static bridge coverage handles distinct guests, capability isolation, debugger conflicts, close, idle and shutdown cleanup and the two-minute orphan fence; real-hardware reclamation of an abandoned guest over the full orphan interval remained optional.

