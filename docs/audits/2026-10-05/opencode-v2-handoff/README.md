# DevRyan OpenCode 2: verified finish plan

> Historical — archived 2026-10-09; current contract: [OpenCode module documentation](../../../../packages/web/server/lib/opencode/DOCUMENTATION.md)

Status: **implementation and final qualification are in progress**. The accepted
2026-10-02 scope is native OpenCode **2.0.20 only**, starting fresh without v 1
conversations or diagnostic journals. Preserve effective settings, projects,
agents, commands, skills/resources, provider connections, saved roles, Council
selections and workspace bytes. Old database files remain unused. Do not import
old tasks, continuations, permits, receipts, caches, journals or Undo state.
Valid v 2 bundles and their new conversations/journals survive subsequent starts.

Bots are in scope only for the OpenCode **2.0.20 runtime pin**. Bots feature,
history, Docker and live-behavior qualification are excluded by the user's later
scope correction. No Bot history deletion is requested. Public publication and
installed-app cutover remain separate work.

The accepted 2026-10-04 review adds eight required corrections: startup route
availability separate from integrity; preserved explicit model/effort intent;
warm-projector assistant activity; restart cleanup and accepted settings;
protected retryable complete setup; bounded unsettled helpers retaining their
real permits; selected-profile host-owned Claude renewal; and coherent derived
v 2 upgrades with compatible credential rollback. Implementation is ongoing.
The subsequent Claude counter-review fixes the credential policy: independently
enrolled DevRyan Claude profiles may renew automatically; shared CLI profiles are
access-only and reconnect at expiry. Durable nonsecret lifecycle metadata lives
in native KV, with revision-checked private commands and the existing mutation
queue. Status/quota inspection is read-only. Interrupted renewal can settle only
the recorded canonical replacement, never repeat an uncertain issuer request.
Unresolved grants remain fenced across aliases, enrollment and rollback.
All source 32/native 9/application 31/package 32 results below predate these changes
and are historical evidence, not qualification of the current working tree.

The final live graph retains Orchestrator `openai/gpt-6-astra/medium` in both
normal and Plan modes, Fixer `openai/gpt-6.1-sol/medium`, Builder
`xai/grok-4.6/high`, Designer `anthropic/claude-opus-5-5/medium`, Oracle at high,
Explorer/Librarian `opencode-go/deepseek-v4.1-flash/high`, and Council coordinator
`openai/gpt-5.6-sol/medium`. Backups remain Fixer → Grok/high, Builder → Sol/medium,
and Explorer/Librarian → `opencode/deepseek-v4.1-flash/default`. Ordered Council:
`openai/gpt-5.5/xhigh`, `cursor-acp/composer-2.5/high`,
`opencode/claude-opus-4-5/default`, `opencode/deepseek-v4-flash/max`.
Cursor remains required. Earlier suggestions to replace its effort are withdrawn;
only fresh discovery for the actual selected account can establish availability.

The current qualification requires three normal and three Plan journeys per
host, two manual and two natural compaction boundaries per required mode per
host, all configured roles/backups/Council seats, seven wire UI cells and two
actual-runtime UI cells, production Stop/restart/parent-death checks, and a
genuinely derived A → B → A transition. Live grants must be independently issued;
copied installed OAuth refresh tokens cannot qualify isolation. Claude's default
live lane uses an independent access-only profile that refuses at expiry.
The 750 ms production interval remains unchanged until fresh six-arm attribution,
21 calibration launches and 42 paired launches qualify the 1500 ms candidate.

## Current completion gates

1. Finish the final UI corrections, freeze their source, and run all seven wire
   UI cells and both actual-runtime cells on that candidate;
   inspect retained screenshots across themes, mobile web and packaged Electron.
2. Run full deterministic validation after the final corrections and bind the
   application build and bundle checks. Preserve the original compiled-native,
   production lifecycle, derived A → B → A, CLI and isolated Claude passes only
   within verified unchanged execution scopes; requalify any changed inputs.
3. Prepare the final-candidate sign-in handoff through existing account flows and
   complete independent provider sign-in,
   then verify the exact graph above, three normal and three Plan journeys per
   host, compaction and correlated diagnostic evidence. Managed authorization
   separately requires the non-production Supabase fixture and assignments.
4. After the local functional freeze, run six-arm interval attribution, all 21 calibration
   launches and all 42 paired launches. Freeze the grading policy before pairs.
   Report local measurements within that scope. Retain 750 ms unless every
   required functional gate and frozen budget passes with measured benefit.

One final evidence table must tie passed, failed, unavailable and not-run gates
to the final hashes. Source checks, historical candidates and short diagnostics
do not qualify that artifact or establish measured improvement. Missing platform
or signing evidence blocks the corresponding release.

## Current final-candidate evidence

Status remains **in progress**. This table is the authoritative current register;
the registers below retain their original historical scopes. The current source
freeze is `r20-source-final-8.json` SHA
`380b23d533d88e97c41834adf9b84f8b47b2129541948dac2d03553982cd35f6`,
with source identity
`275f5e957a152c11cf4d3d7e61f1d84a0d38d0c56c0eb3ac7bac1977c567eb0d`.
Its only changes from source 7 are five test imports using the existing explicit-loopback
Supertest helper. Both standard and passive focused runs passed all 47 tests;
production runtime and preload IPC bytes remain unchanged.
Native B has manifest SHA
`436f16668243af5ae58ea393202499d25e8c06efeeffda093670784a8c43b5c2`
and build ID
`e587eaa60f83f2911ee89223504357a7f72879f6ba0557fd652fa2b0978ebef7`;
its 4,695 linked inputs remain unchanged. Paths in this table are relative to
`.cache/v2-validation/` unless explicitly identified otherwise. Preparation and
focused checks do not establish complete functional, live or release qualification.

| Gate | Status | Current evidence and limitation |
| --- | --- | --- |
| Full deterministic validation | Passed | Source 8 full 9 actual natural exit 0 and final source/build guards passed in `r20-validate-full-source8-passed-evidence.json`, SHA `673cdd49b1c4c6413ba2aabb4f07d6a13b2941f756ba106f9547283a007b63ca`. Source 7 full 8 remains failed in `r20-validate-full-8-failed-evidence.json`, SHA `882b895bdaf5a54b8f8de0b1a0512584339a3192a4abcc287e2f9c8e440c9d71`; its two HTTP fixture failures and the original source 6 historical pass remain retained. |
| Application build and startup bundle checks | Passed | Source 8 `r20-final-build-source8-evidence.json`, SHA `70dd2532f93a8ce372b87346c783e4116efefce203f07d2fcb2d00272779623a`, binds actual build 8 and bundle-check exits 0. Renderer671 and main270 bytes remain unchanged. |
| Fresh Electron QA preparation | Passed | Source 8 `r20-stage-f-ui-prepared-source8-evidence.json`, SHA `830054c47f1fdff7c7de6261a1f04f20c53922e86e4e6a9922bcc2e5f5b812d1`, binds app PS8vcA and matrix sTYUw6. Package evidence SHA `02a85f22837b74f86ae2b7b6affa322b381380b5b0fcfaee69a4dfefd307d35d`; whole-app SHA `d3be303e84704cf20471cd567c0dad9d5894739b91a93b7bddc2bbc6b22338c6`; archive SHA `6040804e38642325eab38619ea9f1c6678d60718c5961df1e6bc706248d1fa67`. The earlier source 7 Node packager refusal remains failed. Packaging/smoke does not qualify UI or signing. |
| Held-recovery readability | Passed | Source 7 presentation correction held at `r20-recovery-contrast-correction/held.json`, SHA `c75c5f3e9057b7b73abd1eb2bf6e148b0faba1abffd92537b073cc22464591e8`. Three existing owner tests and four actual static Electron render cells passed; light/dark desktop/mobile screenshots are readable, with minimum text/control contrast 6.70 and no horizontal overflow. Peer byte/pixel review SHA `4b6a7acac1b89b3764e1ef39d12b501363f75db1d7f5dab67cacf295b5b54afd` and root pixel review SHA `13b699217677cb6a69a1d1a2740e80aa7c9bc9ffe4b6d1317a1ed41606d27b96` retain this bounded scope. HTTP routes, CLI revision expression and IPC script are unchanged. This does not establish native Cancel/Resume interaction. |
| Effective saved graph and project overrides | Passed | Retained source 5 two-host snapshot `saved-project-finalB-r20-snapshot-KJzxiE/result.json`, SHA `c11bc302fed5638fb437a8a2abbed610b09f6c698626bd7cadfdb97d9eddfcd4`, resolves the approved 522-record noncredential mirror. Source 8 continuity `r20-source8-scoped-continuity.json`, SHA `ce11c4b9888ecb85292569b2dee042a8df13d905d131d22cc296bfe0d8ca2e5a`, retains only unchanged configuration owners; no fresh source 8 execution or present installed/account/MCP/live routing is certified. |
| Compiled native acceptance | Passed | Source 8 `r20-compiled-source8-passed-evidence.json`, SHA `458550e59f9de18bcd8f34474b4bb110d060af98660303b6dec65ed7277091cc`: actual natural exit 0, all 120 original case IDs passed, source guards matched, mandatory case gates empty and 1606 recorded child identities closed. Three descriptor-owned journals were absent; meaningful journal/gap coverage is unavailable. Direct failure projections and physical cancellation receipts are retained; no empty-directory gap pass is claimed. Composition provenance `r20-source8-compiled-journal-composition-provenance.json`, SHA `a6ec5ef6b2668c54877b5e09b1b8e64f9fa685db6a504ae84de0cd3402b5359a`, traces direct fixture diagnostic arrays: zero of three durable journals present, so the prospective complete-journal clause remains unmet. Earlier compiled failures remain failed. |
| Claude policy, enrollment and retired credential replies | Passed | Retained focused enrollment/UI/native-channel and isolated synthetic renewal checks qualify their declared backend scopes only. Independently issued access-only Claude with real expiry remains the default live requirement; dedicated enrollment requires separate authority. Live sign-in proof remains unavailable. |
| Whole application lifecycle and native Cancel | Passed | `r20-application-source8-passed-evidence.json`, SHA `49eaebba84cf37cff9f2de4aaf32ba28801b5416a1ae0328fb773a8d23c7be16`: all seven modes, actual trusted Cancel reply, two desktop PNGs and 17 owned PID closures passed. Journals retain 312 sealed records/10 chunks plus seven complete open runtime rows from intentional parent-death; strict all-sealed inspector refusal is retained, while sealed metadata joins and actual gap verification pass. Three unique original Stop events explain four retained raw abort errors. Source 6 failures remain failed. |
| Independent positive Electron Resume | Passed within disposable first-desktop scope | `r20-positive-electron-source8-retry6-passed-evidence.json`, SHA `c7a95ef1c39dfa01a9e2d97ad1567d514b40d6299c9e41221df2f6707159c9a5`: original natural exit 0, real native Resume/relaunch, strict rendered/health readiness, exact histories/provider credentials/owner keys, prospective first-desktop config and actual persisted port passed. Two actual PNGs passed root review SHA `6154aaeac9646c837724d57b073b52624ad34de6ca9b6b2be12d456efcc074b2`; 240 sealed rows/7 chunks, zero verified gaps and 194 owned PIDs absent. Whole B settings/vault bytes are scoped for exact initialization/ephemeral login sessions; no V6 same-target error branch execution occurred. The underlying capture intentionally fails at its cold hook; whole application acceptance remains the separate pass above. First attempt `r20-positive-electron-source8-first-failed-evidence.json`, SHA `1e3b5e8f860b0132ba816bbaf9716d0a7d3429eaf494cf4385ca4fb4f1884304`, and retry1 `r20-positive-electron-source8-retry1-failed-evidence.json`, SHA `b896c985c9f26ff1ce26ecb1e47e660f641824802e067bedbf79ccc17c5f1536`, remain failed; later failures are retained below. |
| Seven wire and two actual-runtime UI cells | Passed local functional and visual scope | `r20-ui-source8-terminal-evidence-v2.json`, SHA `3e134f5c3a3aa2796a4b24dd3d12f8634ec2b968a13c6253da94d1ecabe3513d`, binds all nine original exits 0, all 410 retained original PNGs inspected, 1251 journal rows/zero verified gaps, exact cancellation joins and 347 owned PIDs absent. Original collector command SHA `340b9b33ae795b9cee903c0b0e1ef96f50d5e9c1aca48782f4c47bee052810b6`; independent journal peer SHA `c620ee1bfefc82db2658d52aae254db64e216fb8a9526ad5bf27458b3cf18874`. Original 420000 ms bounds, Bun outer and explicit Node/Electron children retained. Failed literal sanitized-hash collector remains failed; cache V2 binds the original sanitized-hash rule to exact archive bytes/raw integrity/package provenance. No saved-provider/live/release acceptance. |
| CLI persistence and older-artifact refusal | Passed | Retained source 5 CLI 7 `r20-cli7-source5-cohort/evidence.json`, SHA `0a5420e089bb1be93112f811f65c916c9af0245cca139973304f4ff6045f49cd`, and native 4 `r20-original-native4-I9pb5i/result.json`, SHA `7974f3a3561fad13ba4c5d6e650d154d81263b8151acbb0ebab9f8206179c26d`, are scoped through `r20-source8-scoped-continuity.json`. Native 4 uses only the byte-identical snapshot export of the changed rollback module. No fresh source 8 runs are claimed. |
| Independent sign-in and exact live graph | Unavailable | No independently issued user grants have been confirmed. The 16 saved role/backup/Council bindings and 12 normal/Plan journeys remain unqualified. Five other-provider acquisition callbacks require genuine checkpoint authority that the current auth UI does not expose. Copied grants and model/effort substitutions cannot qualify this lane. The user's GPT-6.1 Sol/high preference for our review subagents does not change DevRyan's approved role graph above. |
| Manual/natural compaction and agent managed authorization | Unavailable | The 16 required live compaction boundaries remain unrun. Password-free ownership/revocation/event-filtering checks need nonproduction Supabase configuration, reserved agent-test profiles and assignments; Bots exclusions do not remove agent requirements. |
| Local interval attribution and performance | Not run | Production remains **750 ms**. Source 8 cache-only `.cache/perf/r20-source8-stage-e-held-handoff.json`, SHA `457c66137cdda6acb384b4b445c4ddfbf0da40fcc3571e9205389ad4bc08a903`, binds the unchanged Node runner and fresh future paths. No measurements have run; launch requires a completed scoped local-behavior declaration and fresh quiet/storage checks. The separate diagnostic retains 24 warmup plus 16 measured writer calls; full Stage E retains 6+21+42 launches with frozen budgets, actual local functional gates and fresh quiet/disk/load observations. Host observations 1 SHA `5df2a07c53cfb0dada29877187c3eac04e33a25712d901ae99610180a1316e52` and post-runtime 2 SHA `0654b3ab761196e0eec89e135eecfc4ff57d2735549f1d51ff97f52f5854d8ba` under `.cache/perf/r20-source8-pre-performance-host-observation-{1,2}.json` retain OS background CPU contention; neither approved a quiet slot nor launched a measurement. |
| Bots runtime source pin | Passed | Source 3 `r20-bots-v2-source-audit-source3.json`, SHA `188a82085816495c3e78722413d431df2db2049352cd58c7a47df0ae96cb016e`, remains narrowly retained through source 8 continuity: all five audit inputs unchanged. This is source-pin evidence only; no Docker/image/runtime acceptance. Bots feature/history/live gates remain excluded. |
| Release and installed-app cutover | Unavailable | Platform, signing/notarization, public release and installed-app cutover remain unqualified and separate from package 8 QA preparation. |

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

The three failed source6 application results retain their original bytes:

- `r20-application-final6-a4T4EE/result.json`, SHA
  `f7b2a9f1ff0ccc39910a58fbb7248271dc9302faaf73a32ae96798e710e0a3a2`;
- `r20-application-final6-k7jSZv/result.json`, SHA
  `7fe943a00fee6cc6242860c6a9e363b06cd54247ff0ccd042d657a8671b027e7`;
- `r20-application-final6-w1Ydsy/result.json`, SHA
  `497cbed06613301aa304e9344037b28e7c37b0b4ee3ab1bb96f5af57c54c8ea3`.

The earlier source5 failure also remains retained in
`r20-application-final5-Th6WfU/result.json`, SHA
`7932264bfe261caef824fe32c751356621459719e00093da0b60bb89a421f447`:
upgrade/rollback-crash passed before held recovery failed prior to native input.
`r20-positive-electron-final-5-original.json` retains its original exit1.
Neither the focused correction nor later dialog visibility regrades these runs.

## Earlier candidate evidence registers (removed)

The October 4 historical candidate evidence table and the earlier v2 evidence register recorded superseded source-freeze runs. They were removed on 2026-10-09 to keep this archive under the size limit; recover them from the git history of this file (previously the top-level OpenCode 2 upgrade plan).

## Historical checkpoints (superseded scope and qualification)

The records below describe earlier migration/cross-generation work. They retain
failure evidence and technical findings; their v1 imports, v1 rollback targets,
and cross-generation benchmark/UI instructions are superseded by the gates above.

The pre-removal source checkpoint is `.cache/v2-validation/v2-only-before-20261002T173605Z` (2,212 changed or untracked files, with hashes and deletion records). Three GPT-6.1 Sol reviewers at high reasoning previously audited runtime authority, compatibility and verification; Fable 5.1 reviewed the retained evidence and remaining plan. None of those earlier checkpoints qualifies the current transition.

Candidate 25 has a verified build and all 4,664 linked inputs checked. Its compiled
preflight passed 22 cases, including a retained initial prompt with a lost
acknowledgement, explicit same-ID resume, and no replay after another restart.
The following two-input case cancelled the older input but could not prove that
cancellation afterward: the original SDK does not persist events by default.
The correction records a bounded receipt atomically with the native cancellation
and binds shell recovery to its existing sealed lease. Independent review and
51 owning, 32 native graph/shell, and 17 adjacent tests pass, along with native
types and lint. Candidate 26 is built with all 4,666 inputs verified. Its compiled
preflight passed 24 cases, including retained initial input, exact multi-input
discard/resume, and discard acknowledgement loss across controller replacement.
The following real HTTP 429 case exposed a separate ordering defect: Slim's retry
hook requires an assistant step before the SDK's lazy publisher creates it.
The retained database contains the accepted user and failed idle, with no
assistant. The correction keeps the fallback choice inert until the exact real
step binds it, and protects all four native handshake callers against stale
controllers. Independent review, 199 core/host tests, five Slim tests, 18
step/context tests, native types and lint pass; 77 combined frozen files match.
The compiled fixture now starts a fresh controller before the 429 and recognizes
the v2 status endpoint's omission of idle sessions. Candidate 27 is built with
all 4,666 linked inputs verified. Its compiled preflight again passed 24 cases,
then settled the cold 429 and queued the fallback. Replacement startup failed
with `bundle_message_reference_lost`: the occurrence-scoped pending-input proof
omits `record.recoveryPrompt.messageID`, although it already proves the same
queued ID at `record.recoveryID` and `record.guardedIDs`. The narrow correction
passes 52 owning tests and independent review, including queued and cancelled
aliases and rejection of mismatched or unrelated occurrences. Both changed
files are outside the compiled inputs; all 4,666 inputs were reverified unchanged.
The compiled retry passed 26 cases, including actual fallback same-ID resume
and fallback discard followed by a fresh prompt. The new queued-shell case then
failed because completion inference preceded its intended departing-runner gate;
the retained state and fixture gate are under review. Retained-shell qualification
remains pending. The reviewed fixture correction waits for the original actor's
real idle, then holds the acknowledged shell continuation before wake; all
queued-state and no-replay assertions remain. Eight helper checks pass, and the
compiled retry is running. Application build 9, bundle checks and fresh Electron
package preparation pass, including real SQLite and PTY smoke checks. The 14
wire UI and four actual-backend journeys have fresh configurations and remain
unrun.
All 47 source-native cases passed on unchanged candidate 27 source with clean
process settlement and no observed diagnostic gaps. The failed compiled fixture
retained its database and diagnostics; it had no production journal, so journal
coverage is unavailable.

The resumed sequence corrected catalog/readiness, the real-owner MCP refusal,
status-message parenting and continuation image context. Candidate 19 passed
the original interview but failed its following durable interrupted-idle check.
That Stop defect now has a passing real-owner regression and candidate 21 passed
all 21 compiled preflight checks, including Stop. Full package qualification
passed 40 cases before a fixture used the public client for privileged session
permissions; the tenth full validation also failed one readiness-policy test.
Both corrections passed focused checks and independent review. The eleventh
full validation passed, including all 6,068 web tests. The package retry passed
44 cases before the original webfetch schema rejected the fixture's IP-host URL.
Fresh source-native and TODO checks passed; compiled Cursor passed its lifecycle
cases but exposed an observation gap for external Cursor projections. The first
UI matrix also found stale Settings navigation and a missing expected Plan
directory in its fixture. These corrections now pass focused checks. Candidate
22 is built with verified inputs. Its compiled Cursor checks pass without
observation gaps; the full package passed 48 cases, including original webfetch,
before the first image-tool call failed. The image worker completed and published
its file, then native result validation rejected its undeclared output schema.
The registration now uses the original plugin API's string validator; all nine
image checks and the native typecheck pass. Candidate 23 passed the compiled
image refresh, account-switch, publication and cancellation checks. Its full
package run passed 56 cases before the first skill supporting-file read was
refused as `native_read_root_denied`. The real-source regression now passes the
corrected Slim metadata guard and the native external permission flow. Those
fixes are frozen. All 47 source-native cases, source TODO continuation and seven
compiled Cursor cases now pass on the unchanged source, with clean process
settlement and no observation gaps. The full package retry passed 81 cases,
then timed out waiting for an external permission prompt on a later support read
whose native record is completed. The original SDK already permits this read
inside its selected configuration directory. The reviewed fixture correction now
preserves strict approval checks for external support files and explicitly checks
the config-contained case. Seven focused checks pass. The next full package run
passed 101 cases, including the complete skill inventory, browser, documents and
tracked controller replacement, before TODO replacement hit
`migration_pending_input_unsupported`. The bundle's resume verifier rejects the
exact durable queued TODO continuation before owned recovery can run; its
reference verifier also recognizes only committed message IDs. A narrow resume
correction now passes 165 focused checks, eight migration checks and five durable
continuation checks, plus verification against the retained failed database.
Independent review found no remaining blockers in this narrow correction;
candidate 24 now passes the compiled TODO restart, removal, removal recovery
and rollback. Its full run passed 106 cases before the final parent-death probe
failed at configuration binding, before its tool started. The probe's baseline
path now uses the existing isolated snapshot constructor, and the actual
parent-death rerun passes with confirmed descendant termination, an empty
registry and no publication. Broader queued-prompt recovery is being implemented:
the UI's 22 focused checks and 30 host-route checks pass, including partial
SSE updates and exact discard controls. Two context checks and four primary-step
checks preserve fallback permissions and model selection through compaction.
The original native Inbox/Bus graph also passes whole-batch refusal and exact
cancellation without a mutex deadlock. An actual hash-verified candidate 24
controller rejects the recovery boot field before SDK startup; a controller
without that guard cannot silently open a retained session. Native owner and
bundle regressions, a fresh compiled candidate and assembled recovery remain
under verification. The independent native/TODO/Cursor checks passed
again. The thirteenth full validation was interrupted after UI tests passed and
before the web suite reported a result, so that run remains incomplete.
The fresh app build and Electron packaging passed. The twelfth full validation passed, including 6,069 web
and 4,027 UI tests. Stage D remains unqualified until the
full assembled gates pass. The complete source checkpoint taken before resumed
implementation is `.cache/v2-validation/resume-checkpoint-20261002T071343Z`;
earlier candidates remain historical evidence.

Readiness must check exact effective model/effort selections per location,
including ordered Council selections and project overrides, separately from
credential availability. The pinned embedded catalog contains Grok 4.6 but lacks
6.1 Sol; `.cache/v2-validation/resume-embedded-catalog-presence.json` records
presence against the retained global Slim declarations only. It does not prove
effective resolution, variants or live provider access. Missing selections must
not be substituted. The exact public catalog captured under
`packages/web/runtime/reviewed-inputs/model-catalog/` contains 6.1 Sol. Its SHA-256
is `1290e78c59b72a425cb6c39c1c354a780a4e002605f03c9867f17271c7cb04b9`;
candidate 21 embeds those bytes through the SDK's existing file option, with
their exact hash verified in its linked source inventory. Its expanded
composition preflight passes the corrected tool-catalog route and original
reviewed commands. Full assembled qualification remains in progress.

The real-owner MCP regression traced the refusal to the harness-context wrapper
dropping `nativeToolID`; the narrow correction preserves the native ID through
both authorization paths and the outer execution record. The focused real-owner
graph passes ordinary/admitted execution plus changed-input, stale-permit and
revocation refusals. The sealed Slim resolver also now applies file/environment
presets as defaults before explicit root and host selections. Its original
runtime-preset setter had overwritten six saved roles. The original-failure and
corrected regression evidence is retained under `.cache/v2-validation/resume-*`.
Neither source-level correction qualifies the assembled candidate.

The next coherent candidate first runs cheap registration and owned-control
checks. Full assembled integration, actual v1/v2 backend UI journeys, saved
provider runs, independent performance calibration and paired measurements,
migration/rollback, and final verification after the last correction remain
required. Wire fixtures do not replace actual backend journeys. A focused
preflight does not replace full qualification, and noisy or missing mandatory
performance measurements remain inconclusive or unavailable. The Fable review
does not reduce the original A–G scope or authorize installed-app cutover.

Target: OpenCode **2.0.20**, with the matching native packages pinned exactly. Scope: web and Electron **agents**, including the effective personal plugins, skills, saved roles and provider routes. Bots keep their independent runtime; no Docker overhaul or new Tauri features. Preserve all existing uncommitted work. The audit inventory is `.cache/v2-validation/replan-tree.json`, based on `797146b3`, with 249 changed or untracked files.

## What first principles change

The result is a working agent harness with preserved user behavior and measurable improvements. Reaching a particular phase number, translating every endpoint, or loading a plugin is not completion.

| Responsibility | Single authority | Consequence |
| --- | --- | --- |
| Conversation, inference, native context and compaction | OpenCode 2 | Use native facilities; do not emulate the v1 engine. |
| Managed roles, task graph, dependencies, budgets, selected plan and continuation ownership | Existing DevRyan orchestration and harness | Native children/inboxes are mechanisms. They do not become a second scheduler or independently resume parents. |
| File ownership, selective Undo/Revert, publication and recovery | Existing DevRyan ledger | Native snapshot diffs and projected tool metadata cannot authorize or describe committed writes. |
| Process confinement, descendant termination and receipts | Existing native supervisor | An interrupt response is not proof that a process stopped. Completion and publication wait for authoritative settlement. |
| Authorization and runtime generation | DevRyan host admission | Enforce before effects, including in-process paths, startup recovery and plugin hooks. UI capability hiding is not enforcement. |
| Activity and UI state | Live native state plus bounded reconciliation | History restores context; it cannot overwrite newer activity or establish permission. |
| Performance decisions | Matched measurements of successful work | Separate provider generation from local waiting. Retain an optimization only when its benefit survives correctness and resource checks. |

The smallest viable architecture remains one Bun runtime host embedding the pinned native SDK, with mandatory service enforcement outside removable plugins. The web process retains its existing ledger and scheduler; use its authenticated private bridge rather than instantiate another authority in Bun. The shared UI retains its existing application contract through one server client/projector/facade boundary. Keep the generation-1 backend for explicit compatibility and rollback while the native candidate qualifies; this is not a reason to duplicate native behavior indefinitely. No general v1 plugin emulator, replacement scheduler, process pool, or speculative cache is needed.

**A patch-free host remains a hypothesis until the integrated acceptance gate passes.** If an indispensable native boundary cannot be enforced through the exported SDK, document the exact counterexample and use the smallest necessary pinned seam. Do not weaken the invariant or rewrite the native engine to preserve a slogan.

## Current state, without phase inflation

| Area | Actual state | What remains before it counts |
| --- | --- | --- |
| Generation client, route policy, projections, facade and UI capability handling | Substantial code exists; focused suites pass in several areas | Integrated wiring, unfinished race/bounds tests, current-tree full validation, and real host verification. |
| Review fixes | QA isolation/manifest/pairing fixes have focused passes; runtime/reseed fixes are present | Verify the frozen combined tree. Earlier passes predate later shared-client and harness changes. |
| Native runtime host | Integrated candidate passed native acceptance with the existing ledger, supervisor and scheduler; production generation-2 launch remains unavailable | Compiled artifacts, production lifecycle and authorization, migration, and effective integration parity. |
| Native plugin/skill parity | Inventory and partial native facade experiments | Effective registrations, behavior, permissions, cancellation and actual saved provider routes. |
| Baseline live QA | Useful historical runs with failures and gaps | A reproducible matched baseline; no substitutions counted as saved-route success. |
| Performance | Partial ledger and cache evidence | Actual provider TTFT/TPS, process-tree CPU/RSS and matched local-stage measurements. |
| Migration/rollback | Importer experiments on copies | Coherent runtime/config/data/harness selection and recovery after candidate-created work. |

The audit confirmed several concrete defects or unfinished contracts, in addition to the absent native host:

| Finding | Evidence | Required closure |
| --- | --- | --- |
| Display parent used as execution authority | Equal-timestamp single-message projection can choose a later user, unlike sequence-ordered full history. `session-execution-host.js` uses that parent for ledger admission/receipts; `harness-task-context.js` uses it for plan authority. | Exact native sequence/host-attested turn ownership for every execution and plan check; keep display inference separate. |
| Response bounds not preserved everywhere | The v1 error branch reads unrestricted text; v2 status retry lookup can swallow a response-limit exception and return busy success. Both reproduced with 4096-byte fake responses under a 128-byte cap. | Shared bounded error/success reads and propagation of caller budget/cancellation failures. |
| Capabilities stale after runtime replacement | UI capability cache loads once; current production callers do not force refresh. | Invalidate from authoritative runtime identity and test replacement without reloading the page. |
| Admission/tool and retry semantics incomplete | Reproduced: warm dedup ignores changed tool rules/objective/origin/resume behavior; native-conflict recovery accepts matching text despite changed image or Plan metadata. Selection may change before that conflict is discovered. `body.tools` also does not yet become permissions. | Bind idempotency to the exact accepted turn, including attachments, segments, selection, delivery and host metadata. Reuse durable admission identity; return explicit conflict/uncertainty when equivalence cannot be established. Apply no conflicting selection change. Enforce tool restrictions before prompt. |
| Current host injection incomplete | Recovery and session-change host client options exist but are not injected in the server composition; runtime paths are empty. | Complete composition and test the actual routes rather than only fake-client helpers. |
| QA runners do not yet prove saved-setup isolation/parity | Matrix cells do not expose/pass personal-setup mirroring; resource launcher inherits unchecked process environment; current comparator rejects cross-generation fixtures. | Explicit isolated runner inputs, effective per-role inventories, launch-environment tests and a qualified upgrade comparator. |

The pre-audit focused integration run recorded **233 passing and 2 failing tests across 7 files** in `.cache/v2-validation/root-routes.log`. The failures concern managed diagnostic path evidence and a readiness timeout reason. That run preceded the final added generation-2 ownership cases. Both original tests remained unskipped and passed in the completed web suite without intervening product changes; retain the earlier failures as result variation to diagnose rather than dismissing them as flaky or unrelated.

The historical baseline README overstates success: Oracle hit a provider limit before Council; Designer and the three-way case have failed work; Implement Plan lacks completed evidence and proposed a substitute Builder route. The retained cache table has four non-abort warm-gap breaks plus Stop, rather than the README's two plus Stop. The reported 0.861 cache-read ratio is descriptive coverage, not proof of cache-hit rate, native provider latency or upgrade superiority. Message creation to first visible part is not provider time to first token. The G2 millisecond staging microbenchmark excludes the production ledger and is not comparable to the full v1 tool burst.

## Checks performed during this replan

| Check | Result | Evidence and limits |
| --- | --- | --- |
| Frozen working-tree inventory | Preserved | `.cache/v2-validation/replan-tree.json` and `replan-freeze-check.json`; only the two plan documents changed after capture, with no new changed paths. |
| Workspace lint and typechecks | Passed | `.cache/v2-validation/replan-validate-full.log`. These do not yet typecheck a product native host because it does not exist. |
| `validate:full` | Failed before deterministic tests | Three obsolete/missing source references in the historical Claude plan. Do not call this command green. |
| Documentation after plan corrections | Passed | `.cache/v2-validation/replan-docs-final.log`; corrected only plan references/status, with existing historical warnings retained. |
| Web/PWA and Electron build | Passed | `.cache/v2-validation/replan-build.log`; this builds current application artifacts, not a packaged native-v2 runtime. |
| Startup bundle budgets | Passed | `.cache/v2-validation/replan-bundle-check.log`; a bundle budget pass is not an upgrade performance result. |
| Deterministic script suite | 808 passed, 3 failed initially; failed cases passed in isolated rerun | `.cache/v2-validation/replan-test-full.log`; all three release-argument fixtures inherited the repository's ES-module scope. Unchanged assertions passed 3/3 with isolated temporary-directory scope in `replan-release-args-isolated.log`. |
| Harness deterministic suite | 536 passed, 2 failed, 2 errors initially; failed cases passed in isolated rerun | `.cache/v2-validation/replan-test-harness-runtime.log`; both non-Git fixtures discovered the enclosing checkout. The same cases passed 2/2 in 3.72 seconds with the temporary root as Git discovery ceiling (`replan-harness-isolated.log`). |
| Other deterministic packages and UI | Passed | Visual-fixture contracts, eight bot/shared packages, orchestration (592), Cursor (163), Electron (404), legacy desktop/Rust (39), and UI (4,994). Logs: `.cache/v2-validation/replan-test-*.log`; interrupted UI attempt retained, completed isolated UI run passed. |
| Web deterministic suite | 5,634 passed, 5 failed | `.cache/v2-validation/replan-test-web-isolated.log`: all five failures are in runtime agent overlays, with extra enclosing-repository/worktree permission grants. The temporary-directory Git ceiling did not isolate this path; diagnosis is recorded below. |
| Additional compatibility subset | 119 passed, 1 failed initially; benchmark passed in isolated web run | Five files covering runtime, snapshots, projection events, admission and facade. Initial timing gate failed at p99 56.584 microseconds versus 50. The same benchmark recorded p99 4.708 microseconds during the isolated web suite; preserve both measurements rather than relabel the initial failure. |
| Whitespace check | Failed | Five test files have an extra EOF blank line, recorded in `.cache/v2-validation/replan-diff-check.log`; left unchanged during product freeze. |
| Native integrated host, paid saved-graph QA, packaged native visuals, migration/rollback | Not run / unavailable | The integrated host and required qualification infrastructure are unfinished. Unit/build success cannot establish these lanes. |

All disposable test homes and temporary directories remain inside the repository. That constraint needs explicit environment isolation: Node fixtures must not inherit the repository's ES-module package scope, and non-Git fixtures must not discover the parent checkout. Initial failures under inherited scope are retained alongside corrected-environment reruns; neither correction changes product code or test assertions.

The remaining five web failures are a demonstrated fixture-context mismatch: `shared.js` (`findWorktreeRoot`) and `worktree-permissions.js` (`findGitMarker`) walk filesystem ancestors for `.git`, so a Git environment ceiling cannot isolate repository-contained fixtures. They find DevRyan and add its root plus the derived worktree permission path. The resolver reads this checkout's `.git/opencode` and computes the home worktree path; it does not access that external worktree. Resolve the fixture isolation before claiming a green web suite, while preserving intended runtime permission behavior. No assertion workaround was used.

The reviewers reproduced the decorator replacement, parent-identity, response-bound and idempotency counterexamples without live provider calls or installed-app data. No new product fixes were made during this audit. The plan incorporates those results; they remain implementation work. The final UI/web ownership audits recorded no remaining child processes or observation errors; the interrupted earlier validation sequence was also cleaned up using its owned process identities.

## Implementation evidence after resumption

Stage A now has the composition/path/epoch fixes, strict bounded client reads,
native-sequence execution ownership, durable prompt fingerprints, serialized
archive metadata, runtime capability invalidation, reconnect race fixes and QA
mirroring/comparison plumbing. The
[semantic-loss register](../../../../packages/web/server/lib/opencode/v2/codemap.md)
records remaining representation limits. Native TODO mutation and execution
remain unavailable until their later gates; no native-parity claim follows from
these adapter tests.

| Check | Current result | Evidence |
| --- | --- | --- |
| Runtime path, health identity and permission-overlay fixtures | 190 passed | `.cache/v2-validation/implement-a-root.log` |
| Lifecycle and managed authorization regression files | 140 passed | `.cache/v2-validation/implement-a-root-regressions.log` |
| Managed diagnostic path without Git discovery ceiling | 1 selected test passed | `.cache/v2-validation/implement-a-managed-path-isolated.log`; prior unsuccessful empty-marker attempt retained in `implement-a-managed-path-fixture.log` |
| Client bounds, ownership and host consumers | 254 passed | `.cache/v2-validation/client-final.log`; before final inbox-first assertion alignment |
| Admission identity and tool permissions | 95 passed | Worker focused run; combined gate remains required |
| UI capability/reconnect/config lifetime checks | 141 passed | `.cache/v2-validation/stage-a-ui-lifetime-final.log` |
| QA, resource inputs and qualified pairing | 126 passed | `.cache/v2-validation/stage-a-qa-resource-final.log` |
| Current-tree full validation | Passed | `.cache/v2-validation/implement-a-validate-full-retry.log`; web 5,730/450 files, all mandatory suites green |
| Production build and startup bundle budgets | Passed | `.cache/v2-validation/implement-a-build.log` and `implement-a-bundle-check.log` |
| Frozen source check | Passed | `.cache/v2-validation/implement-a-freeze-check.json`; all 268 captured paths unchanged through verification |

The first full implementation check stopped at three UI TypeScript errors; the errors were corrected without weakening assertions, and the complete retry passed. The failed attempt remains in `.cache/v2-validation/implement-a-validate-full.log`. The native host remains unqualified while stage B is implemented.

Stage B now has a composed Bun host, authenticated web admission bridge,
durable ledger holds, native writer workers, supervised read/shell routing and
transaction-scoped conversation Revert. The acceptance model uses OpenCode's
simulation transport; its tools, process receipts and ledger remain real.
This slice **passed all 43 native acceptance cases and full validation** on the
frozen checkpoint below. Native acceptance is qualified on Darwin arm64 with
the accepted supervisor and a simulated model. Production activation stays
closed pending packaging, migration and effective integration parity. Earlier
failed attempts remain recorded with their causes and subsequent evidence.

| Stage B check | Current result | Evidence and limit |
| --- | --- | --- |
| First native boot and session create | Failed closed on Git discovery | `.cache/v2-validation/stage-b-native-first.log`; no tool execution |
| Native prompt after discovery allowance | Failed closed on VCS branch helpers | `.cache/v2-validation/stage-b-native-helper-retry.log`; exact pinned queries subsequently routed through the supervisor |
| Prompt/runner integration | Earlier attempts failed; read/search now reached | `.cache/v2-validation/stage-b-native-vcs-retry.log`, `stage-b-native-page-retry.log`, `stage-b-native-lifecycle-retry.log`, `stage-b-native-claim-retry.log`; corrected acceptance pages, detached permits, SQLite callback reentry and decoded event schemas |
| Native authentication, read and grep | Passed in a failed writer run | `.cache/v2-validation/native-Nrmb3k/result.json`; direct read generation fence and real supervised grep receipt; cleanup has no remaining processes or observation errors |
| First native writer | Failed without publication | `.cache/v2-validation/stage-b-native-step-retry.log`; worker bootstrap logs contaminated its JSON protocol; real terminated/confined receipt and discarded lease, original file preserved |
| Current-source diagnostic retry | Failed before tool execution | `.cache/v2-validation/native-d78Jql/result.json`; private admission bridge connection reset after startup-hold check; controller remained alive and owned cleanup was clear |
| Private bridge transport | Reproduced and corrected | `.cache/v2-validation/stage-b-private-transport-diagnostic.log`; original connection reuse reset once in 100 calls; explicit request connection closure delivered 100/100 without retrying calls |
| Quiet writer and protected reads | Diagnostic failed at writer registration | `.cache/v2-validation/native-reWZqF/result.json`; read/grep/glob reached exact protected-root refusals, but writer negatives were registry failures and do not prove their path guards; all owned processes settled |
| Actual native write and edit | Passed within an incomplete diagnostic run | `.cache/v2-validation/native-w4XBpF/result.json`; exact file contents, permissions and real confined termination before publication. Patch timed out because its fixture model excluded it from the native catalog; the later run below resolves that cause and places permit revocation after cleanup. Native drain failed; OS ancestry cleanup was empty. Concurrent source edits invalidate this as a final cohort |
| Native writers, byte edges, publication and shells | 28 cases passed within an incomplete diagnostic run | `.cache/v2-validation/native-QF5iNG/result.json`; native model-specific writer inventory corrected, then all transform/removal cases, six protected boundaries, eight concurrent writers, formatter/BOM/CRLF, foreign edits, interrupted publication, same-file conflict and both shell modes passed. Permission-deny fixture incorrectly required a tool that native filtering removes. Timestamps establish permit revocation followed cleanup. Source edits invalidate the final cohort; OS cleanup was clear |
| Integrated selection and adversarial retry | Failed before the first tool; root cause corrected | `.cache/v2-validation/native-oMMNhK/result.json`; authentication and startup isolation passed, then model verification incorrectly required an already stored default agent. The actual new-session database had no agent; independent canonical model verification now preserves that native behavior. Source cohort unchanged; all owned processes settled. Remaining new lanes did not run |
| Expired prompt replay | Correct refusal code, incorrect HTTP status | `.cache/v2-validation/native-ix02rM/result.json`; native read passed, then replay was denied as `native_permit_invalid`. The private bridge only recognizes `statusCode`, while the new owner supplied `status`; this changed the expected 403 to 409. Explicit status aliases now follow the existing bridge contract. Owned cleanup was clear |
| Native adversarial and tracked-primary run | 31 cases passed; primary handshake failed before its tool | `.cache/v2-validation/native-eGDvbV/result.json`; exact expired-permit 403/no effects, Code Mode exclusion, supervised glob, all previous writer/publication cases and both shell modes passed. The first tracked-primary step returned `recovery_runtime_unverified`; its continuation, permission, cancellation, restart and child/Revert lanes remain required. Owned cleanup was clear |
| Tracked primary, permissions and transform cancellation | 38 cases passed; escaped-descendant fixture did not start | `.cache/v2-validation/native-uGoyX7/result.json`; tracked native shell continuation retained its original objective and saved selection with a durable assistant acknowledgement. Permission deny/ask reject/ask correction, cancellation during write/edit transforms and held-session deletion refusal passed. The fixture's Bun detached spawn failed with ENOSYS under the existing confinement policy; the corrected fixture uses Node's supported fork/exec fallback. Pending/crash recovery and child/Revert lanes were not reached. Source cohort unchanged; owned cleanup was clear |
| Detached-child cancellation and durable crash hold | 41 cases passed; pending-background assertion failed | `.cache/v2-validation/native-jXUHE3/result.json`; Node's detached-spawn attempt produced a live child that stopped after verified cancellation, and controller replacement preserved its durable hold before a fresh write. The pending-background fixture incorrectly expected `continuedID` before any assistant step; the ledger now records both consumption IDs at the actual step. Pending-background recovery and child/Revert remain required. Source cohort unchanged; owned cleanup was clear |
| Pending-background crash window | 41 cases passed; replacement wake failed closed | `.cache/v2-validation/native-gc4U55/result.json`; the exact native job marker was removed while its notice and ledger intent remained unconsumed. After the second owned controller crash, recovery reached `native_session_binding_required`: invalidation cleared the cached canonical binding, but the recovery path woke the native runner before rebinding it. No duplicate execution or assistant was observed. Source cohort unchanged; owned cleanup was clear. Recovery correction and child/Revert acceptance remain required |
| Rebound pending-background recovery | 41 cases passed; replacement produced no assistant | `.cache/v2-validation/native-fGZv99/result.json`; canonical rebinding removed the earlier refusal. Native state had an already promoted notice and an empty inbox; the pinned runner's non-forcing wake therefore completed idle without inference. Recovery needs an exact owned resume for that unconsumed notice; the broad startup resume path remains closed. Source cohort unchanged; owned cleanup was clear. Pending recovery and child/Revert are not qualified |
| Managed-child diagnostic | 41 cases passed; child start refused by the adapter capability gate | `.cache/v2-validation/native-CW9MJ4/result.json`; the real managed task reached `execution_bridge` capability refusal despite the fixture's composed native owner. Parent continuation and Revert/Redo were not reached. Source cohort unchanged; OS cleanup was clear, but native drain retained the failed simulation-driver assertion. The native bridge must be exposed only through its verified composition; a blanket generation-two capability change is insufficient |
| Native child allocation and deferred registration | 41 cases passed; child registration failed | `.cache/v2-validation/native-tLqZ9I/result.json`; the native child existed with its correct parent, but the scheduler had not attached it. Registration restored the expired submitting tool's async context; private header construction failed locally and was wrapped as `mutation_runtime_unavailable`. No projection defect was demonstrated. Source cohort unchanged and OS cleanup was clear; failed simulation drain was retained |
| Deferred native transport context | 94 web tests passed; native typecheck passed | `.cache/v2-validation/implement-b-native-task-context-web.log`, `implement-b-native-task-context-types.log`; construction-time native transport context covers registration and subsequent observations. An actual async-context regression proves revoked caller context is removed while create/prompt still install fresh task authority. Native child/Revert and crash-window recovery remain required |
| Frozen CLI native acceptance | Failed after child completion and committed tree Revert | `.cache/v2-validation/native-uJsFaM/result.json`; 41 earlier cases passed, then the real child wrote, its task completed and its parent finished. Revert removed the child's file and committed; Redo restored native conversation markers and files but failed while releasing the deferred `execution.wake` because its owned callback was missing. The ledger committed its decision, so recovery must complete forward. Source/artifact cohort unchanged; owned OS cleanup was clear |
| Native cancellation and tree Redo retry | 42 cases passed; pending-background crash point not reached | `.cache/v2-validation/native-ASuK9i/result.json`; canonical interrupted-idle/claim release passed before subsequent input. Managed child completion and tree Revert/Redo passed with unchanged message identities, no repeated inference, no duplicate task and no retained wake. The final background case timed out before its pre-chunk model boundary. The native logs and pinned service flow identified a lock cycle: serialized inbox admission awaited the committed host observer, which called back into the same inbox lock. Earlier background cases advanced after the 30-second RPC timeout. Move the committed observer after lock release; keep the fixture deadline unchanged. Source/artifact cohort unchanged; owned OS cleanup had no survivors, signals or observation errors. Restart recovery remains unqualified |
| Native interruption bookkeeping | Actual cancellation gap found; 7 gate tests passed after correction | Retained `native-tLqZ9I/native-controller-1.log` and its database show that refusing `Job.cancel(sessionID)` when no such job exists blocked `Execution.Interrupted` and claim release. `.cache/v2-validation/native-job-noop-gate-test.log` (56 assertions), `native-job-noop-gate-typecheck.log`: missing jobs now retain native's no-op; real job cancellation remains guarded. Canonical interrupted-idle/claim release must pass before a subsequent prompt in the next native run |
| Deferred Redo wake | 31 focused tests passed, 218 assertions; web/native typechecks passed | `.cache/v2-validation/native-deferred-wake-test.log`, `native-deferred-wake-typecheck.log`; private normal wake returns idle only after native inbox/activity inspection, or registered after independent runner admission. The durable acknowledgement compares the current ledger revision. It does not force completed history to resume. Actual tree Redo remains required |
| Deferred wake ownership and retry | 36 focused tests passed, 195 assertions | `.cache/v2-validation/implement-b-deferred-wake-owner.log`; exact hold/release interleaving between native proof and acknowledgement retains the intent and rejects the stale revision. Malformed results, broader operation reuse, stale permits and controller replacement fail closed; canonical lineage, concurrent release and retry use the existing owner |
| Native inbox callback lock ordering | 9 tests passed, 83 assertions; web/native typechecks passed | `.cache/v2-validation/native-inbox-lock-test.log`, `native-inbox-lock-typecheck.log`; the actual native Inbox/Bus/database graph allows the committed observer to reacquire the inbox lock independently, and observer refusal still propagates. Preflight and native admission stay serialized. Full native retry remains required; the fixture deadline is unchanged |
| Native integrated path after lock correction | All 43 cases passed on frozen source | `.cache/v2-validation/native-iCeljY/result.json`; real tools, supervision, publication, canonical cancellation settlement, managed child/parent, exact tree Revert/Redo and pending-background crash/recovery passed. No remaining runner gates, source changes or owned OS survivors/observation errors. Expected adversarial refusals remain recorded. A separately reviewed queued-ACK/controller-rotation race still requires an enforced commit barrier and final-source verification before stage B is complete |
| Continuation commit and controller rotation | 40 tests passed, 211 assertions; final 17-test rerun passed, 64 assertions; native typecheck passed | `.cache/v2-validation/implement-b-continuation-ack-barrier.log`, `implement-b-continuation-ack-barrier-final.log`, `implement-b-continuation-ack-barrier-types.log`; new calls/ACKs close synchronously, admitted ACKs fully settle before epoch rotation, and disposal refuses a pending ACK/barrier. Failed ACKs reach their original callers. Replacement and cleanup await the barrier after verified process settlement; final native verification remains required |
| Private native managed control and lineage | 42 focused tests passed; native typecheck passed | `.cache/v2-validation/implement-b-managed-control.log`, `implement-b-managed-control-types.log`; constructor-only control and child registration require composed native ownership, actual invocation and durable parent lineage. Public generation-two plugin capability remains closed. Native child acceptance is still required |
| Deferred managed dispatch ownership | 93 web, 168 executor and 30 scheduler tests passed; native typecheck passed | `.cache/v2-validation/implement-b-native-task-dispatch-web.log`, `implement-b-native-task-dispatch-shared.log`, `implement-b-native-task-dispatch-scheduler.log`, `implement-b-native-task-dispatch-types.log`; task/lease travels through every create/prompt path, private verification rereads persistence ownership and the scheduler's cancellation fence, and checks the exact child/selection. Tests hold cancellation before terminal status and require 403. Actual native dispatch remains required |
| Native deferred task admission | 22 tests passed, 145 assertions; web/native typechecks passed | `.cache/v2-validation/native-managed-dispatch-test.log`, `native-managed-dispatch-typecheck.log`; fresh private dispatch scope compares the current task lease and durable parent control generation, strips inherited tool authority and binds selection/prompt/inbox rechecks. Stale lease, Stop, Revert generation and controller replacement refuse execution. Integrated native acceptance remains required |
| Promoted shell notice recovery | 23 focused tests passed, 154 assertions; final observer guards 6 passed, 46 assertions; typecheck passed | `.cache/v2-validation/native-promoted-resume-test.log`, `native-promoted-resume-gate-final-test.log`, `native-promoted-resume-typecheck.log`; exact promoted notice resumes in the owned scope after final inbox/active-runner checks and transfers only at independently admitted runner drain. Native crash-window recovery remains required |
| Private native version handshake | 21 host and 71 client tests passed; native/web type checks passed | `.cache/v2-validation/implement-b-native-hello-host.log`, `native-runtime-info-test.log`, `native-runtime-info-typecheck.log`; direct native handshake requires the bounded, generation-fenced `/api/info` response at exactly 2.0.20. Public plugin readiness and recovery eligibility remain separate. Integrated tracked continuation remains required |
| Private refusal status propagation | 22 hold/gate and 33 execution-host tests passed | `.cache/v2-validation/native-status-focused.log`, `native-execution-status-test.log`; actual private HTTP preserves invalid-permit 403, durable-hold 409 and stopped-runtime 503 |
| Native configuration and controller boundaries | 5 passed | `.cache/v2-validation/implement-b-bootstrap-closed-config.log`; raw config resource/MCP discovery refused |
| Host child route and typed native boundary | 6 passed; native typecheck passed | `.cache/v2-validation/implement-b-child-route.log`, `implement-b-child-route-types.log`; bounded schema and exact parent permit; managed child acceptance still required |
| Managed task authority and primary step handoff | 4 passed | `.cache/v2-validation/implement-b-primary-owner.log`; native end-to-end child continuation remains required |
| Primary owned background continuation | 155 focused tests passed | `.cache/v2-validation/implement-b-primary-owned-tests.log` (150), `implement-b-primary-continuation.log` (5); receipt-backed objective chains, saved selection, cancellation/hold fences and private adoption. Actual tracked native continuation remains required; wake registration alone does not prove Inbox consumption |
| Durable shell consumption and controller replacement | 21 focused tests passed, 134 assertions; native/web type checks passed | `.cache/v2-validation/native-generation-focused.log`, `native-generation-typecheck.log`; receipt-bound continuation remains durable until native consumption, startup reads canonical message sequence, and replacement invalidates old/in-flight permits. Actual crash recovery remains required |
| Replacement recovery canonical binding | 23 focused tests passed, 150 assertions; native/web type checks passed | `.cache/v2-validation/native-recovery-binding-test.log`, `native-recovery-binding-typecheck.log`; retained continuation recovery reacquires exact parent lineage before wake, including after same-owner invalidation. The SQLite claim callback remains cache-only. Integrated recovery still requires its native retry |
| Effective saved execution selection | 105 admission tests and 154 shared primary tests passed; native typecheck passed | `.cache/v2-validation/effective-selection-native-new-session.log`, `effective-selection-shared.log`, `effective-selection-types.log`; inherited effort, explicit default replay, uncertainty and unmanaged opt-out. Actual tracked native continuation remains required |
| Conversation-only native adapter | 8 passed | `.cache/v2-validation/implement-b-revert-web.log`; actual native Revert/Redo still required |
| Script test ownership | 32 passed | `.cache/v2-validation/implement-b-test-discovery.log`; Bun native tests join the existing central script suite |
| Final native integrated path and epoch barrier | All 43 cases passed | `.cache/v2-validation/native-iQNj2D/result.json` and `stage-b-native-frozen-cohort-epoch-final.log`; no remaining mandatory gates, source changes, cleanup failures, owned OS survivors or observation errors. Five expected adversarial RPC refusals remain recorded. Includes canonical cancellation settlement, managed completion, exact tree Revert/Redo and pending-background crash/recovery |
| Full validation, first attempt | Failed in script runner classification | `.cache/v2-validation/implement-b-validate-full.log`; the Bun partition mistook generated fixture text inside a Node test for a Bun test declaration. The classifier now gives the file's actual Node declaration precedence; the unchanged nested real-Node and mock-isolation checks passed in `stage-b-script-runner-classification-retry.log` |
| Full validation, first retry | 5,775 web tests passed; one stale expected value failed | `.cache/v2-validation/implement-b-validate-full-retry.log`; settled captured-session state now includes its authoritative generation. The test's exact expectation now includes `generation: 0`; missing-ledger, HTTP refusal and unchanged-file assertions remain intact. The eight-test file passed in `stage-b-revert-state-contract-focused.log` |
| Final current-tree full validation | Passed | `.cache/v2-validation/implement-b-validate-full-retry2.log`; all mandatory suites green, including 5,776 web tests across 453 files |
| Production application build and startup bundle budgets | Passed | `.cache/v2-validation/implement-b-build.log` and `implement-b-bundle-check.log`; these build the application, not the still-unbuilt native controller/worker artifacts. Subsequent changes affected test dispatch and one expected test value only |
| Final frozen source and whitespace checks | Passed | `.cache/v2-validation/implement-b-freeze-check.json`; all 349 captured paths unchanged through the successful full run. `implement-b-final-diff-check.log` is clear |

Native `SessionEvent.Step.Started` supplies the durable assistant identity before
tool dispatch. The host passes that event synchronously to the existing primary
owner and verifies its native sequence and objective; display parent inference
does not grant managed task authority. The native subagent executor remains
structurally absent, so the existing scheduler and task wait own child result
collection. Native generic shutdown holds remain durable until explicit bundle
recovery can establish safe release. Raw recursive removal and native startup
claim sweeps currently refuse admission pending the owned lifecycle path; a
policy callback cannot override those refusals.

Managed primary admission now records the effective native selection after
selection succeeds and before prompt dispatch. The original request still
defines retry identity; inherited effort and native default are frozen for
continuation. A failed dispatch acknowledgement leaves explicit uncertainty.
Controller replacement must prove old-process exit and complete supervisor
settlement before invalidating transient permits; durable holds survive it.

The managed diagnostic failure came from Git discovering the enclosing checkout
and deriving its root commit instead of the fixture's managed project ID. An
empty initialized repository now bounds discovery and retains the original path
assertions. The readiness reason variation came from the final loopback request
racing its remaining deadline: reason-propagation tests now inject the probe at
a single attempt, while the separate readiness suite retains real HTTP 503
coverage. The earlier failed attempts remain recorded above.

Stage C passed its current Darwin arm64 gates. The selected bundle binds the runtime,
configuration, database and existing harness stores before their owners start.
Selection pins the prepared manifest; every launch verifies the frozen selection
and artifacts again. Copy preparation uses a quiesced source checkpoint and an
offline compiled importer. An uncertain rollback retains the candidate and
keeps admission closed until reconciliation succeeds.

| Stage C check | Current result | Evidence and limit |
| --- | --- | --- |
| Compiled controller and writer | Built for darwin-arm64 | `.cache/v2-validation/native-artifact-candidate-4/native-bundle.json`; includes the SDK registration-location correction, pinned OpenCode 2.0.20 and Bun 1.3.14, signed development outputs and byte-preserved accepted launcher. This is not release-signing evidence |
| Compiled assets and full server without source access | Passed | `.cache/v2-validation/package-D7mjEC/result.json`; Bash/PowerShell parsers, Photon, extracted PTY and FFI load; real positive/negative read control; controller boots under the accepted supervisor while reads of `packages`, `scripts` and `node_modules` are denied |
| Compiled copy migration | Passed in diagnostic cohort | The same report independently checks session/tool identities, folded compaction summaries, attachments, ordered permissions, relocated project refs and unchanged sources; pending Revert, remembered deny rules and unknown markers are refused without importing |
| Ordinary HTTP read/write/edit/patch | Passed in diagnostic cohort | `.cache/v2-validation/package-X6KjvP/result.json`; real HTTP provider requests and compiled native tools, with real termination receipts preceding durable publication. The earlier `D7mjEC` session-create failure was a missing production authorization wrapper in the package verifier; no product grant was loosened |
| Formatter, location isolation and pending-work replacement | Passed in 19-case intermediate cohort | `.cache/v2-validation/package-dUZPkx/result.json`; actual formatter subprocess, separate location roots, fresh controller identity and write capacity, one consumed background continuation retaining its original objective and saved tuple. Source cohort was valid and cleanup had no failures |
| Generation-specific bundle artifacts | 14 focused tests passed | `.cache/v2-validation/stage-c-generation-artifacts-tests.log`; generation one requires the accepted companion contract and exact binary paths; generation two requires the native manifest, controller and writer. Prepare, resume, selection and rollback use the same strict verifier |
| Command preselection and configured-command derivation | Focused and packaged smoke passed | `.cache/v2-validation/stage-c-command-selection-client-isolated.log` (106), `stage-c-command-owner-tests.log` (27), `stage-c-command-gate-tests.log` (12), and `stage-c-command-selection-tests.log` (1). `.cache/v2-validation/package-IATzzJ/result.json` proves one real compiled command inference and one native manual compaction |
| Interrupted import and selected v1 rollback | Passed in 24-case intermediate cohort | `.cache/v2-validation/package-IATzzJ/result.json`; lost acknowledgement resumes the prepared import, the live candidate is quiesced and retained whole, independent synthetic project roots reconcile, and the accepted v1 companion reads all six baseline sessions before verified process exit |
| Managed caller reauthorization | 66-test file passed | `.cache/v2-validation/stage-c-current-managed-grants.log`; original caller, exact project, session ownership, archived sessions, missing/expired/revoked app sessions and changed grants. Disposable local identity fixtures only |
| Original local and tunnel grants | 121 focused tests passed | `.cache/v2-validation/stage-c-native-auth-grants-tests.log`; actual original principal binding, expiry, logout/reset, tunnel revocation, mode changes and disposal. Configured Off retains local administrator access to canonical prior sessions; copied principals cannot create grants |
| Complete packaged lifecycle diagnostic | 26 checks passed; qualification withdrawn | `.cache/v2-validation/package-ZkjzTL/result.json`; linked build inputs and source cohort match, cleanup is clear, and all seven observed parent-death descendants stopped. Independent review subsequently found revocation during awaited authorization reads; this run remains diagnostic until the corrected source passes |
| Authorization after awaited canonical reads | 28 owner tests passed, 188 assertions | `.cache/v2-validation/stage-c-auth-revocation-owner-tests.log`; both initial authorization and permit recheck refuse a grant revoked while canonical reads are suspended. The original grant is checked again after canonical/ledger and Revert validation; the native typecheck passed |
| Managed login validity at grant return | 70 tests passed | `.cache/v2-validation/stage-c-managed-native-auth-race-tests.log`; deferred grant reads cover revoke and expiry during both owned-session and create authorization. Exact original login, user, revocation and current expiry are checked after all dependent reads |
| Packaged lifecycle after authorization correction | 26 checks passed | `.cache/v2-validation/package-MyVwve/result.json`; unchanged source cohort, all current linked build inputs verified, no cleanup failures, and real controller/worker receipts after parent death. This checkpoint precedes the SDK registration correction below |
| Native permission fixture correction | Actual permission flow passed | Earlier runs `native-BUMzRS`, `native-2qdllY` and `native-TBFCEO` exposed missing fixture web/selection scopes. The bounded `native-MIDECM` probe exercised a real pending permission, rejection, terminated writer and discarded output after correcting those scopes; product authorization was preserved |
| Native boundary after permission correction | 41 cases passed; managed registration failed | `.cache/v2-validation/native-pWpOv1/result.json`; permission correction, cancellation, shells and crash recovery passed. The native SDK strips its service context before loading SDK plugins, so the tool gate captured no registration location for `devryan_task`. Managed dispatch never reached the scheduler. Cleanup retained the simulation failure; OS observation found no surviving processes |
| SDK registration location ownership | 2 tests passed, 11 assertions; native typecheck passed | `.cache/v2-validation/stage-c-sdk-registration-tests.log` and `stage-c-sdk-registration-types.log`; actual SDK registration and tool snapshots preserve each of two distinct native locations and reviewed managed origins. Unreviewed registrations and absent permission authority fail closed. The wrapper binds the location already supplied by the native plugin host; execution input cannot supply it |
| Compiled lifecycle after SDK registration correction | 26 checks passed on frozen source | `.cache/v2-validation/package-zRX8ft/result.json`; candidate 4, all linked build inputs current, source cohort unchanged and cleanup clear. Eight independently observed parent-death descendants stopped; controller and worker have real confined termination receipts |
| Native boundary after SDK registration correction | All 43 checks passed on frozen source | `.cache/v2-validation/native-M2MPLM/result.json`; managed child/parent completion, permission correction, Revert/Redo and pending-background crash recovery passed. Both replaced controllers and final cleanup have no surviving observed processes or observation errors. Raw uncontrolled deletion remains an expected refusal, not deletion parity |
| First stage C full validation | Failed in five web test fixtures | `.cache/v2-validation/implement-c-validate-full.log`; earlier mandatory packages passed, web recorded 5,794 passing tests, two failed tests and four suite-load failures. Auth/config mocks lacked the selected data/config-root exports. Fixture corrections preserve assertions and require verification; this command is not a full-validation pass |
| Selected-root mock corrections | 84 focused tests and the complete web suite passed | `.cache/v2-validation/stage-c-provider-route-fixture-tests.log` (69), `stage-c-quota-root-mocks-tests.log` (15), and `implement-c-web-fixture-retry.log` (5,811 tests across 458 files); only missing mock exports were added, with repository-owned fake roots and unchanged assertions. The 445-path cohort stayed unchanged (`implement-c-fixture-web-freeze-check.json`). Final full validation remains required after the deletion work |
| Production application build and startup bundle budgets | Passed | `.cache/v2-validation/implement-c-build.log` and `implement-c-bundle-check.log`; package/native qualification above supplies the separate compiled runtime evidence |
| Web and native host type checks | Passed | `.cache/v2-validation/stage-c-root-types-latest.log`; the first full-validation run also passed type checks before the web fixture failures above |
| Compiled owned subtree deletion | 27 package checks passed | `.cache/v2-validation/package-JkOTL6/result.json`; candidate 5 invokes the actual public client and production removal owner, verifies native row disposal and durable exact membership, and retains published files. Source cohort unchanged and cleanup clear |
| Expanded native removal fixture, first two attempts | 43 preceding checks passed in each; removal fixture failed before execution | `.cache/v2-validation/native-xCps7S/result.json` and `native-Dmxgyq/result.json`; the fixture reused child/primary lineage already fenced by the preceding Revert/Redo. The durable product refusals remain intact. An additional fresh managed lifecycle now supplies the removal target; original Revert/Redo coverage remains required |
| Compiled deletion lost acknowledgement and startup | Failed at bundle integrity verification | `.cache/v2-validation/package-wY9L3C/result.json`; real leaf deletion committed before a deliberately lost acknowledgement, then restart incorrectly treated intentionally removed session references as corruption. Earlier ordinary deletion passed; cleanup was clear. The original failure remains retained |
| Durable deletion reference verification | 26 focused tests passed; retained failed bundle verifies read-only | `.cache/v2-validation/stage-c-removal-bundle-tests.log` and `stage-c-removal-retained-bundle.log`; only exact committed/staged leaf absence or acknowledged tombstones are accepted. Wrong holds, generations, unrelated references and an absent parent with a live child remain rejected. Integrated startup retry remains required |
| Compiled owned deletion and startup recovery | All 28 checks passed | `.cache/v2-validation/package-nIKIrD/result.json`; candidate 5, actual public deletion and lost real leaf acknowledgement followed by supervised controller exit and automatic startup recovery. Linked inputs and source cohort unchanged, cleanup clear; seven observed parent-death descendants stopped with real controller/worker receipts |
| Fresh managed removal fixture | 43 preceding checks passed; competing request assertion failed | `.cache/v2-validation/native-ZJ5cQl/result.json`; the fresh managed child reached a real private writer, formatter and queued input. The competing create inherited the outer deletion's private async scope. It now starts from an independent scope; the original held-parent refusal assertion is unchanged. Source stayed frozen and all owned processes settled |
| Final native subtree removal and recovery | All 47 checks passed | `.cache/v2-validation/native-Xj2K8P/result.json`; fresh managed lineage, actual private writer and formatter, independently scoped racing child admission, exact durable tree/input disposition and lost real delete acknowledgement followed by supervised restart. Source stayed unchanged; no remaining mandatory gates, owned process survivors or observation errors |
| Final compiled subtree removal and recovery | All 28 checks passed | `.cache/v2-validation/package-k84goE/result.json`; candidate 5, all 2,885 linked build inputs verified, public deletion and automatic startup recovery before web readiness. Source cohort unchanged and cleanup clear; seven observed parent-death descendants stopped with real controller/worker receipts |
| Full validation after deletion, first attempt | Failed at the deterministic no-skip contract | `.cache/v2-validation/implement-c-removal-validate-full.log`; the removal oracle used a Darwin-only SQLite CLI test. It now reuses the existing portable SQLite driver with real read-only database, scope/injection and disposal assertions. Node and Bun each passed all five tests; the no-skip contract passed in `implement-c-removal-no-skip-contract.log` |
| Full validation after portable oracle correction | Failed in two web test setups | `.cache/v2-validation/implement-c-removal-validate-full-retry.log`; prior mandatory packages passed, web recorded 5,848 passing tests, one failed test and one suite-load failure. The admission wire fixture lacked the required owned deletion delegates; an MCP Bun test was discovered by Vitest. Product enforcement remains unchanged; both test setups are corrected and a final full run remains required |
| Native test runner ownership correction | 3 MCP tests and 6 discovery contracts passed | `.cache/v2-validation/implement-d-mcp-test-move-bun.log` and `implement-d-mcp-test-move-discovery.log`; moved the MCP test into the existing Bun native suite, preserving all 12 assertions and zero skips |
| Application build and startup budgets after owned deletion | Passed | `.cache/v2-validation/implement-c-removal-build.log` and `implement-c-removal-bundle-check.log`; subsequent changes affect test oracles, fixture wiring and documentation only |
| Owned deletion fixture correction | 136 admission/client checks passed | `.cache/v2-validation/stage-c-owned-removal-admission-fixture.log`; the wire fixture supplies explicit constructor delegates and asserts the exact removal scope. Public refusal without an owner and partial-failure/runtime-replacement tests remain intact |
| Final Stage C full validation | Passed | `.cache/v2-validation/implement-c-removal-validate-full-retry2.log`; all mandatory suites green, including 5,849 web tests across 463 files |
| Final frozen source and whitespace checks | Passed | `.cache/v2-validation/implement-c-removal-final-freeze-check.json`; all 473 captured paths unchanged, with no new paths during the successful full run. `implement-c-removal-final-diff-check.log` is clear |

The compiled package and native boundary checkpoints above passed. Owned
stable-subtree deletion is now implemented, with durable membership and input
dispositions in the existing ledger, scheduler fencing, real execution
settlement, and startup recovery before web readiness. Its expanded native and
compiled acceptance runs and final full validation passed. The rollback evidence uses independent synthetic
workspaces; shared-workspace ownership reconciliation remains a later acceptance
requirement. Raw recursive session removal remains refused; the public client
delegates to the qualified owned subtree lifecycle. The effective personal integrations and saved provider
graph remain Stage D work.

## Critical path and gates

Use the sequence below. Each stage produces reviewable code and its evidence; do not carry a failed mandatory gate forward as a completed phase. Parallel work is appropriate only after the shared contracts it depends on are fixed.

### A. Close the current adapter changes

Finish the interrupted Phase 2 work before adding another layer:

1. Complete server composition: inject the generation client into recovery and session-change hosts; supply authoritative runtime paths; fence same-URL process/data replacements; prove readiness survives launch assignment ordering. Verify local first-launch directory resolution and managed directory/ownership behavior.
2. Finish the response-reading contract: cancellation, deadlines, per-response and aggregate byte limits, error bodies, metrics cleanup, empty responses, parallel reads and opaque pagination. A budget violation cannot be swallowed as a successful snapshot.
3. Replace inferred message-parent authority in execution admission, receipt registration and plan checks with exact native sequence/host-attested ownership. Prove stale REST results cannot overwrite newer live session/message/activity state, including overlapping reseeds, deletion/recreation, duplicate busy starts, reconnect and runtime replacement. Follow continuation for session pages and short/empty projected message pages; native raw message pagination still follows the pinned endpoint's own contract. Malformed/repeated cursors fail explicitly. Invalidate UI capabilities with runtime identity.
4. Bind warm-cache dedup and native-conflict recovery to the same durable accepted-operation identity. Include attachments, segments, agent/model/effort, delivery, tool restrictions, objective, origin and resume behavior. Validate identity before changing selection or permissions; matching text alone cannot reconcile a conflict. Enforce requested tool restrictions in native admission, including direct and in-process paths.
5. Preserve managed ownership commit/rollback, archive/delete auditing, revocation and provisional-session hiding through the same client. Serialize archive, TODO and prompt metadata changes through one owner or equivalent atomic updates; the current read/whole-metadata-patch sequence can overwrite concurrent changes. Test local and managed routes together, including Cursor interception and native errors without replaying mutations.
6. Finish both-generation fixture selection throughout ordinary QA, settings, resource benchmarks and the feature matrix. Plumb personal-setup mirroring through the actual matrix schema/runner, not only a profile helper, and validate the resource-launch environment allowlist. Complete the semantic-loss register and codemaps. Keep intentional v1 compatibility behavior explicit.
7. Run full validation, build and bundle checks on the assembled tree. Resolve the permission-overlay fixture isolation and diagnose the earlier integration-result variation at their actual causes; do not relax assertions or change intended runtime permissions to obtain green output.

**Exit:** the adapter branch passes current-tree deterministic/build checks; unfinished surfaces are explicitly closed or unavailable; no claim of production-native parity yet. Native activation remains closed until B–D pass. Resolve these application-facing contract defects before building on them, rather than accepting temporary ambiguity in execution authority.

### B. Prove one integrated native execution path

This is the next architectural gate, ahead of bulk plugin porting or optimization. Build a small product slice under `packages/web/server/lib/opencode/runtime-host/` and a repeatable acceptance command using disposable projects.

Required process path: **native prompt → admitted tool → existing private execution view → native supervisor → verified termination → durable ledger publication → native result → managed child completion → parent continuation → conversation Revert/Redo**. Exercise write/edit/patch, supervised grep/glob, foreground shell and background shell. Reviewed native direct file reads use the existing direct-admission/result fence and real read output; they start no process and must not fabricate a termination receipt.

Resolve these proof obligations in the slice:

- Compose the security gate and execution-view routing in **one** `Tool.node` replacement. LayerNode replacements with the same source are last-wins: concatenating the separate G1 and G2 overrides silently removes one. Include a regression that attempts exactly that bypass.
- Use native write/edit/patch implementations in a private worker under the existing launcher and lease. Begin with the smallest runnable native SDK/service graph that preserves permissions and formatter behavior. Choose a reduced graph only after measuring the integrated implementation. Give the worker private HOME/XDG/config/database inputs and a closed plugin set; controller hooks run once. Bind native `Location`/`Environment.files` to the lease view. Pinned 2.0.20 rereads current bytes for edit/patch and has no per-session FileTime/read-before-write stamps; full-file write permits overwrite. Do not add controller stamp transfer or synthetic preliminary reads, and do not promise stale-read rejection when the old text still matches. The existing ledger owns foreign-change detection and publication. Neither a fake control lease nor a fabricated termination receipt is acceptable.
- Shells run in the lease's view, never the live project. Bind the final command, cwd and environment to a private invocation identity after hooks. Preserve native shell-job behavior with the host retaining the process lease. Background return transfers ownership; it does not finish the lease. Cancellation, removal and shutdown must settle descendants before the native job/result is considered complete.
- Quiesce in the order **persist hold → interrupt → await settlement → assert no active runner**, with the runner admission gate preventing re-entry. A bounded retry loop that exhausts its budget must fail closed. Release/resume only after the durable operation commits or recovers.
- Install durable session holds and mandatory gates before native startup recovery can resume anything. Prepare the private host bridge before launching Bun; retain it through drain and finish during shutdown.
- Cover the whole native session interface explicitly: selection/metadata/permission updates, prompt, command, skill, compact/generate, shell/environment, inbox, fork/move/remove, Revert, wake/resume and completion. Remove Code Mode structurally from the available executor graph. Child-completion authority comes from an internal token and durable ownership, not metadata supplied by a caller.
- Disable uncontrolled config/plugin/instruction discovery and provide the reviewed effective inputs explicitly. Enforce allowed roots, an environment allowlist and protected metadata paths. Include formatters, command interpolation, MCP subprocesses, Git hooks/filters and provider/helper processes in the effect inventory. A capability facade does not sandbox arbitrary JavaScript imports: the controller loads only explicitly trusted, pinned plugins. Identify direct-read executors by reviewed origin/implementation, never only by tool name.

Writer acceptance must include fresh-worker edits without a previous read; sequential fresh workers seeing earlier commits; missing/ambiguous old text failing without publication; repeated patch hunks with BOM/CRLF and formatter output; controller read followed by a foreign change; and concurrent same-file workers. Native process-local file locks do not arbitrate across workers; the ledger must.

**Exit:** adversarial native acceptance with real receipts, failed transforms/removal, stale snapshots, eight concurrent calls, denied permissions, cancel during writes, escaped descendants, interrupted publication, restart and Revert. Successful isolated spikes do not satisfy this gate.

### C. Complete native lifecycle, data and packaging

With B's contracts fixed:

1. Pin required native SDK/core/plugin packages and integrity; add a dedicated typecheck for host code and all decorated interfaces. Produce the real Bun host/worker artifact, including required assets. Preserve branded release artifacts and existing signing/acceptance verification. The current captured-execution acceptance target is darwin-arm64; do not claim Linux/Windows confinement or widen supported targets without their native proof. Keep any existing external/degraded mode explicit and separate from captured acceptance.
2. Wire lifecycle, private authentication, ready/catalog assertions, reload invalidation, signals and disposal. `runtime-selection.js` currently records an observed launch; it is not the persistent atomic activation selector. Keep those roles distinct.
3. Adapt conversation-only Revert (`files:false`, `snapshots:false`) around existing ledger transactions. Keep optional event-payload history disabled (`events.persist:false`), recover from native projections plus durable DevRyan ownership, and disable v1 database pruning before any v2 launch. Stored-log following cannot replace live streaming while payload persistence is off. Fence prompt/compact auto-commit, stable-subtree deletion, child completion and pending inbox disposition. Supply durable objective/turn/call correlation; projected `parentID` must not authorize execution admission, receipt registration or plan operations.
4. Build copy-only migration prepare/verify/activate/rollback using an explicit absolute SDK database path under Bun. Quiesce the source and create a consistent SQLite backup together with matching ledger, evidence, tasks and continuation state as one coherent bundle; independently copying a live database and WAL is insufficient. Preserve the migration marker; reject unknown/corrupt state; control auxiliary sources such as the importer's opencode-next database and legacy credential import. Resolve staged Revert before import and reconcile IDs/references and effective session permissions, not only counts.
5. Rehearse on synthetic relocated projects with compaction summaries, attachments, children, staged Revert, queued work and interrupted import. A migrated copy must never boot plugins or tools against original project paths.

**Exit:** deterministic and native lifecycle/data checks plus packaged smoke evidence. No installed-data migration or release promotion occurs on the strength of importer counts alone.

### D. Restore the complete effective agent setup

Port behavior to native domains, retaining only the small compatibility surfaces required by the user:

| Integration | Finish requirement |
| --- | --- |
| DevRyan plugins | Track the fate of all 19 packaged modules (reuse, native port, host-owned replacement or justified removal), plus effective third-party registrations. Inventory effective registrations, not just filenames. Port task/Council, browser/document, context/skills, session changes, recovery, OAuth, model/catalog and request-shaping hooks to their existing owners. |
| Slim | Keep its native setup behind an explicit capability allowlist. Preserve commands, interview/deepwork/reflect/loop, AST/web tools, repair hooks, image routing and skills. Real permission/progress/abort channels are mandatory. Withhold permission-policy mutation, privileged request hooks, sessionless generation and local MCP spawn authority. Canonicalize AST paths and authenticate interview continuations. |
| Claude/Meridian | Retain the captured transport tuple: Meridian 1.62.6, Claude Agent SDK 0.2.141 and Claude Code 2.1.251. The earlier 2.1.281 plan entry did not match the captured executable; the [reviewed input provenance](../../../../packages/web/runtime/reviewed-inputs/README.md) records the actual bytes. Host owns startup/health/disposal. Register native provider routing before model resolution and keep request/directory identity. |
| Cursor | Retain DevRyan's working SDK execution path. The open-cursor native experiment did not prove cancellation parity; do not switch production ownership merely because native registration works. |
| Image generation | Use native credential/integration resolution at execution, with account switching, expiration and refresh. Preserve cancellation and publish generated files through the owned execution boundary. |
| Ponytail and skills | Preserve modes, commands, prompt bytes, names/aliases, package skills and supporting files. Keep dormant files dormant. A catalog hash alone does not prove a skill can load its resources. |
| TODO and diagnostics | Restore the existing structured TODO contract and objective guards in native tools/metadata. Use user-selected lint/typecheck/compiler commands for diagnostics; remove worker LSP only once causal fail→fix→pass checks work. |

Freeze the effective saved graph again before live runs. The previously captured target is Astra/medium Orchestrator; 6.1 Sol/medium Fixer; Opus 5.5/medium Designer and /high Oracle; DeepSeek v4.1 Flash/high Explorer and Librarian; Grok 4.6/high Builder; 5.6 Sol/medium Council coordinator. Verify Council members and project overrides separately. Historical test-cell profiles with all roles pinned to Astra are not the user's saved graph.

Capture effective tools/permissions/skills per role and selected model, ordered Council members, duplicate skill display names versus stable IDs, and supporting-resource grants. Every primary and child must use its saved provider/model/effort, not merely advertise it. Required hooks, tools, skills and settings must remain effective after reload and concurrent multiple locations, including Slim registration/cleanup races. Missing required behavior leaves readiness degraded. Share, MCP OAuth, session-shell UI, LSP and message-edit capability changes must be listed for user review; hidden controls do not silently count as parity.

**Exit:** exact effective inventory plus behavioral checks for every active integration; no required plugin disabled to pass tests; required provider recovery and duplicate-output policies requalified for the new runtime.

The [active setup and 19-module disposition ledger](../../2026-10-02-opencode-v2-active-setup/README.md) records exact owners, qualified local evidence and remaining assembled/live gaps. Its optional compiled reviewed-setup diagnostic activates the original sealed Slim graph rather than counting an inactive registration.

Stage D remains in progress. Focused evidence now covers exact skill support
reads through the native Environment service; persisted skill permission views;
native credential commits and redacted account metadata; original-caller MCP and
OpenAI account facades; supervised original Slim AST replacement; and durable
TODO continuation reservations. These passes do not establish assembled or live
provider parity. Root evidence includes `stage-d-root-ast-routing.log` (21 native
tests, 123 assertions), `stage-d-root-ast-owners.log` (121 tests),
`stage-d-root-context-owners-retry.log` (55 tests), and
`stage-d-root-context-types.log` (native typecheck). Worker evidence is retained
in `stage-d-native-primary-*`, `stage-d-skill-permission-view-*`,
`stage-d-native-integration-facade-*`, and `stage-d-ast-worker-*`.
The real source-runtime TODO qualification passed in
`.cache/v2-validation/native-todo-Jr992W/result.json`: the original TODO tool
wrote metadata, an idle continuation lost its acknowledgement, the owned
controller was killed, and restart consumed the same reserved message once.
The final TODO revision was 2, its continuation budget was 1, and all three
cleanup owners settled. This exposed and corrected an internal read through
the intentionally stripped public session projection; 49 focused client and
metadata-derivative checks passed (`stage-d-root-private-metadata.log`).
Original HTML/document/browser adapters are being composed; their local fixtures
are not Electron/browser or compiled-runtime acceptance. The authorized active
global inventory in `.cache/v2-validation/active-retention-inventory.json`
records hashes and only sanitized settings from `opencode.json`, `config.json`
and `oh-my-opencode-slim.json`: none sets `auto`, `prune`, `tail_turns`,
`preserve_recent_tokens` or `reserved`. The user's preference for native v2
therefore selects native compaction retention without a legacy retention patch.
Explicit legacy `prune`/`tail_turns` overrides remain compatibility data only;
their behavior is unsupported and must be discussed if a future effective
configuration enables them. Native retention uses a token budget and whole
exchanges rather than a configured legacy user-turn cap or legacy tool-output
pruning. Native OpenAI/Cursor account mutations now use the original caller's
fresh authorization immediately before the credential write, including account
selection and revocation during the final read. Cursor keeps its existing SDK
execution path and resolves its selected key from the native credential owner.
Provider Disconnect removes selected prepared configuration through the existing
apply coordinator; partial removal remains explicit. Focused checks cover these
source contracts, while assembled-runtime qualification remains pending.

| Additional Stage D check | Current result | Evidence and limit |
| --- | --- | --- |
| Final credential-write authorization | 17 passed, 99 assertions | `.cache/v2-validation/stage-d-credential-final-revocation-tests.log`; real native credential services with revocation during the last read |
| Fresh settings policy for native operations | 91 passed | `.cache/v2-validation/stage-d-native-settings-reauthorization-2.log`; permission changes apply to provider/MCP settings without revoking unrelated chat access |
| Native account/configuration Disconnect | 96 passed | `.cache/v2-validation/stage-d-provider-disconnect-final.log`; source routes, exact credential grants, configuration CAS and explicit partial failures |
| First combined full validation | Failed in script tests | `.cache/v2-validation/stage-d-validate-full-1.log`; lint, typechecks and documentation passed, followed by six temporary-directory fixture failures and one Bun-only test dispatched to Node |
| Migration fixture isolation correction | 7 passed | `.cache/v2-validation/stage-d-test-fixture-isolation.log`; repository-local fixtures now work without a caller-supplied temporary directory, with assertions preserved |
| Second combined full validation | Failed in native script tests | `.cache/v2-validation/stage-d-validate-full-2.log`; 154 native tests passed and 21 failed. Shared fixture asset resolution and stale replacement lookup caused the failures; the corrected fixtures retain original worker behavior and confinement |
| Third combined full validation | Failed in native typecheck | `.cache/v2-validation/stage-d-validate-full-3.log`; the new shared asset fixture lacked its declaration file. The declaration now describes its actual typed result |
| Fourth combined full validation | Failed in the web stage | `.cache/v2-validation/stage-d-validate-full-4.log`; preceding mandatory stages passed, including 4,027 UI tests. Web recorded 6,022 passed, two failed assertions and one wrong-runner suite. This is not a current-tree full pass |
| Web expectations, discovery and provider-resolution admission | 13 web tests and discovery contract passed | `.cache/v2-validation/stage-d-web-failures-provider-resolution.log`, `stage-d-test-discovery-retry.log`; historical plugin evidence hashes remain unchanged and the changed model-policy plugin is marked stale. MCP proxying without an owned integration is refused. Native resolution rechecks the admitted runner or exact secondary operation and expires its callback |
| Reviewed runtime input test ownership | 5 passed, 17 assertions | `.cache/v2-validation/stage-d-reviewed-input-tests.log`; the original bundled Slim codemap test runs under Bun through central discovery, outside Vitest. Its assertions and source bytes are unchanged |
| Actual post-tool context diagnosis | Read executed; continuation failed | `.cache/v2-validation/package-rNbE3u/result.json` and `stage-d-posttool-context-evidence.json`; native tool-result messages have no required ID. The compiled read is not a qualified complete lane |
| Native tool-result context correction | 2 passed, 86 assertions | `.cache/v2-validation/stage-d-slim-native-tool-result.log`; actual native tool messages retain their identity, role and nontext references through private presentation projection. Compiled qualification remains required |
| Original Slim task-board context | 5 passed, 105 assertions | `.cache/v2-validation/stage-d-slim-taskboard-insertions.log`; the actual original renderer adds bounded presentation messages through the shared scheduler/primary owner. Forged insertions and oversized output are refused before acknowledgement. Snapshot settings passed 11 checks in `stage-d-taskboard-snapshot-settings.log` |
| Confined Cursor SDK state and title | Actual prompt/title passed | `.cache/v2-validation/stage-d-cursor-confined-store-prompt-title-retry.log`; the original SDK uses a shorter state path inside its existing private worker HOME. Both SDK runs produced real confined termination receipts |
| Cursor Stop settlement | 45 passed, 181 assertions | `.cache/v2-validation/stage-d-cursor-stop-settlement-tests.log`; known cancellation still awaits owned prompt closure and retains unrelated cleanup failures. `stage-d-cursor-aborted-roundtrip.log` separately proves the stored native `aborted` error reloads as `MessageAbortedError`; `stage-d-cursor-frozen-assembled-types.log` passed the assembled typecheck. The next compiled bundle must qualify the producer correction |
| Cursor compiled restart diagnostic | Three cases passed, then restart failed | `.cache/v2-validation/compiled-cursor-5pli4N/result.json`; completed Revert was incorrectly rejected as pending migration. This diagnostic used the preceding compiled error producer and does not qualify the corrected bundle |
| Completed Revert bundle resume | 30 bundle checks and 8 migration checks passed | `.cache/v2-validation/stage-d-bundle-resume-revert-2.log` and `stage-d-migration-preflight-preserved.log`; resume permits a valid conversation-only marker after completed migration, while import preflight, pending transactions, input and materialization remain closed. Compiled restart remains required |
| Application build and startup bundle budget | Passed | `.cache/v2-validation/stage-d-application-build-1.log` and `stage-d-bundle-check-1.log`; native controller packaging and later source changes require their own final qualification |
| Native provider credentials and final transport checks | 25 native tests / 137 assertions and 61 Node tests passed | `.cache/v2-validation/stage-d-provider-native-focused.log`, `stage-d-provider-owner-focused.log`, `stage-d-provider-credentials-types.log`; original XAI OAuth lifetime, selected-account rechecks, finite key resolution, background Console refusal and bounded replay tracking. These fixtures do not prove live saved-provider access |
| Candidate 10 compiled Cursor | All 7 checks passed | `.cache/v2-validation/compiled-cursor-OYodcQ/result.json`; real SDK prompt, Stop with reloaded `MessageAbortedError`, committed Revert, controller-death recovery, fresh account capacity, connection verification and native title. Source unchanged, real confined termination receipts, cleanup empty |
| Fifth combined full validation | Failed in three release test fixtures | `.cache/v2-validation/stage-d-validate-full-5.log`; 893 Node tests passed. Repository-contained extensionless fake executables inherited ES-module scope. Explicit CommonJS fixture scope preserved the production release script and all assertions; three focused checks passed in `stage-d-release-fixture-scope.log` |
| Sixth combined full validation | Failed in one native catalog fixture | `.cache/v2-validation/stage-d-validate-full-6.log`; typechecks, lint, docs and Node tests passed; native tests recorded 193 passed and one failed. The fixture attempted raw unsupported Copilot credential creation, which the guarded service correctly refuses. Fixture correction and another full run remain required |
| Candidate 10 complete reviewed graph, first attempt | 24 checks passed; read-denial oracle failed | `.cache/v2-validation/package-EXe7DQ/result.json`; compiled assets, migration, active reviewed graph, read with post-tool continuation, writers, formatter and causal CLI fail→published edit→pass worked. The original Slim read guard denies a foreign project before an external permission request; the fixture incorrectly expected the later permission path |
| Candidate 10 reviewed graph after read oracle correction | 26 checks passed; manual compaction failed | `.cache/v2-validation/package-Lm268o/result.json`; exact early protected-read refusal and configured reviewed command passed. Compaction failed with `context_objective_owner_unavailable`: native commands had no durable primary admission. This is a product gap being corrected; compiled qualification is incomplete |
| Application rebuild and startup bundle budget | Passed | `.cache/v2-validation/stage-d-application-build-2.log`, `stage-d-bundle-check-2.log`; application bundle checks pass, independently of the remaining native qualification failures |
| Native command primary admission | Focused owner, real mutex and regression checks passed | `.cache/v2-validation/stage-d-command-primary-owner-final.log` (9), `stage-d-command-primary-mutex.log` (1 / 7 assertions), `stage-d-command-primary-regression.log` (207 / 794 assertions), and native typecheck. The exact derived command reserves its original caller's primary objective before native inbox publication; compiled manual compaction must still pass |
| Native request observation and journal privacy | Actual SDK graph and focused journal checks passed | `.cache/v2-validation/stage-d-native-observation-span.log`, `stage-d-native-observation-sanitizer-export.log` (13 / 41 assertions), `stage-d-observation-process-gap.log` (9). Effective prepared controls, physical HTTP/WS attempts and committed steps use actual native span identity; the finite journal contract preserves fields and hashed directory witnesses without prompt content. Compaction and final compiled qualification remain pending |
| Final native observation graph | 6 passed, 38 assertions; native typecheck passed | `.cache/v2-validation/stage-d-native-observation-final.log` and `stage-d-native-observation-types-final.log`; original HTTP/WS controls, canonical step linkage, manual compaction settings/budget/revision and raw Started/Ended identities. A SHA-guarded read-only build insertion observes the original private budget calculation. Skipped compactions avoid hashing/RPC; diagnostic failure cannot alter the native decision |
| Candidate 11 reviewed package | 23 checks passed; browser fixture failed | `.cache/v2-validation/package-PVnLQO/result.json`; ordinary compiled tools and causal CLI failure→published correction→success passed. The browser tool was absent because the explicit fixture omitted its optional registration. Browser, Council, document, command, skill and restart qualification remained incomplete. Source and cleanup checks passed |
| Candidate 11 native artifacts | Built and development signatures verified | `.cache/v2-validation/stage-d-native-build-11.log`; build ID `505afac9a2fc89b6043c570ccbcb9cfe27c1d9dc5f7e20788fd149755cde5d21`. Includes command primary admission and native observation. Compiled behavioral checks and release signing remain separate |
| Controller replacement execution lifetime | 60 host/owner tests and 8 real image-worker tests passed | `.cache/v2-validation/stage-d-controller-lifecycle-host-frozen.log` and `stage-d-controller-lifecycle-image-frozen.log` (62 assertions). Replacement now settles the old acquisition lifetime before creating a fresh one; final shutdown remains terminal. Paused capture/helper admission, a missing helper receipt and concurrent final shutdown retain their fences. Actual replacement uses a new keeper with confined termination/publication receipts; the earlier test timeouts came from an eager rejection assertion before releasing its own barrier |
| Original Slim AST/webfetch package fixtures | Node and Bun each passed 3 focused checks | `.cache/v2-validation/stage-d-compiled-slim-tools-focused.log` and `stage-d-compiled-slim-tools-bun.log`; physical local HTTPS refusal/HTTP fallback and strict receipt negatives pass. Original compiled search/preview/replacement and HTML parsing remain pending in the package run |
| Native QA profile factory, first actual diagnostic | Failed during source preparation | `.cache/v2-validation/native-factory-NxprDp/result.json`; the copy destination already existed before the fixture attempted its exclusive directory copy. No native host or inference ran. Factory correction and actual catalog verification remain required |
| Candidate 12 native artifacts | Built and development signatures verified | `.cache/v2-validation/stage-d-native-build-12.log`; build ID `0c53c1e7a5d7c69dd678542d979bf31bbc16f846b031128e095e8bb99c7cee5b`, manifest SHA-256 `bffb0c6f0e903fcb8bae7ecc22680fc7adc71472d04b3b3a50de48f72a2083e3`. The manifest records 4,649 source inputs and nine files. Compiled behavior and release signing remain separate |
| Application rebuild after execution-lifetime correction | Build and startup bundle budgets passed | `.cache/v2-validation/stage-d-application-build-3.log` and `stage-d-bundle-check-3.log`; packaged UI and native plugin qualification remain separate |
| Final native lifecycle acceptance | All 47 checks passed | `.cache/v2-validation/native-FT723I/result.json` and `stage-d-native-final-lifecycle.log`; all controller replacements and final owned shutdown had no remaining processes, rescue signals or observation errors. Source cohort unchanged |
| Candidate 12 compiled Cursor | All 7 checks passed | `.cache/v2-validation/compiled-cursor-yC4Ali/result.json`; original SDK completion, Stop with reloaded abort state, Revert, controller replacement, renewed write capacity, connection verification and title. Source unchanged and cleanup empty |
| Candidate 12 browser diagnosis | 23 preceding checks passed; browser fixture failed | `.cache/v2-validation/package-I0VM30/result.json` and `package-NWNxjg/result.json`; safe resolve/acquire observations prove the preview was present throughout the private bridge. The fixture supplied HTTP while the original tool requires HTTPS for bare open. Source and cleanup checks passed. No diagnostic journal was configured in these private fixtures; the absent-directory gap command supplies no journal coverage. HTTPS fixture correction requires another actual compiled run |
| Candidate 12 browser HTTPS retry | Actual tool completed; fixture output parser failed | `.cache/v2-validation/package-XiLP6D/result.json`; the original Rust CLI completed open/snapshot/fill/click/eval/screenshot/close through the real Electron bridge, and the supervised writer published the PNG. The retained screenshot was visually inspected and shows the entered value and matching page result. The fixture parsed the appended publication note as JSON; its corrected parser now separately verifies exact published paths and metadata. Source unchanged and cleanup empty; the whole package run remains incomplete |
| Candidate 12 compiled browser acceptance | Passed; later Council assertion failed | `.cache/v2-validation/package-OOlGK7/result.json`; actual Electron 41.2.1 / Chromium 146.0.7680.188, original CLI, all seven actions, exact publication metadata, one created/released lease and zero residual leases. `compiled-browser.png` was visually inspected, SHA-256 `c6ee8dbfd272bdfef1033bfdbccb9d4af07cf14fe10048409d93813babb2a0bf`. All five observed browser processes stopped without rescues or observation errors. Council tool completion passed, but the subsequent durable managed disposition assertion returned null instead of continue; complete Council/package acceptance remains pending. Source cohort unchanged and cleanup empty |
| Candidate 12 Council policy correction | Actual browser and complete Council checks passed; document fixture failed | `.cache/v2-validation/package-NBLjYc/result.json`; Council now collects each seat through the policy-supported per-task wait and verifies its committed continue envelope. Two distinct model selections, independent responses, canonical children and durable dispositions passed. Document list returned the DOCX but omitted the plain-text fixture; subsequent bounded reads remain unqualified. Source cohort unchanged and cleanup empty |
| Seventh combined full validation | Failed in one native observation build fixture | `.cache/v2-validation/stage-d-validate-full-7.log`; lint, typechecks, docs and Node scripts passed; native scripts recorded 201 passed and one failed. The observation span fixture's bundle could not resolve generated AWS credential-provider chunks. Its original span assertion did not run; resolver diagnosis and the complete retry remain required |
| Native observation fixture resolver | Original graph assertion passed | `.cache/v2-validation/stage-d-native-observation-graph-resolver-fix.log`; the fixture now uses the production reviewed-input resolver for generated AWS chunks. Real HTTP/WS attempt identity, canonical step linkage and compaction assertions remain intact |
| Candidate 12 document and MCP continuation | Browser, Council and all document checks passed; MCP failed | `.cache/v2-validation/package-NEFjGI/result.json`; two actual DOCX attachments, bounded pagination/reassembly and exact search offsets passed. The earlier plain-text fixture was intentionally inlined by the product. MCP registration was absent from the native registry, exposing a product composition gap; full package qualification remains incomplete. Source cohort unchanged and cleanup empty |
| Eighth combined full validation | Passed at an intermediate checkpoint | `.cache/v2-validation/stage-d-validate-full-8.log`; all mandatory suites passed, including 4,027 UI and 6,050 web tests across 493 web files. Subsequent lifecycle and MCP changes require final validation on the finished tree |
| Native startup generation binding | 77 lifecycle checks and lint passed | `.cache/v2-validation/stage-d-native-startup-generation-test.log` and `stage-d-native-startup-generation-lint.log`; verified native identity is bound before startup recovery calls the public client. Readiness still waits for recovery and probing; failed verification does not publish generation two |
| Actual native profile factory startup | Native readiness passed; supplied-model catalog assertion failed | `.cache/v2-validation/native-factory-CBDLVR/result.json`; isolated production web/native startup reports generation two, ready and active execution, with the expected Builder selection. The supplied model is missing from the returned provider catalog and remains under diagnosis. All eight observed processes stopped without rescue signals or observation errors |
| Exact terminal-event performance attribution | 11 focused checks and lint passed; measurement not run | `.cache/v2-validation/stage-e-terminal-attribution-contract.log` and `stage-e-terminal-attribution-lint.log`; actual SSE receipt joins supply arrival and observation-gap percentiles only with complete canonical identity coverage. Missing evidence remains unavailable; this is measurement infrastructure, not a performance result |
| Native reviewed MCP registration | 9 graph/contract checks, 51 assertions and native typecheck passed | `.cache/v2-validation/stage-d-remote-mcp-registration-fix.log` and `stage-d-remote-mcp-registration-types.log`; sealed per-location servers now enter the original native transformer at acquisition. Empty Config discovery, two locations, duplicate registration, OAuth refresh and stale/cancelled scopes are covered. General configuration mutation remains refused; compiled qualification follows |
| Candidate 13 native artifacts | Built and development signatures verified | `.cache/v2-validation/stage-d-native-build-13.log`; build ID `2694222add4a38d4fa175193823ff05b51e4a9bc2ecce26b01581a459cd6a45d`, manifest SHA-256 `fe995bc12ee20c2c5608b51f58cca8f1b343258ffae92bebfae7424e2256407e`. Contains the MCP registration correction; compiled behavioral checks and release signing remain separate |
| Application rebuild after startup and MCP corrections | Build and startup bundle budgets passed | `.cache/v2-validation/stage-d-application-build-4.log` and `stage-d-bundle-check-4.log`; packaged UI and final native compatibility checks remain separate |
| Resumed catalog, saved selections and MCP identity | Focused source checks passed | `.cache/v2-validation/resume-native-catalog-file-tests.log`, `resume-native-snapshot-tests.log`, `resume-slim-preset-final.log` and `resume-mcp-focused-final.log`; exact offline catalog/effort readiness, preset precedence and the real-owner native MCP identity are covered. No saved provider inference is claimed |
| Candidate 14 native artifacts | Built; linked public catalog hash verified | `.cache/v2-validation/stage-d-native-build-14.log` and `stage-d-14-linked-input-diff.json`; build ID `e8c8622198985ad5e283cb536491a17c7a6889442bc6d71a6ef5006b707433a4`, manifest SHA-256 `6486af65ecca620526715750c0cb34eb5bc3d07c824b768fbc7b9acd5ed6bf95`. All 11 retained model/effort tuples pass original native normalization in `resume-d14-catalog-selection-check.json`; account-backed registration remains separate |
| Candidate 14 composition preflight | Failed at missing tool-catalog route | `.cache/v2-validation/package-izDgTR/result.json`; compiled startup and eight reviewed families passed in both locations, then the real client received 404 from `/devryan/tools`. Cleanup passed. The journal directory was absent; the gap command's empty result is not journal coverage. The earlier `package-T9h2aD` attempt used the wrong Bun host runner and failed before controller launch. The missing product route requires correction and a fresh candidate |
| Native tool catalog | Real-client graph, native types and lint passed | `.cache/v2-validation/resume-native-tool-catalog-final-4.log`; 19 tests and 145 assertions cover the authenticated route, both sealed locations, actual model lookup and native tool schemas. Snapshot reads retain location lifetime checks and exclude uncontrolled executors |
| Candidate 15 native artifacts | Built; all 4,659 linked/build inputs verified | `.cache/v2-validation/stage-d-native-build-15.log` and `stage-d-15-linked-input-diff.json`; build ID `61a5849b7af1daccb9e59068048d4c8e2a3319058f37eb5986d88ad7138490a3`, manifest SHA-256 `272566b68b1fd7ce864e8cc07108e5325332bbb57e8f3988008329348df8eb40`. Only the two tool-catalog product files differ from candidate 14; public catalog bytes are unchanged |
| Candidate 15 composition preflight | 15 checks passed | `.cache/v2-validation/package-RWPTGm/result.json`; both locations' registrations and schemas, actual read/write, ordered Council and both MCP paths passed. Source cohort unchanged and cleanup clear. This remains composition-only evidence; full package qualification is required |
| Candidate 15 production startup factory | Passed with synthetic account/profile | `.cache/v2-validation/native-factory-XUQNY5/result.json`; actual isolated web/native startup and exact supplied `openai/gpt-5.6-sol/high` catalog/selection passed. All 11 observed processes stopped without rescue signals or observation errors. No personal provider inference is claimed |
| Candidate 15 full package qualification | Failed after 35 checks at original Slim command admission | `.cache/v2-validation/package-WZz9xl/result.json`; artifacts, migration refusals, catalogs, Council, MCP, writers/formatter, CLI fail-fix-pass, manual compaction/native observations and Ponytail help passed. The next original `deepwork` command returned `native_command_definition_unreviewed`. Cleanup passed and source cohort stayed unchanged. No journal directory or Error Log UUID was recorded; `stage-d-package-15-journal-gaps.log` is empty and does not establish journal coverage. Later gates were not reached |
| Native command startup composition | Focused startup and security checks passed | `.cache/v2-validation/resume-controller-command-registry.log`, `resume-controller-command-gates.log`, `resume-controller-command-types.log` and `resume-controller-command-lint.log`; production startup now passes its existing sealed Slim/Ponytail declarations to the unchanged command gate. The startup graph and four command-security tests passed; independent review confirmed custom overrides and foreign origins retain their existing checks |
| Candidate 16 native artifacts | Built; one linked source changed | `.cache/v2-validation/stage-d-native-build-16.log` and `stage-d-16-linked-input-diff.json`; build ID `09872a32c2a277b8c577e4b12fdd035149bbb3381779240b5047548e5c7f5be5`, manifest SHA-256 `ef5b4ffa5125eaa59c45f2b3b9ed92d035124a93bd48e3b0bd5374a519910b72`. All 4,659 linked/build inputs verified; only `controller-startup.ts` differs from candidate 15 |
| Candidate 16 first command preflight | 17 checks passed; loop fixture oracle failed | `.cache/v2-validation/package-4Nx9gr/result.json`; actual original `deepwork` passed. The loop responder incorrectly compared an independently randomized history path in a 12-line prefix; `stage-d-preflight-16-loop-oracle.json` proves the complete canonical prompt matches after normalizing only that existing random ID. The oracle now checks the complete normalized activation and retains exact canonical-to-wire equality. Two focused tests and lint passed; the failed provider assertion remains in cleanup evidence. Source unchanged; absent journal and empty gap output remain unqualified |
| Candidate 16 expanded preflight | 19 checks passed | `.cache/v2-validation/package-MPuRUk/result.json`; all prior composition/control checks plus actual original Ponytail help, `deepwork`, `loop` and `reflect` passed with exact canonical prompt and physical-request checks. Cleanup clear and source cohort unchanged. Full assembled qualification remains required |
| Candidate 16 full assembled attempt | 38 checks passed; interview assertion failed | `.cache/v2-validation/package-qrokT3/result.json`; commands, Council, MCP, writers, formatter, CLI fail/fix/pass, manual compaction and native observation passed. The interview lane stopped on a count assertion; diagnosis must distinguish original behavior from duplicate work. Cleanup clear and source cohort unchanged. Journal absent; `stage-d-package-16-journal-gaps.log` has empty output, which does not establish coverage |
| Original interview notification oracle | 3 focused checks and lint passed | `.cache/v2-validation/package-16-interview-count-diagnosis.json` proves one accepted native user, one completed assistant, one original no-reply synthetic UI notice and one physical request. The existing facade projects the standalone notice as a user-role record. The corrected oracle verifies both exact canonical identities and rejects duplicate commands/notices, forged synthetic parts and changed arguments. Full compiled retry remains required |
| Fifth application build and startup bundle check | Passed | `.cache/v2-validation/stage-d-application-build-5.log` and `stage-d-bundle-check-5.log`; fresh UI copied to `.cache/qa/stage-f-web-build5-tcnlGT` with SHA-256 `f3eee83b0025e095953c68605014a9c5d178d24e25bb33fd6dd7e2c73ad26c2f` |
| Fresh packaged Electron QA artifact | Passed packaging and native smoke | `.cache/qa/packaged-electron-jbI0vn/package-evidence.json`; actual archive/source/UI identities verified, Electron 41.2.1 arm64 SQLite and PTY smoke passed. Signing/release and UI journeys are not established by this package check |
| Candidate 16 interview retry | Failed after 38 checks | `.cache/v2-validation/package-xUQ4yw/result.json`; the lease assertion incorrectly read `scope.publicationPolicy` instead of the top-level field. Retained leases prove successful publication. A separate second physical request is real: the original no-reply notice used native inbox admission, and `resume:false` did not prevent the active runner from consuming it. Status-only persistence needs a product correction. The duplicate-request assertion also appears in cleanup. Source cohort unchanged; absent journal remains unqualified |
| Ninth full validation | Failed in four native graph tests | `.cache/v2-validation/stage-d-validate-full-9.log`; lint, types, docs and Node script tests passed; Bun native graphs recorded 205 passed and four failed. The new tool-catalog gate's separate `Model.node` replacement erased provider compatibility, including OpenAI normalization and Copilot's scoped discovery. Compaction expectations also observed the unnormalized limits. Correct composition is required; these are not accepted oracle changes. The QA settings layout changed during this intermediate run |
| Candidate 16 independent native/TODO/Cursor checks | Native 47 and source TODO passed; Cursor failed | `.cache/v2-validation/native-TvzSxG/result.json` passed all 47 checks with unchanged source and clear final/replacement cleanup. `native-todo-qeg1NA/result.json` passed lost-ACK/controller-replacement continuity with fulfilled cleanup, but does not emit its own source-cohort digest. `compiled-cursor-gazd1s/result.json` failed before cases on `native_catalog_mismatch`, with unchanged source and clean termination; no journal was present. These remain checkpoints before the next product corrections |
| First actual-v1 backend UI attempt | Both web and Electron failed before inference | `.cache/v2-validation/stage-f-runtime-g1-build5.log`; the synthetic profile supplied unsupported sidecar override fields and omitted Slim/application pins, leaving a packaged model selected. Both original failure PNGs were visually inspected; zero provider requests, journal gaps or owned process survivors. The corrected profile uses supported model/variant overrides and matching Slim/application defaults. Six tests, lint and `resume-runtime-ui-pins-corrected-preparation.json` pass with both wrapper states, no model requests and settled cleanup. Both actual UI journeys still require retry |
| Final provider model view at tool-catalog acquisition | Focused graph, type and lint checks passed | `.cache/v2-validation/resume-model-catalog-composition-admission-unit-final.log` and the related composition logs; the Tool gate now acquires the final Model dependency without replacing it. OpenAI limits, Copilot account-scoped discovery/reload and compaction calculations retain their original provider behavior. These source results precede the next native candidate |
| Interview status-only notification | Actual SDK graph and three Slim checks passed | `.cache/v2-validation/resume-native-notification-graph.log`, `resume-native-notification-package.log` and `resume-native-notification-frozen.sha256`; the private owner publishes the original durable synthetic event without inbox admission. The canonical notice appears once, exactly one physical primary request completes, existing primary-step/Bus observation remains active, and changed-body, foreign, stale, directory and revocation cases refuse. The compiled retry remains required |
| Provider request and observation composition | Combined regression passed | `.cache/v2-validation/resume-final-composition-tests.log` records 23 passed checks/164 assertions across seven files; joint native types and lint pass. Observation now wraps the existing provider request decorator inside one final service replacement. The real combined graph retains canonical Meridian headers, body lifetime, transport failure/cancellation settlement and matching prepared/physical observations. The bounded production replacement inventory found no remaining competing service owner |
| Passive Cursor catalog readiness | 12 Bun and seven Node checks passed | `.cache/v2-validation/resume-cursor-declared-frozen.json`; the original SDK supplies fresh static declarations without credentials, discovery calls or account caches. Finite boot metadata checks exact Cursor IDs/efforts per location, while other providers still use the native catalog. Unknown IDs and unsupported efforts stay closed. The synthetic fixture now consistently uses the SDK-declared `composer-2.5`; saved user routes are unchanged. Static declarations do not prove account access or account-specific models |
| Candidate 17 native artifacts | Built; inputs verified | `.cache/v2-validation/stage-d-native-build-17.log` and `stage-d-17-linked-input-diff.json`; build ID `d980e6afdf6fb7ff706376462c843f7743721fd074f498693b1546b0552badcf`, manifest SHA-256 `cb87520a2f75a3e99529141ea2a6609a9505e04003341c0269a9cbd647a24be0`. All 4,661 input entries/4,659 unique paths verified, including the unchanged reviewed public catalog. The two newly linked files are the notification helper and original SDK event export; seven existing linked sources changed. Full qualification remains required |
| Candidate 17 preflight and lifecycle checkpoint | 19 preflight and 47 native checks passed | `.cache/v2-validation/package-ZdSubv/result.json` and `native-QdCWlk/result.json`; both source cohorts stayed unchanged and cleanup passed, including all lifecycle replacements. The source TODO lane was held for the subsequent Node-only readiness correction. The native lane's absent journal and empty gap check do not establish journal coverage |
| Candidate 17 full package attempt | Failed after 38 checks | `.cache/v2-validation/package-naoQm3/result.json`; the interview lane timed out waiting for a completed assistant plus its original no-reply notice. The native notice did persist, but no physical request was observed. Cleanup clear, source unchanged, and no journal directory/UUID was recorded; `stage-d-package-17-journal-gaps.log` is empty. A later source regression reproduces a synthetic notice being mistaken for the latest accepted user; the retained run's exact error remains unavailable. The unchanged interview probe now runs during preflight, before the expensive full lanes |
| Disabled-agent readiness and compiled Cursor retry | 28 focused checks and all seven Cursor cases passed | `.cache/v2-validation/resume-enabled-agent-requirements-tests.log`; readiness derives enabled translated agents and retains explicit policy requirements. Both native `disabled` and legacy `disable` are respected; an explicitly required disabled/missing agent still fails. This Node-only correction does not change candidate 17's linked inputs. `compiled-cursor-BasJPj/result.json` retains the initial missing-title failure; `compiled-cursor-an7p2w/result.json` passes exact declarations, completion, Stop, Revert, replacement and read-only verification/title with both catalogs asserted and cleanup clear |
| Sixth application build and bundle check | Passed | `.cache/v2-validation/stage-d-application-build-6.log` and `stage-d-bundle-check-6.log`; immutable UI copy `.cache/qa/stage-f-web-build6-Pg4LGL` matches SHA-256 `f3eee83b0025e095953c68605014a9c5d178d24e25bb33fd6dd7e2c73ad26c2f`. This precedes the Node-only disabled-agent correction; fresh packaging and UI journeys remain outstanding |
| Canonical accepted-user provenance | 51 focused checks, two actual native graph cases, types and lint passed | `.cache/v2-validation/resume-native-canonical-user-pages-tests-final.log`, `resume-native-notification-prephysical-final.log` and `resume-native-canonical-user-pages-frozen.sha256`; the private bounded page filters projected records by native `type:'user'` from the same raw page. Synthetic status notices cannot replace an accepted user, while real user messages containing synthetic-marked parts remain valid. Session/location/generation fences, all-row scan budgets and newer-user refusal remain enforced |
| Candidate 18 native artifacts | Built; all inputs verified | `.cache/v2-validation/stage-d-native-build-18.log` and `stage-d-18-linked-input-diff.json`; build ID `a352987aaf317be5ec92f86c587ec4a2950dfabd8b0403ee1ded9e4cf6395e32`, manifest SHA-256 `e424646781c728b0a17dd0cdba23a65c2d0d718b3caf3855b16a3594f423898d`. All 4,661 input entries/4,659 unique paths match. Only the private canonical reader differs from candidate 17's linked inputs |
| Candidate 18 original-interview preflight | Failed after 19 checks | `.cache/v2-validation/package-ltC46o/result.json`; catalogs, Council, MCP and original commands passed. Unlike candidate 17, the interview reached model preparation and a physical request, then failed the combined completion/notice assertion. Source cohort unchanged and cleanup clear. The journal is absent and `stage-d-preflight-18-journal-gaps.log` is empty; further diagnosis must use the actual sequence and bounded native failure evidence |
| Candidate 18 failure capture and primary-owner reproduction | Compiled failure retained; exact source reproduction failed as expected | `.cache/v2-validation/package-cLyY2p/result.json` retains one native execution-failed event after the physical request, with generic error text represented only by hash/length. Its source cohort and cleanup pass; journal remains absent. `resume-native-notification-real-primary-exact.log` reproduces `native_continuation_fenced` with the real primary-step and recovery owners: the projected status notice becomes the assistant's parent while recovery still owns the accepted command. Status-only classification requires correction without weakening continuation checks |
| Private status-only turn classification | Real-owner graph 2, projection/client/shell 149 and recovery/shared 179 checks passed | `.cache/v2-validation/resume-native-status-frozen.json` binds 19 files. The private notify owner stamps status provenance; raw user rows retain authority even with identical metadata or synthetic parts. History, page lookbehind, live delivery and post-Revert indexing exclude only those status rows from turn parenting, while keeping them visible. Generic synthetic input and shell/compaction continuations remain supported. Native types, lint and docs validation pass; a new compiled candidate is required |
| Slim continuation image/context anchor | Corrected; 54 focused Node, two native graph and 11 supervised worker checks passed | `.cache/v2-validation/resume-image-anchor-before-3.log` retains the original `native_image_message_stale` failure. `resume-image-context-frozen.json` binds 14 corrected source/test/documentation paths. The same bounded raw snapshot derives the canonical turn anchor and genuine attachment owners; the anchor must belong to the active context, and attachments are filtered before processing. Full anchor-payload, user-part, permit, location and generation checks remain. Summary-only contexts execute the original image algorithm without processing compacted-away attachments. Shell-tail coverage uses the exact stored record and renderer; existing independent tests establish shell-owner execution. Native types, lint and lifetime checks pass; compiled qualification remains required |
| Candidate 19 native artifacts | Built; all inputs verified | `.cache/v2-validation/stage-d-native-build-19.log` and `stage-d-19-linked-input-diff.json`; build ID `19942b9c9f21049a3d4cf82a5a87350dd96676d092ec5ac47afd180c465a5bf3`, manifest SHA-256 `77fee0c6f50da03d7011c56372033ede9d1e67c4c1c49d3130bd14b2fa5513b0`. All 4,662 input entries/4,660 unique paths match. The shared status predicate is newly linked and five existing linked sources changed; the reviewed public catalog is unchanged. The Node host corrections are also required for qualification; linked-artifact verification alone does not cover them |
| Candidate 19 compiled preflight | Original interview passed; subsequent Stop check failed | `.cache/v2-validation/package-wcgjTC/result.json` records 20 passed cases before `Stop did not commit actual interrupted native idle`. The Stop termination and actual HTTP-abort checks passed before that assertion. One bounded native execution-failed event was retained for the cancelled session; its hash/length subsequently identified the owned primary-step refusal below. Cleanup and the unchanged-source check passed. No journal directory or Error Log UUID was available; the empty `stage-d-preflight-19-journal-gaps.log` does not establish journal coverage |
| Native Stop cleanup handoff | Corrected; three actual graphs, native types, lint and docs passed | `.cache/v2-validation/resume-d19-stop-failure-code.json` matches the retained 61-byte failure to `native_primary_step_unavailable`; `resume-native-stop-before-2.log` reproduces failed cleanup. `resume-native-stop-frozen.json` binds the correction: only a delivered native interruption omits fresh primary handoff during lazy assistant cleanup. Original Started, Failed and Interrupted events remain. The actual Stop graph records an aborted/completed assistant, interrupted idle, one primary HTTP request, a separate native title request, zero fresh handoffs and zero observation gaps. Five ordinary refusal cases and the interruption-during-rejected-handoff race pass. The cancelled primary stays explicitly unmatched in observation evidence; coverage is successful-turn linkage, not all-attempt settlement |
| Candidate 20 native artifacts | Built and inputs verified; superseded before qualification | `.cache/v2-validation/stage-d-native-build-20.log` and `stage-d-20-linked-input-diff.json`; only primary-step and native observation linked inputs changed from candidate 19. Final type checking required two explicit `undefined` returns in the primary-step callback, so this build is stale and ran no preflight. Candidate 21 must include that correction |
| Candidate 21 native artifacts | Built; all inputs verified | `.cache/v2-validation/stage-d-native-build-21.log` and `stage-d-21-linked-input-diff.json`; build ID `5beb85c895d8d2323cda0d00435060a1cafd5114e3e8357f3376c465856021d0`, manifest SHA-256 `3094e892ae94d32fe4392330d1ccee90814faf8f6616272c8e509686c3a7a1a8`. All 4,662 input entries/4,660 unique paths match. Only the explicit primary-step callback returns changed from candidate 20; the reviewed public catalog is unchanged. The compiled preflight result follows |
| Candidate 21 compiled preflight | All 21 checks passed | `.cache/v2-validation/package-NZTrjX/result.json`; the original interview and actual HTTP Stop both pass, including the durable aborted assistant, interrupted idle and preserved published draft. The bounded failure observer retains the expected aborted-step event, with no execution-failed event. Source cohort unchanged and cleanup clear. Full qualification remains a separate gate |
| Tenth full validation | Failed one Node script test | `.cache/v2-validation/stage-d-validate-full-10.log`; 973 of 974 Node script tests passed before the runner stopped. The benchmark copied-configuration test reaches `native-configuration-snapshot.js` with catalog requirements lacking an agent list; the newer readiness code attempts to iterate that absent list. Caller and contract diagnosis is in progress. Later deterministic suites did not run in this attempt |
| Candidate 21 full package attempt | Failed after 40 passed cases | `.cache/v2-validation/package-QAMqc7/result.json`; original interview, Stop, diagnostic fail/fix/pass, manual compaction and native observation passed. The next Slim tool fixture supplied permissions to public `sessions.create`, which correctly refused with `opencode_privilege_required`. The fixture must use the existing privileged admission path with the same exact rules. Source cohort unchanged and cleanup clear. No journal directory or Error Log UUID was available; the empty gap-check log does not establish journal coverage |
| Candidate 21 source-native checkpoint | All 47 checks passed | `.cache/v2-validation/native-MBqlbQ/result.json`; source cohort unchanged, 41 actual receipts, no remaining processes or cleanup observation errors. This exercises the pinned source SDK and existing supervisor; it is separate from compiled package proof. It precedes the readiness-policy and Slim fixture corrections. Source TODO and compiled Cursor were held and did not run |
| Optional readiness agent requirements | Corrected; benchmark regression, 18 snapshot and 11 readiness checks passed | `.cache/v2-validation/resume-snapshot-optional-agents-frozen.json`; omitted agent requirements default to an empty list, while malformed explicit lists fail. Enabled translated agents and explicit required disabled/missing IDs remain in the requirement union. The original benchmark fixture is unchanged. Native types, lint and independent review pass. Both modified files are outside candidate 21's linked inputs |
| Slim fixture session permissions | Corrected; four focused checks passed | `.cache/v2-validation/resume-slim-tools-admission-frozen.json`; the lane receives a constructor callback to existing private `admission.create`, preserving the four exact rules, current caller authorization and primary enrollment before tool effects. Public permission/metadata refusal remains unchanged, and there is no callback fallback. The sibling package-lane scan found no other instance. Lint, syntax, docs and independent review pass; all four changed files are outside candidate 21's linked inputs |
| Eleventh full validation | Passed | `.cache/v2-validation/stage-d-validate-full-11.log`; workspace lint, types, docs and all mandatory deterministic suites passed, including 6,068 web tests across 493 files. The original Node benchmark and native graph failures remain fixed without weakening their assertions. Compiled qualification, UI and controlled performance remain separate gates |
| Candidate 21 package retry | Failed after 44 passed cases | `.cache/v2-validation/package-nlBBCt/result.json`; original AST search, preview and published replacement passed. The following webfetch call was rejected before execution because the original Slim domain-hostname schema rejects the fixture's IP URL. Source cohort unchanged and cleanup clear; no journal or Error Log UUID was available. Node and Bun loopback hostname probes passed, with the fixture correction still pending |
| Candidate 21 fresh source-native and TODO checkpoints | 47 native checks and TODO continuation passed | `.cache/v2-validation/native-SaKh5B/result.json`, `native-todo-iou5X0/result.json` and `stage-d-21-todo-source-cohort.json`; source/artifact cohorts unchanged and cleanup clear. The first cache-only TODO wrapper failed on its import path before launching a runtime; the corrected wrapper and retry are retained. These checkpoints precede the newly identified observation correction |
| Candidate 21 compiled Cursor checkpoint | Seven lifecycle cases passed; observation coverage unqualified | `.cache/v2-validation/compiled-cursor-7DPOHl/result.json`; actual external executions, Stop/crash receipts and cleanup passed. Both controller instances recorded observation unavailable. The real private Cursor ingress publishes canonical events without native provider-attempt authority; the observation hook incorrectly tries to link that external projection. Journal coverage was unavailable; a real-ingress regression and narrow correction remain required |
| Seventh application build and QA package | Build, bundle budget and native smoke passed | `.cache/v2-validation/stage-f-build7.log`, `stage-f-bundle-check7.log` and `.cache/qa/stage-f-build7-prepared-ROTVFd/prepared.json`; fresh UI copy and packaged UI hashes match. The first generation-1 wire matrix finds a stale fixture click for Global Agent Behavior after the Runtime view was separated. Later matrices are held; this is not a UI qualification pass |
| Seventh-build generation-1 wire matrix | Seven cells completed; all failed on stale fixture expectations | `.cache/v2-validation/stage-f-wire-g1-build7-final-evidence.json`; six desktop cells failed the old Settings label and the mobile cell's strict Plan marker comparison omitted the canonical project directory. All seven archived journal gap checks and owned-process cleanup were clear. The final source/runner/UI/package identity recheck passed; per-cell final drift checks were not reached. The 153 original PNGs remain retained, without a completed visual qualification |
| Webfetch and UI fixture corrections | Focused checks passed; independent UI review clear | `.cache/v2-validation/resume-slim-tools-domain-frozen.json` records four Node and four Bun checks using the domain-shaped loopback URL while preserving TLS/HTTP behavior and all ownership assertions. `resume-ui-fixture-contracts-frozen.json` records eight checks plus lint/diff for the actual Runtime navigation and exact Plan project-directory assertion. Actual compiled and UI reruns remain required |
| External Cursor observation correction | Real before-fix warning reproduced; eight focused checks passed afterward | `.cache/v2-validation/resume-cursor-observation-frozen.json`; only the existing private Cursor ingress scope skips native Step.Started attempt linkage. Copied metadata outside that scope still reaches observation authority and refusal. Original native primary/title/compaction/transport and Stop checks remain passing; native types, lint, docs and diff pass. External execution receipts remain a separate compiled proof |
| Candidate 22 native artifacts | Built; all inputs verified | `.cache/v2-validation/stage-d-native-build-22.log` and `stage-d-22-linked-input-diff.json`; build ID `87bc19b6a075c386e6c242802c9e52d5115e4b368d34b0927341bb71e6993e5d`, manifest SHA-256 `5fa3842a340ae5c760d53da750b240a5c799a0758dde555dfcdc434cbd1342d6`. All 4,662 input entries/4,660 unique paths match; only native observation changed from candidate 21. Compiled qualification results follow |
| Candidate 22 compiled Cursor | All seven cases passed with no observation gaps | `.cache/v2-validation/compiled-cursor-mfmUcy/result.json`; source unchanged, cleanup clear, actual external execution and controller termination receipts verified. Both normal and intentionally crashed controllers report observation available. This qualifies the fixture's external lifecycle and finite observer availability, not live Cursor provider reasoning or timing |
| Candidate 22 full package | Failed after 48 passed cases | `.cache/v2-validation/package-VI5Maa/result.json`; original AST and webfetch text/HTML/control/publication checks now pass. The first image worker completed with a confined termination receipt and published its file, then native tool-result validation rejected the returned output because `native-imagegen-plugin.ts` declared no output schema. Source cohort unchanged and cleanup clear. No journal or Error Log UUID was available; the empty gap check is retained without a journal-coverage claim. Registration correction and assembled retry remain required |
| Native image output registration | Nine checks passed, 66 assertions; native types, lint and docs passed | `.cache/v2-validation/resume-image-output-schema-frozen.json`; the original bundled registration graph reproduces the missing-schema error before the fix. The existing plugin API's string validator preserves exact original text and publication metadata and rejects numeric output. A draft Effect codec exposed a cross-bundle `Symbol()` conversion failure and was replaced; both failed attempts remain recorded. Worker execution, credentials, publication and cancellation are unchanged. Compiled acceptance remains required |
| Candidate 23 native artifacts | Built; all inputs verified | `.cache/v2-validation/stage-d-native-build-23.log` and `stage-d-23-linked-input-diff.json`; build ID `8273448bf95353295b0a53f75ed58d2a368ae9f2834792e1ae709b5c9803fa4a`, manifest SHA-256 `c6549dbac36b3d2c9d36aecb10a825042ebd8bf47815a02f45d7ed3d7031f6e0`. All 4,662 input entries/4,660 unique paths match; only the image registration changed from candidate 22. Full compiled package qualification is running |
| Candidate 23 full package | Failed after 56 passed cases | `.cache/v2-validation/package-QL2U3t/result.json`; original image generation, one native OAuth refresh, account switching, versioned publication, physical cancellation/termination without publication, and four personal-skill checks pass. Native call `native_personal-support-0` then fails with `native_read_root_denied` while reading the first skill support file; the browser lane was not reached. Source cohort unchanged and cleanup clear. No journal or Error Log UUID was available; the empty gap check is retained without a journal-coverage claim. Skill-resource diagnosis and later lifecycle checks remain required |
| Historical UI screenshot review and mobile geometry | All 153 retained PNGs inspected; mobile sweep was not reached | `.cache/v2-validation/stage-f-wire-g1-build7-visual-review.json` and `resume-mobile-geometry-evidence.json`; no blocking desktop visual defect demonstrated. The failed mobile cell stopped at the earlier Plan assertion before emulation, so its 23 desktop-sized captures do not qualify phone layout. The first mobile sweep now asserts exact viewport width/height; eight owning checks, lint and diff checks pass. Existing native Electron bounds evidence verifies requested sizes for all four Electron cells. Final mobile, Settings and complete UI reruns remain required |
| Reviewed skill support metadata | Three graph/guard checks, three owner checks and one helper check passed; types/lint/docs passed | `.cache/v2-validation/resume-skill-resource-frozen.json`; retained before evidence records native read permission followed by Slim's preliminary stat refusal, before direct read admission. The corrected Node owner allows only verified snapshot files for native `read` stat/realpath; hash, size, canonical path and fresh authority checks remain. The final source graph uses a normal one-time native external-directory approval and returns exact support bytes. Its direct ledger callbacks are fixtures; the assembled package must still verify those callbacks and the complete skill inventory. All six changed files are outside candidate 23's linked inputs; `stage-d-23-resource-retry-input-check.json` verifies the unchanged artifact inputs and lock |

| Candidate 23 independent current-source checks | 47 source-native cases, source TODO continuation and seven compiled Cursor cases passed | `.cache/v2-validation/stage-d-23-independent-verification.json`; exact source digest `d46491294ec7255dd7177458e01120fdbf759e476827ff13db7f67d637613b86` is unchanged across these runs. Source-native records 41 publication receipts and 106 verified terminations. TODO records matching before/after source and artifact hashes and three fulfilled cleanup operations. Compiled Cursor records actual confined termination for Stop, crash, normal execution and title work; both controller exits retain observation availability, with no diagnostic gaps or cleanup failures. No fixture journals were present; the empty gap check does not establish journal coverage. These are separate source-native and compiled external-Cursor claims; the full assembled package remains required |

| Candidate 23 supporting-file retry | Failed after 81 passed cases; fixture expectation diagnosed | `.cache/v2-validation/package-3fptvr/result.json`; first ten support reads and nineteen skill invocations passed. `native_personal-support-10` completed, preserved its original file-content assertion and reached its real continuation/idle; the helper nevertheless waited for a permission request. This file is inside selected `launch.global.config`, which the original SDK's agent rule already allows. Earlier external home support files correctly prompted; prior `once` replies did not persist grants. The correction must distinguish exact canonical config containment while keeping strict external request/approval and no-pending checks. Source cohort remains unchanged and cleanup is clear. No fixture journal or Error Log UUID was available; the empty gap check is retained without a journal-coverage claim. Remaining skills, browser/document and lifecycle lanes were not reached |

| Twelfth full validation | Passed all mandatory checks | `.cache/v2-validation/stage-d-validate-full-12.log`; workspace lint, type checks, documentation and deterministic suites passed, including 6,069 web tests across 493 files and 4,027 UI tests across 586 files. This pass covers the resource metadata and observation fixes; it precedes the fixture-only config-directory permission expectation correction. Final validation after the remaining corrections and actual UI/performance qualification is still required |

| Config-directory support permission expectation | Seven focused checks, lint, syntax and diff checks passed; independent review clear | `.cache/v2-validation/resume-skill-permission-expectation-frozen.json`; the helper canonicalizes the selected config root and uses component containment, with config, external-home and prefix-neighbor cases. External reads require the exact session/call and `external_directory` type before a once-only reply. Explicit config-contained reads require no matching pending request after completed continuation. Existing cross-location denial and raw database/source-byte checks remain. All three changes are fixture-only and unlinked; `stage-d-23-permission-retry-input-check.json` independently verifies their hashes and all 4,662 candidate inputs. Full compiled verification is running |

| Candidate 23 complete integrations and later replacement | Failed after 101 passed cases | `.cache/v2-validation/package-Sl2goO/result.json`; complete skill bodies/resources, original browser, document listing/bounded reads/offset reassembly/DOCX/search and tracked controller replacement pass. After the initial compiled TODO write completed, the following replacement lane hit `migration_pending_input_unsupported`. The checkpoint refusal remains under investigation; source cohort is unchanged and cleanup is clear. No fixture journal or Error Log UUID was available; the empty gap check is retained without a journal-coverage claim. Later TODO replacement, removal, rollback and parent-death checks remain required |
| Fresh application build 8 | Build, bundle check, Electron packaging and native dependency smoke passed | `.cache/qa/stage-f-build8-prepared-pRPo65/prepared.json`; new immutable UI copy and package agree on SHA-256 `f3eee83b0025e095953c68605014a9c5d178d24e25bb33fd6dd7e2c73ad26c2f`. Source and runner hashes are unchanged through preparation; all 4,662 candidate 23 inputs and portable artifact checks pass before and after. Electron 41.2.1 SQLite and PTY smoke checks pass with settled processes. All fourteen fixture UI cells and four actual-backend journeys are held until package qualification clears |

| Owned queued continuation at bundle resume | Product defect reproduced; correction in progress | `.cache/v2-validation/package-Sl2goO/result.json`; the single queued user message exactly matches the durable native TODO continuation and its canonical source turn, selection, generation and text hash. `session_pending` is empty. Bundle verification rejects the inbox before spawning the replacement controller; the next harness check would also reject the reserved message ID as absent from committed history. The correction must prove each existing owned continuation during native resume and scope reserved references to exact validated provider-recovery fields. Preparation/import/rollback checks remain strict, and fresh recovery authorization remains the only execution authority |
| Candidate 23 final fixture-source independent checks | Source-native 47, source TODO and compiled Cursor 7 passed | `.cache/v2-validation/stage-d-23-independent-verification-retry2.json`; all runs retain source digest `2740d1d92cedbe18d32c57513dd4efb2484d866a908a821706c86969073999c6`, settled receipts and clean cleanup. Both compiled Cursor controller exits retain observation availability; no diagnostic gaps were recorded. Source TODO does not exercise the selected-bundle verifier, so this pass does not resolve the separate package failure |
| Thirteenth full validation | Interrupted; incomplete | `.cache/v2-validation/stage-d-validate-full-13.log`; required earlier suites and all 4,027 UI tests completed, but the run ended after the web suite started, without its final result or an overall exit status. The runner and log-writing processes were no longer present when work resumed. This is not a full-validation pass; a fresh run is required after the bundle correction |
| Exact owned continuation at selected-bundle resume | 165 focused, eight migration and five durable-continuation checks passed; independent review clear | `.cache/v2-validation/resume-bundle-focused.log`, `resume-bundle-migration.log`, `resume-bundle-primary-capture.log` and `resume-bundle-retained-proof.log`; the initial failing regression and the retained package database establish the same defect. Bounded existing recovery records prove queued and pre-dispatch reservations through native schemas, canonical source turns and the shared admission fingerprint. Exceptions apply only to exact continuation fields in the unchanged owning file; missing or changed files, database changes, competing input, wrong ownership and pending native effects refuse. A committed same-session user retains existing capture behavior. Strict migration/selection/rollback refusal remains. Native types, lint and documentation pass. Fresh compiled replay and full validation remain required |
| Candidate 24 native artifacts | Built; all inputs verified | `.cache/v2-validation/stage-d-native-build-24.log` and `stage-d-24-input-verification.json`; build ID `237d64cf4585c9a6a923e1b2153e03d8eb28cb7428cd7f9dd680c9904cacdb31`, manifest SHA-256 `1167065195183a3bcbe26bd7e3d45d8cbb584b99025b36eb405cc513ef080f61`. All 4,662 linked input entries and the eleven frozen correction files match. The reviewed full package run uses the complete retained skill inventory and browser lane |
| Candidate 24 compiled lifecycle | 106 cases passed; final parent-death probe failed before its tool started | `.cache/v2-validation/package-N3aU8z/result.json`; queued TODO continuation resumes with the same ID, one continuation budget and an actual assistant acknowledgement. Subtree removal, removal restart, complete candidate retention and selected legacy rollback also pass. The final probe's child report, `package-ONqG3f/result.json`, records `native_configuration_binding_mismatch`: its non-reviewed path omitted the isolated snapshot constructor and reached the production configuration-binding guard. Both source cohorts are unchanged and cleanup failures are empty. Neither fixture has a diagnostic journal or Error Log UUID; empty gap checks do not establish coverage. The shared baseline fixture correction is under focused verification, with final full qualification still required |
| Baseline fixture binding and actual parent death | Corrected; actual compiled parent-death check passed | `.cache/v2-validation/resume-parent-baseline-frozen.json` and `parent-baseline-3HnBaI/result.json`; the shared non-reviewed package branch now uses the existing snapshot constructor with cloned loopback data, preserving manifest/source checks and avoiding ambient configuration. Independent review, syntax and lint pass. The focused run killed only its owned Node parent; both controller and worker receipts prove confined cancellation with exit 137, all seven descendants and the owner are absent, the registry is empty, and the unpublished output remains absent. Compared source files are unchanged through the run. The one fixture file is unlinked, and all 4,662 candidate 24 inputs still match. This focused pass does not convert the earlier full package failure into a pass |

The twelfth full validation covers an earlier frozen stage D product tree. Compiled
startup, complete effective behavior, and live provider routes remain separate
gates; these focused source results do not establish integration parity.

The restart review also identified an unqualified lifecycle path beyond owned
TODO/collection continuations. An ordinary primary or fallback prompt can remain
queued without a committed user/assistant after a crash. Current bundle startup
refuses that input, and the existing explicit continuation requires a settled
assistant; durable `needs_attention` status alone is not a completed recovery
path. Generic startup replay is blocked, but a later session wake can promote
queued input before the primary-step gate. Therefore neither blanket startup
relaxation nor the narrow owned-continuation correction establishes safe
inspection, cancellation and explicit recovery for these cases. Assembled
ordinary/fallback queued-crash coverage and any necessary correction remain
required before the recovery lane qualifies; this limitation is not an accepted
intentional parity difference.

The correction uses a startup inventory and a per-session fence in the existing
native owner. Retained input stays visible without an existing transcript or a
watchdog. Its full text and attachment descriptors load only on inspection;
explicit Resume and Discard bind the same message ID, payload hash and inventory
revision. The UI passes 16 focused tests and 62 assertions, with lint and exact
file/evidence hashes retained in
`.cache/v2-validation/recovered-input-ui-frozen.json`. This is source evidence;
shared types, compiled owner integration and visual checks remain outstanding.
The new assembled lane creates actual native queued inputs, loses their real
HTTP response or cancellation acknowledgement, replaces the controller and
requires exact recovery without duplicate inference. It has not yet run on a
new compiled artifact.

### E. Remove duplicate work and measure improvements

Correctness and plugin parity come first. Reuse native streaming/context/compaction where it removes actual duplicate work:

- Replace orchestration poll-driven waiting with event wakeups and bounded reconciliation, retaining existing timeout, cancellation, retry and restart behavior. Remove redundant polling only after missed-event tests pass.
- Use stable tool/instruction prefixes and native generation phases; keep volatile task state in bounded results/compaction anchors. Preserve role prompt semantics. Native transport owns physical retries; DevRyan owns durable objective recovery.
- Attribute current Git subprocess/materialization costs before optimizing them. Start with demonstrated redundant reads and batching of immutable ledger reads. Re-measure after each change. Preserve CAS, receipt durability and recovery ordering.
- Defer unrelated provider/project initialization only if startup CPU or latency improves without unacceptable first-prompt cost. Keep native warming off for parity; test it separately with all request/token costs included.

Do not pre-commit to warm view pools, in-process writes, extra workers, receipt group commit or an instruction registry. Add one only if a current trace demonstrates the need and the smaller correction fails.

Measure v1 versus unoptimized v2 for the upgrade, then same-v2 before/after for each optimization. Compare identical fixture/model/effort/setup and retain failed attempts. Record local admission, preparation, execution, termination, publication, continuation and UI latency separately from actual provider TTFT and generation TPS. Report known cache-read tokens / compatible total-input tokens with coverage; report request-hit rate only where attempts are individually observed. Include helpers, retries, titles, specialists and compaction.

Local matrix: idle, one stream, four streams, long history, 1k/12k-file tools and repeated eight-call bursts. Use three paired launches and enough completed operations to estimate per-run distributions; preserve the existing target of at least 100 completed operations per scenario, arm and launch, without pooling workloads. Compare the median of three run-level p95 values for latency, run medians for burst duration, and completed operations per elapsed time for throughput. Report p50/p95, total successful-task duration, subprocess counts, process-tree CPU, peak/settled RSS and event-loop delay. Derive upgrade nonregression bands from baseline repeatability before seeing candidate results. Predeclare per-optimization retention thresholds as well, using the measured cost attribution and resource budget. Three live pairs provide medians/ranges, not credible p95 estimates.

**Exit:** measured improvement in the identified pain points, no unexplained resource regression, and removal of unsuccessful prototypes. Performance absence is recorded as unavailable, never inferred from a fast spike.

### F. Qualify the saved graph in web and packaged Electron

Use isolated repository-owned homes/data/workspaces and owned provider proxies. Resolve diagnostic journal details and run the gap check for failures. Never stop the user's app or Docker Engine. Paid provider usage is authorized; authorization does not make expired access usable or a substitute route equivalent.

| Acceptance lane | Required evidence |
| --- | --- |
| Deterministic/build | `bun run validate:full`, `bun run build`, `bun run bundle:check`; all mandatory checks on the final tree. |
| Native boundary | Real launcher confinement/termination/publication, permission correction, startup recovery, Revert/Redo, deletion and completion races on every supported release target. Missing platforms/signing remain unavailable. |
| UI fixture | Both generations through the same feature matrix; web and packaged Electron screenshots, interaction and streaming/reconnect/history checks; inspect every retained PNG, both themes and representative desktop/mobile web widths, plus actual packaged native window geometry. |
| Orchestrator Plan | Three successful runs per host: read-only planning/children, saved plan revision, reload, approval→implementation, independent result verification and exact task disposition. |
| Orchestrator normal | Three successful runs per host: natural specialist routing, parallel ownership, questions, completion collection, verified final work. |
| Saved roles and Council | Every actual role/model/effort; Builder Plan and normal; global and project Council precedence and members. Backup outcomes reported separately. |
| Plugins/skills | Applicable hooks/tools for every active plugin; complete skill body/resource checks; safe browser/document/image/development examples. No payments, publishing or infrastructure changes. |
| Long context | Orchestrator Plan and normal on both hosts through two manual and two natural compaction boundaries per mode, with pending children and saved-plan continuity; Builder TODO continuity. Native trigger reason/context-estimate evidence is required before the v2 natural-compaction oracle can pass. |
| Recovery/lifecycle | Provider failure/auth expiration/backoff, permission denial, abort during inference/tool/child work, new input/steering while busy, stable-message-ID replay with changed text/files/tools/metadata, reconnect, restart, location-idle timeout, reload and Electron reopen. No duplicate work, lost results or orphan processes. |
| Managed authorization | Password-free agent-test users: ownership, private paths, revocation, archived/deleted/provisional sessions and SSE/WS filtering. Single-user success does not establish this lane. |
| Migration/rollback | Consistent bundle copy, interrupted import/activation, candidate-created sessions/children/edits, rollback with new work preserved, correct ledger reconciliation before further admission. |

Natural compaction boundaries must come from native lifecycle/context-estimate evidence, not fixture events. Keep every failed attempt in the cohort; repeated successes do not erase an unresolved mandatory failure.

Use one evidence table keyed by source/runtime/config/plugin hashes, host, scenario, actual route and attempt. Each row is **passed, failed, unavailable or not run**, with assertions and safe evidence links. “Settled”, “catalog present” and model-written test claims are insufficient. Compare exact declared plugin migration hashes; never ignore every plugin hash to make paired results match. Finish the cross-generation benchmark comparator separately from same-generation optimization comparison.

### G. Activate only the verified candidate

Selection must atomically switch one prepared bundle descriptor/pointer identifying the compatible runtime, configuration, native database and harness state. Copying multiple directories is preparation, not atomic activation. Keep the untouched v1 bundle selectable and preserve the entire v2 bundle on rollback. Rollback is selection/reconciliation, not reverse migration, and must not discard published workspace edits. If their ownership cannot be safely reconciled, admission stays closed.

Before promotion, assemble the final acceptance report, supported-platform evidence, performance comparison and migration/rollback record. Review any intentional behavior changes explicitly. Broad installed-app cutover and public release remain separate from candidate preparation.

## How to execute the remainder

Root owns integration, shared contracts, the evidence table and final review. Use GPT-6.1 Sol/high workers with disjoint file ownership for runtime boundary, native plugins and QA after stage A's shared contracts are stable. A reviewer who did not implement a boundary should run its adversarial acceptance. Keep validation centralized to avoid redundant full-suite runs, and rerun only after relevant changes or diagnostic evidence.

Earlier stage results are historical checkpoints. Current work follows the eight
October 4 corrections and the completion gates at the top of this document.
The upgrade is complete only when the final candidate passes functional and
performance qualification, the saved graph works on both hosts, and the
migration/rollback rehearsal preserves user work. Missing live access and
platform evidence remain explicit dependencies.
