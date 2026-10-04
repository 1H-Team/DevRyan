# Native v 2 UI wire and runtime qualification

Status: the final source 8/native-B nine-cell local functional and visual qualification passed. The
[current final evidence table](../../OPENCODE_V2_AGENT_UPGRADE_PLAN.md#current-final-candidate-evidence)
records these scoped passes and remaining overall gates. The results below are historical:
eight scenario scopes passed, while their nine-scenario baseline remained open
pending the 800-pixel dark Electron startup check and final screenshot review.
Their artifacts are native 9 / application 31 / package 32. Source 32 SHA
`f78650c095a447eef7a6a9e6674afb746a98b5de2b68b87ad9aae50e2e44d0f0`
adds only the reviewed QA agent-menu closure action to source 31. The first three
successful wire cells retain source 31 provenance; later cells use source 32.
Application and native bytes are unchanged. Failed original attempts remain failed.
No saved-provider, natural-compaction, installed-app or release-signing acceptance
is claimed.

Current source 8 freeze `r20-source-final-8.json` has SHA
`380b23d533d88e97c41834adf9b84f8b47b2129541948dac2d03553982cd35f6` and source identity
`275f5e957a152c11cf4d3d7e61f1d84a0d38d0c56c0eb3ac7bac1977c567eb0d`. Its only changes from
source 7 are five raw Supertest imports switched to the existing explicit-loopback
fixture helper. The five complete files passed 47 focused tests in both standard
and passive socket-verification runs; this is a scoped fixture check, not full
validation. Native A/B inputs, Electron main270 and production runtime bytes are
unchanged. The source 7 recovery presentation and trusted preload IPC remain
unchanged in source 8.

Source 8 build 8 and startup bundle checks passed in
`r20-final-build-source8-evidence.json`, SHA `70dd2532f93a8ce372b87346c783e4116efefce203f07d2fcb2d00272779623a`.
Fresh package 8 preparation passed in
`r20-stage-f-ui-prepared-source8-evidence.json`, SHA
`830054c47f1fdff7c7de6261a1f04f20c53922e86e4e6a9922bcc2e5f5b812d1`, binding app PS8vcA and matrix
sTYUw6. Source 8 full 9 passed with actual natural exit 0 and final guards in
`r20-validate-full-source8-passed-evidence.json`, SHA
`673cdd49b1c4c6413ba2aabb4f07d6a13b2941f756ba106f9547283a007b63ca`. Source 7 full 8 remains failed in
`r20-validate-full-8-failed-evidence.json`, SHA
`882b895bdaf5a54b8f8de0b1a0512584339a3192a4abcc287e2f9c8e440c9d71`:
510 passed/2 failed web files (6163 passed/2 failed tests), with HTTP 401 instead
of the expected 503 and an HTTP parse error; UI unit tests passed 4038.
Source 6 full 7 remains a historical pass.

The recovery contrast correction passed three existing owner tests and four
isolated static Electron light/dark desktop/mobile render cells. Minimum measured
text/control contrast is 6.70, the mobile command wraps and no clipping was found.
`r20-recovery-contrast-correction/held.json`, SHA
`c75c5f3e9057b7b73abd1eb2bf6e148b0faba1abffd92537b073cc22464591e8`,
retains the exact change and rendered evidence. Peer byte/pixel review SHA
`4b6a7acac1b89b3764e1ef39d12b501363f75db1d7f5dab67cacf295b5b54afd`
and root pixel review SHA
`13b699217677cb6a69a1d1a2740e80aa7c9bc9ffe4b6d1317a1ed41606d27b96`
cover all four actual PNGs. IPC script bytes remain unchanged. Static rendering
does not establish native Cancel, Resume or restart.

Source 8 whole application lifecycle and actual native Cancel passed in
`r20-application-source8-passed-evidence.json`, SHA
`49eaebba84cf37cff9f2de4aaf32ba28801b5416a1ae0328fb773a8d23c7be16`.
The original command exited 0; all seven modes completed, the trusted Cancel reply
was `cancelled`, and both retained desktop PNGs passed original-resolution review.
The journal audit joined 312 sealed records/10 chunks and four raw user-abort
errors to three unique original Stop events. The intentional parent-death mode
left seven complete runtime rows in one open chunk: the strict all-sealed inspector
refused that root, while independent sealed counts and actual `gaps --verify`
checks passed with zero gaps. No raw file was changed. All 17 recorded owned PIDs
were absent and both registries empty.

The independent positive Electron Resume supplement failed in
`r20-positive-electron-source8-first-failed-evidence.json`, SHA
`1e3b5e8f860b0132ba816bbaf9716d0a7d3429eaf494cf4385ca4fb4f1884304`.
Actual native Resume committed B revision 3 with trusted `restart_required`, and
post-Resume native capability/connection rows were retained. The helper missed
the detached relaunch and did not qualify its host/window/history assertions.
Separate root cleanup closed that owned relaunch; this does not promote the
failed result. Its two sealed journals contain 240 records/7 chunks, three raw
user-abort errors/two unique Stop events, and zero verified gaps. All 33 recorded
owned PIDs were absent. The three original source 6 application failures remain
failed.

Earlier positive attempts remain failed. Retry 1
(`r20-positive-electron-source8-retry1-failed-evidence.json`, SHA
`b896c985c9f26ff1ce26ecb1e47e660f641824802e067bedbf79ccc17c5f1536`)
verified relaunch/API readiness but failed its first-desktop settings comparison;
its ready PNG showed a bundled-runtime warning. Its audit retains 235 sealed
records/7 chunks, three raw Stop errors/two unique events, zero gaps and all
124 recorded identities absent. Later failed indexes retain these scopes:

- Retry 2a: relaunch-readiness observation failed; `r20-positive-electron-source8-retry2a-failed-evidence.json`, SHA `3cf481a1babb0f01b47f0482f729e6366d2c45bd1effa2e2378cacf113e49e08`.
- Retry 3: the observer rejected the intentional shared web runtime descriptor despite healthy routes/composer; `r20-positive-electron-source8-retry3-failed-evidence.json`, SHA `b974f44e3cd92be16a872f3d0acbb75e26d43a95a5faafcaef8c6ff1dbb2d6ba`.
- Retry 4: owner/key and prior preservation checks passed; a later wrong reserved-port comparison failed under stale `preserve-owner-identity` phase; `r20-positive-electron-source8-retry4-failed-evidence.json`, SHA `d744a02eaa12146482b85b394205870b6426aeb41d67a25c8a0f36e1616b0b97`.
- Retry 5: exact CDP `Inspected target navigated or closed` before strict visible readiness; navigation versus closure remains unproven; `r20-positive-electron-source8-retry5-failed-evidence.json`, SHA `3dcdfc2a39ddff3879b0c5794e8f4182922dd74859c417fd0f1618f4c9aaa34b`.

All four later audits retain zero verified gaps and original Stop errors. No
failed result is promoted.

The fresh independent positive Electron Resume retry 6 passed with actual
natural exit 0 in `r20-positive-electron-source8-retry6-passed-evidence.json`, SHA
`c7a95ef1c39dfa01a9e2d97ad1567d514b40d6299c9e41221df2f6707159c9a5`.
It verifies the real native Resume/relaunch, strict visible frontend and both
healthy generation-2 routes, preserved A/B histories and provider credentials,
owner identities/paired keys, exact prospective first-desktop B settings and the
persisted port matching the actual owned origin. Whole B settings equality is not
claimed for initialization; fresh ephemeral local-owner login sessions likewise
exclude whole host-vault byte equality. Two actual PNGs passed root semantic/pixel
review `r20-positive-electron-source8-retry6-root-review.json`, SHA
`6154aaeac9646c837724d57b073b52624ad34de6ca9b6b2be12d456efcc074b2`.
The independent audit verifies 240 sealed records/7 chunks, three raw user-abort
errors/two unique original Stop events, zero gaps and all 194 recorded PIDs absent,
with closed controller receipts and empty registries. The source/package guards
match. Its underlying original capture intentionally stops at the cold-recovery
hook; this supplement does not replace the separate whole-application pass.
No readiness observer errors occurred, so the V6 conditional same-target error
verification branch is unexercised. Earlier failed attempts remain failed.

All nine original source 8 UI cells passed with actual exit 0: seven wire cells
and two native-runtime cells, with all 410 retained original PNGs inspected
and no blocking layout defects. Terminal evidence
`r20-ui-source8-terminal-evidence-v2.json`, SHA
`3e134f5c3a3aa2796a4b24dd3d12f8634ec2b968a13c6253da94d1ecabe3513d`,
binds the original collector command
`r20-ui-source8-terminal-collector-v2-original.json`, SHA
`340b9b33ae795b9cee903c0b0e1ef96f50d5e9c1aca48782f4c47bee052810b6`.
Its nine journal scopes total 1251 records with zero verified gaps and no
unexpected errors; two actual-runtime Stop errors have exact cancellation joins.
Independent journal peer `r20-ui-source8-nine-peer-journal-audit.json`, SHA
`c620ee1bfefc82db2658d52aae254db64e216fb8a9526ad5bf27458b3cf18874`,
retains those joins. All 347 recorded owned PIDs were absent. The original
collector's failed literal comparison of a sanitized archive hash remains failed;
the cache-only V2 collector uses the original sanitized-hash rule bound to exact
archive bytes, raw integrity and prepared package provenance. Original failed collector/result bytes remain
unchanged; V2 preserves the remaining gates. This is local UI functional/visual qualification;
overall qualification remains incomplete.

Compiled source 8 Node acceptance passed all 120 original cases in
`r20-compiled-source8-passed-evidence.json`, SHA
`458550e59f9de18bcd8f34474b4bb110d060af98660303b6dec65ed7277091cc`.
The original command exited 0, source before/after guards matched, mandatory
case gates were empty and all 1606 recorded child identities closed. Three
descriptor-owned journal roots were absent, including the explicitly referenced
parent-death fixture: meaningful journal gap coverage is unavailable. Direct
native failure projections and declared cancellation receipts remain retained;
no empty-directory gap check or complete journal coverage is claimed.

Composition provenance `r20-source8-compiled-journal-composition-provenance.json`,
SHA `a6ec5ef6b2668c54877b5e09b1b8e64f9fa685db6a504ae84de0cd3402b5359a`,
traces these direct compiled fixtures to in-memory diagnostic arrays rather than
the web composition's durable journal constructor. Zero of three referenced
journal roots existed. Direct case/process evidence passes, but the prospective
complete compiled-journal clause remains unmet; absence alone does not establish
product journal loss.

Actual source 8 UI bindings retain the original seven wire and two actual-runtime
cells, raw assertions, 420000 ms bounds, Bun outer host and explicit Node/Electron
children. The 410-count census above binds this actual source 8 cohort; historical
inventories remain separate.

The wire matrix boots the actual private native-bundle host and uses the shared UI
and a freshly packaged Electron app through a QA-only loopback facade. The facade
reuses production v 2 client/admission/proxy and SSE owners against deterministic
wire fixtures; other feature routes forward to the actual host. Electron uses its
existing remote-host selector in these seven cells, so local Electron IPC is not
qualified by the wire matrix. It establishes UI wire behavior only. The separate actual-backend cells use the pinned native 2.0.20
controller and synthetic loopback provider; they establish the paths exercised
there, without paid-provider, installed-app, signing or updater claims.

## Historical results

The exact cell results and screenshot inventories are under
`.cache/v2-validation/`. Per-cell status below does not upgrade an enclosing
command that failed in a later cell. The original mobile command exited 0; the
original light desktop group exited 1 at its later 800-pixel cell. Independent
successful commands and the observed full light scenario each exited 0.

| Scenario | Status | Original checks / PNG review | Evidence and limit |
| --- | --- | --- | --- |
| Mobile web, both themes | Passed on source31 | 40 / all 137 reviewed | `ui32-mobile-all-screenshots-visual-review.json`, SHA `4b5b2b87d0d63da5822595ce3168b5b1c059d20d13d37d8171afaaf9fed74135` |
| Desktop web, light | Passed on source31 | 30 / all 40 reviewed | `ui32-web-light-visual-review.json`, SHA `9862325c671d819f002119137330ca6c67fd86b15891e76dee640c1748e8250a` |
| Electron 1280×800, light | Passed on source31 | 32 / all 41 reviewed | `ui32-electron1280-light-visual-review.json`, SHA `be100b8c6d69caf1efb437ea2e2b53d0ad79cad3a4a4008b3804ae7ea5a96c14` |
| Desktop web, dark | Passed independently on source32 | 30 / all 40 reviewed | Cell freeze `ui32-source32-independent-wire-desktop-web-dark-core-journey-1-cell-frozen.json`, SHA `1b337798b36be8229146045c871fe401ded40e2cc6c8bae508f9d5b4f31f5c05`; visual report SHA `9bbc3b2062dcc1a2cc75be41319b503669d34f38fb3f65ba21e735c2ef976a9d` |
| Electron 1280×800, dark | Passed independently on source32 | 32 / all 41 reviewed | Cell freeze SHA `c99cbdffa70262a4f73066ff4e2442e490c5225f3e7bf5ccef3e1b54967bb75e`; `ui32-source32-electron1280-dark-root-visual-review.json`, SHA `7342613ca7b363acc37368f42dba7786cbbf3fbe973555f4eac7399bdfdb638b` |
| Actual native backend, web | Passed independently on source32 | 11 / all 4 reviewed | Cell freeze SHA `b85ba5de04f04c1a7d095e827776e2a826a3a7162c88b21b02bff1ce9e5490aa`; `ui32-source32-actual-web-independent-visual-review.json`, SHA `81ed64ae123b4b7e8dfbd4e82570cf4b4bea50d96faab3e0b47575c160938160` |
| Actual native backend, Electron | Passed independently on source32 | 12 / all 5 reviewed | Cell freeze SHA `bfcf7b8cc714abad8ef98c041102bdf2b4bd9836bc606395d4ea9ffda37822e0`; `ui32-source32-actual-electron-independent-visual-review.json`, SHA `c0fd74d115b8c52a64270c911904c0bb054a3a5069f6a4b8580406b93d40a019` |
| Electron 800×800, light, full existing scenario | Passed as separate observed coverage on source32 | 32 / 41 pending review | `ui32-direct-full-scenario-original-command.json` records original exit0. The existing full scenario, arguments, assertions and deadlines are unchanged. A passive observer records only a rejected Language Server reveal; no such rejection occurred. The reviewed method freeze is `ui32-direct-full-scenario-method-frozen.json`, SHA `669faddff22582868c962adfdb7f4173a226bf2212ce43705d111c63465ca5b7`. |
| Electron 800×800, dark | Failed at startup; separate retry not run | 2 startup checks / 1 failure PNG reviewed | Cell freeze SHA `42248601963a93f87be1657861bfb08fad81373df13c047111561e929f3a2cb3`; `ui32-source32-electron800-dark-startup-visual-review.json`, SHA `6c91b17cd9fd09172f6afae24c50a1aa0faa46f30188b9722856394a834c6f9f`. Theme and 800-pixel bounds were not reached. |

Both original 800-light attempts remain failed. The first stops before Send with
8 passed checks and three reviewed PNGs (freeze SHA
`d181f37c81f4f781558fe068fc61c3c7f9907db001b74f98bd155132724ff5aa`).
The focused menu-close correction and retry reach 23 passed checks, then fail to
reveal the Language Server setting; all 22 PNGs were reviewed (freeze SHA
`0063141f5467be4e3be970af0bd15a87fbfa27d2a0ab06647856c0a5c36093f2`).
A settings-only direct run separately passes nine setup/settings checks and all
four screenshots were reviewed (freeze SHA
`9bbb792a9b513f1c73adeb1d4e4353d3f4cafc09c18f55dce4ca43dd65792073`).
That narrow proof cannot qualify the original full scenario. Neither subsequent
pass explains the earlier reveal failure. The dark startup journal contains only
16 startup records and no session correlation; navigation return/frame history
was not retained, so its cause remains unknown.

The seven completed screenshot reviews cover all 308 original images from those
cells. No blocking layout defect was confirmed. Visible limits remain: rejection
toasts expose raw error text and temporarily overlap composer controls; attachment
thumbnails show cropped previews; expanded long-input screenshots show a scrolled
portion, not every position. Plan-card previews intentionally fade lower text.
The actual-native completed file card still says “Loading session changes…” in
its static screenshot; later visual settlement was not captured. Functional
assertions and actual output bytes qualify their stated paths separately.
Native window receipts establish geometry; image dimensions alone do not.

Cleanup reports are clear and retained process identities are absent for the
completed runs. This covers recorded identities only. Each actual-native cell
retains a nonempty session journal and successful gap check. Wire journals are
primarily host lifecycle evidence and do not establish native prompt/tool/task
correlation. All attempts use isolated private profiles and the saved user setup
is unchanged.

## Fresh preparation and coverage

`scripts/qa/stage-f-preparation.mjs` exports `prepareStageF`. Supply repository-owned
real paths and explicit fresh hashes for `nativeArtifactRoot`,
`nativeManifestSha256`, `nativeBuildID`, `webDist`, `webArtifactSha256`,
`nativeSourceApp` and `nativeSourceAppSha256`. It verifies linked native build
inputs, copies immutable UI bytes, packages fresh Electron assets, runs the
existing packaged native smoke, and requires unchanged source/runner/artifacts
through preparation. Preparation starts no UI journeys.

The returned `prepared.json` pins the source, scripts, native artifact, copied UI,
Electron package and generated matrix JSON files. Use its actual output paths;
old build9 cache names and prior candidate hashes are not current inputs.

| Matrix | Cells | Scope |
| --- | --- | --- |
| `wire-g2-matrix.json` | 7 | Web Light/Dark; Electron Light/Dark at 1280×800 and 800×800; mobile web both themes |
| `runtime-g2-matrix.json` | 2 | Actual native backend through desktop web and packaged Electron |

Run sequentially with one GUI owner. Each desktop core journey includes a genuine
empty-history selected session with retained-input wire state, lazy long details,
metadata-only attachments without URI fetching, exact pinned Resume/Discard
requests, visible hit-tested controls after scrolling, no horizontal overflow,
and two retained screenshots. Native window bounds and viewport observations
must match the requested geometry. Screenshots alone do not prove geometry.
These retained-input wire checks are explicitly not native restart/replay proof;
the compiled package lanes qualify that authority separately. Natural compaction
and session continuity use the existing actual runner on web and Electron and
remain separate acceptance gates.

## Commands

After a fresh build/artifact freeze, save the exact preparation fields in
`.cache/qa/stage-f-v2-inputs.json`, then prepare without launching GUI journeys:

```sh
bun --eval 'import fs from "node:fs/promises"; import { prepareStageF } from "./scripts/qa/stage-f-preparation.mjs"; console.log(JSON.stringify(await prepareStageF(JSON.parse(await fs.readFile(".cache/qa/stage-f-v2-inputs.json", "utf8"))), null, 2));'
```

Set `DEVRYAN_QA_DIST_DIR` to the returned copied `webDist` and
`DEVRYAN_QA_PACKAGE_EVIDENCE` to the fresh package's `package-evidence.json`.
Set `QA_PREPARED_ROOT` to the directory containing the new `prepared.json`, and
export `QA_NATIVE_ARTIFACT_ROOT` for both wire and actual-backend runs. It must name
the same verified artifact used during preparation; the wire host also boots a
real selected native bundle. No skip-start or external OpenCode host flags are used.

```sh
DEVRYAN_QA_OPENCODE_VERSION=2.0.20 \
  bun scripts/qa/run.mjs --config "$QA_PREPARED_ROOT/wire-g2-matrix.json"

DEVRYAN_QA_OPENCODE_VERSION=2.0.20 \
  bun --eval 'import { runNativeBackendUiDiagnostic } from "./scripts/qa/native-backend-ui-diagnostic.mjs"; const result = await runNativeBackendUiDiagnostic({ configPath: process.env.QA_PREPARED_ROOT + "/runtime-g2-matrix.json", artifactRoot: process.env.QA_NATIVE_ARTIFACT_ROOT }); console.log(JSON.stringify(result)); if (result.outcome !== "passed") process.exitCode = 1;'
```

`QA_NATIVE_ARTIFACT_ROOT` must name the same frozen native artifact used in
preparation. Export the path variables for the subprocesses. Every cell retains
automated checks, package/artifact/source/runner fingerprints, console errors,
new private diagnostic journal health, canonical fixtures and cleanup. Review
every original retained PNG separately, recording exact hashes; do not rewrite
automated failures. Source or runner drift fails the cohort. Never reuse a
partially failed cohort as successful qualification.

## Archived evidence

The earlier immutable UI `.cache/qa/stage-f-web-gkw031` had SHA-256
`b6b383e27ec9cb5fc62d96241f9742b94ccee296f32eac34a0ad7e52366fac1d`;
`.cache/qa/packaged-electron-lblzAJ/package-evidence.json` recorded archive SHA-256
`c68565a8ece88dc77da6c33c248f6ce21c29400a4411bd87da44be89251cf475`.
Its native donor was `.cache/qa/packaged-electron-hYD0Xk/app/mac-arm64/DevRyan QA.app`.
Those pins describe earlier source and are superseded for current acceptance.

The interrupted generation-1 diagnostic remains at
`.cache/qa/stage-f-wire-g1-diagnostic-interrupted`, with log
`.cache/qa/stage-f-wire-g1.log`. It stopped when scripts-tree drift overlapped
in-progress helpers; it is not qualification. Cleanup reported no errors or
remaining owned processes. Its journal reported zero gaps/queued records and no
last error. All 21 retained PNGs were inspected, with exact hashes recorded in
`visual-review.json`; interrupted checks remain unverified. This archived review
does not satisfy the fresh v2-only matrix.
