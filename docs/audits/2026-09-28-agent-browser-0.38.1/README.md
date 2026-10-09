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
