# OpenCode 2 native verification scripts

Contract notes for the compiled-package qualification run by `node scripts/verify-opencode-v2-package.mjs`. Commands and the build step are in [QA](../../docs/QA.md#opencode-2-compiled-package); the case implementations live in the lane modules in this directory (`package-*-lane.mjs`) and in `scripts/verify-opencode-v2-package.mjs`.

The acceptance source cohort also pins the attended QA receipt-to-idle/UI
measurement owner and its transitive interactive, lifecycle and stable fixture
helpers under `scripts/perf`. Editing those owners invalidates the same frozen
source proof as editing the QA driver or provider grader.

Ordinary native tool prompts read and explicitly submit the exact active root
session's canonical selected agent. Omitting the agent preserves the runtime's
implicit primary-admission opt-out and cannot establish the objective proof
required by native Plan policy. The compiled package refuses such admission, and the fixture correction does not weaken policy.
Both relocated tool roots are created with the source-configured primary after
checking their actual native catalogs, then enrolled against their own location.
The fixture binds accepted prompt receipts to that enrolled location and rereads
the canonical selected agent on every invocation, including reviewed setup.

## Compiled package lanes

`node scripts/opencode-v2-native/package-managed-interval-lane.mjs --artifact-root
<fresh-native-artifact-directory> --long-wait` runs one isolated compiled arm
with a 65-second child hold. It requires one initial control claim/publication,
at least two published-lease reattachments, successful canonical tool completion,
and a flushed journal with no `devryan_task` errors or gaps. The controller,
scheduler and execution ledger are real; the loopback provider is synthetic.
The run cleans its private profile on every outcome and never uses installed
accounts. Without `--long-wait`, the existing interval comparison is unchanged.

`native-stream-continuation.graph.test.ts` runs the real pinned 2.2.1
publisher, retry loop, Synthetic bus and Step with production constructor
owners against disposable loopback provider fixtures. Run it with
`bun test scripts/opencode-v2-native/native-stream-continuation.graph.test.ts`.
It covers fail-after-output continuation with Slim disabled/enabled, plain
Retry, Stop during publication, two continuations and the third physical-send
veto. Its default suite includes both source graph bundles and an actual Bun
compiled executable; a bundled `.mjs` alone is not compiled-binary proof.
Separate source and compiled silence cases leave the HTTP response body open
after output and set only the fixture request's original `chunkTimeout` to
250 ms. They require native `Transport` / `Timeout` / operation `read` and
observe `retry: true` after output before the constructor restriction. They do
not qualify live provider latency or change production transport defaults.
Source and compiled denied-tool cases first call an advertised native patch
tool under canonical Plan restrictions, require its durable `never_started`
receipt and absent target file, then interrupt a later output stream. The real
retry, Synthetic and successor Step must complete exactly one continuation.

The five native output-start setter fixtures include empty starts. A narrow
fixture-only LLM delivery seam in our constructor module supplies raw events
that the HTTP adapter otherwise normalizes away; native publisher/retry/Step
code is unchanged. Set `DEVRYAN_NATIVE_STREAM_COMPILED_SETTERS=1` to execute all
five setter cases as native binaries too. Reviewed workspace dependencies are
resolved outside Bun build callbacks from declared package manifests and the
frozen lock; undeclared/missing imports and captured native closure imports
retain their strict failure behavior. Fixtures delete their runtime roots on
completion and never access installed-app state or live credentials/providers.

Package qualification uses the compiled controller and writer with the real
web admission owner, scheduler, ledger and supervisor. Only HTTP model responses
are fixture data. Separate assertions cover asset initialization and full server
execution while the supervisor denies reads of the repository's `packages`,
`scripts` and `node_modules`. The importer works on consistent disposable copies,
with relocated projects and private configuration/data roots. The runtime payload is deleted on pass (`--keep-artifacts` /
`DEVRYAN_KEEP_ARTIFACTS=1` keeps it); `result.json` and logs are retained, and
failed attempts keep everything, under `.cache/v2-validation/package-*/result.json`; incomplete
mandatory lanes, changed source or incomplete cleanup keep the exit nonzero.
This command does not activate a bundle in the installed app.
The Darwin ARM64 ripgrep fixture comes from the frozen Bun install's
`@cursor/sdk-darwin-arm64` package, with its exact SHA-256 asserted before use.
Qualification never depends on a previous QA run's cached executable.

Historical upgrade profiles are created by their own unchanged released apps in the
GUI lane; the compiled lane never admits an old source-only asset as a new current target.

Every compiled host (the package process, each fresh lifecycle driver and the
parent-death owner) also writes the production web diagnostic journal into its
descriptor's `web-data/harness/journal`; the in-memory diagnostic arrays are a
tee of the same records. Case `compiled-durable-journal-roots` grades the
selected candidate, the baseline and the SIGKILLed parent-death candidate, and
passes only at 3/3. A missing root or one without chunks is unavailable, never
passed. A present root needs sealed chunks (the parent-death root is sealed by
the next owner's journal recovery), at least one `lifecycle` record, an empty
`node scripts/journal.mjs --dir <root> gaps --verify` run recorded under
`package-*/journal-gaps/`, and every record reconciled to the writer that
accepted it. Case `compiled-seeded-credential-first-boot` prepares a fresh
initialization whose `native-setup-credentials.json` (one fake API key) is
present at first boot, then proves the controller started, unlinked the seed
after stamping its digest, restarted, and holds the imported credential.

`package-recovered-input-lane.mjs` also requires
`compiled-first-prompt-stop-zero-edit-revert`: a real accepted first prompt
reaches a stalled loopback provider without admitting a tool. The owned Stop
must terminate that request; native Revert must succeed with zero restored files.
The compiled controller then restarts and completes exactly one subsequent send,
with no active execution leases and gap-free session journal evidence. This uses
the production inbox, prompt-boundary ledger and conversation coordinator.
The same lane requires `compiled-edit-revert-next-send-restart` and
`compiled-managed-tree-revert-next-send-restart`. These perform real file edits
in a root turn and in a managed child, respectively, commit Revert, submit a new
parent prompt and restart the controller. The restored file, retained current
history and absence of active leases must survive the restart, with exact ledger
proof for the clipped old root references.

## Upgrade qualification against a retained baseline

Bundle A then runs the baseline controller and bundle B the candidate. Clones
cover both reviewed source layouts:

- **Legacy.** The main lane imports the legacy fixture, which keeps
  `__drizzle_migrations`. Case `compiled-clone-layout-legacy` checks it.
- **Fresh install.** A separate control root under `fresh-install-upgrade/`
  starts from the production empty source, as every real 2.x install does: a
  zero-byte `empty.db` with no legacy journal and an identity workspace map.
  Case `compiled-clone-layout-fresh-install` checks it. The baseline importer
  and controller create and run A. Then:
  - `compiled-fresh-install-clone`: the clone gate admits the A→B clone of the
    closed database. The clone captures A's credentials through A's own
    controller, which may drain pending WAL frames into `opencode.db`. So this
    case compares A's database by schema and rows, and every other file byte
    for byte. `sourceWalCheckpointed` reports whether a drain happened.
  - `compiled-fresh-install-rollback`: B's controller runs its own work, then
    rolls back. A's original controller receives B's credentials. A's history and
    migration IDs are unchanged, and A's controller restarts the rolled-back
    database.

The exact reviewed layout and release pair are asserted only when the versions
differ. A same-release run checks only that each kind has or lacks the legacy
journal, and its gate result says so.

Fresh selected-lifecycle inspection keeps a 120-second absolute fixture limit.
Rollback has a 240-second absolute limit for two cold starts, inspection,
checkpoint, repeated real credential capture/projection and retention checks.
Completed native startup phases do not reset either deadline. Content-free
`native-lifecycle-phase` markers identify the active artifact, startup,
inspection, rollback credential, retention or cleanup wait; exit evidence records
the chosen limit. Product-owner timeouts and release smoke deadlines are unchanged.

The pending-intent crash probe watches the owned rollback directory and also reads the exact intent every 50 ms within its existing 45-second deadline. Coalesced filesystem notifications cannot hide publication. Only the original validated intent and exact host identity authorize the crash; completion, close and failure stop both observation paths.

The migration fixture contains two independent relocated Git projects, exact
conversation/tool IDs, compaction dispositions, attachment bytes, ordered
permissions, and separate web/native configuration trees. A lost import
acknowledgement must recover from the real persisted importer receipt on an
exact preparation retry. Rollback first quiesces the actual candidate; its
synthetic-copy reconciliation requires unchanged independent baseline roots
and retains the complete candidate and project work. The selected baseline
then launches the accepted generation-one companion through the production
lifecycle, with offline model fetch and automatic update disabled, and reads
all fixture sessions through real HTTP routes.

The package also exercises the configured command executor, native manual
compaction, formatter subprocess, per-location read boundaries, and a tracked
primary background notice resumed after controller replacement. The latter
requires the original objective and saved selection, a fresh runtime handshake,
exactly one canonical continuation, and another real writer after replacement.
The separate parent-death fixture explicitly submits the root's canonical agent
so its new probe prompt owns the primary objective. It waits for a real confined
shell, kills only its owned Node process, and checks every observed descendant
plus both real
controller and worker termination receipts before requiring no publication.
The real-tool readiness budget is five minutes because it includes cold sealed
bundle provisioning. Once the owner is killed, receipt and descendant checks
retain their separate fifteen-second deadlines.
Its explicit constructor-owned local grant is smoke-test policy; it does not
substitute for production authentication contract tests. Release signing and
other-platform support remain separate qualification gates.

Use `node scripts/verify-opencode-v2-package.mjs --diagnostic
--retained-shell-diagnostic --artifact-root <verified-artifact-root>` for a
focused compiled shell replacement run. It retains the same exact consumption,
physical execution and second-replacement assertions, and leaves full package
qualification mandatory. Bounded typed admission/provider refusal codes for
that fixture's exact session are teed into the production diagnostic journal;
exception messages, RPC payloads and stderr are excluded.

## Synthetic provider catalog preflight

Preflight also seeds active synthetic OpenAI, Cursor and GitHub Copilot
credentials through the baseline's compiled SDK, preserves them across the
clone, and asserts their model rows in both locations on both releases.
Copilot discovery uses a fixture HTTP server restricted to loopback;
no external credential or provider is used by this check.

`native-plan-policy.compiled.test.ts` runs native Plan admission, permission
translation and canonical-source policy functions from source and a compiled
Bun executable using reviewed disposable inputs. It proves those function
contracts only; it does not qualify the real SDK Plan-to-Implement lifecycle,
managed writer execution, restart/recovery, Revert/Redo or visual acceptance.

`native-result-publication.graph.test.ts` qualifies managed result delivery with
the actual pinned native graph in a source bundle and a compiled Bun executable.
Its loopback provider first attempts a same-Step continuation, then reads the
canonical result page and continues from a later native Step. It checks the
durable acknowledgement identity and exact completed tool output. The fixture
uses disposable inputs and an explicit constructor-owned local role grant;
production admission scope/race tests remain separate. This is deterministic
publication qualification, not live provider or packaged application evidence.

`package-model-title-lane.mjs` enrolls its fresh root through the existing
constructor-owned managed fixture before submitting an `origin: human` source
prompt. Enrollment grants fixture ownership only; native accepted input, Step,
provider completion, model-derived title, single rename/outbox and replacement
restore remain mandatory. The lane refuses a missing enrollment callback.
Its second root human session retains a real compiled model candidate after one
fixture refusal before native rename. The existing controller replacement must
restore that exact pending outbox/source through fresh native admission, rename
once, and clear the outbox without another model request. This extends the same
case ID; the original package cases remain mandatory. It does not authorize stale
delegated title proofs, whose controller-change refusal remains a separate test.

`package-plan-implement-lane.mjs` is the focused actual application acceptance
lane. It requires a current verified native artifact under `.cache`, current
web dist, installed Electron, and the normal macOS confined-execution
prerequisites. Run `node scripts/opencode-v2-native/package-plan-implement-lane.mjs
--artifact-root <absolute-artifact-root>`. The runner uses a disposable
`.cache/v2-validation/native-plan-implement-*` run because its
application child reads leases through repository-pinned readers; an in-memory
OS scratch scope cannot cross processes. Normal run cleanup removes it unless
artifact retention was requested. Its constructor-only loopback model
uses a larger context budget for the full packaged Orchestrator instructions;
the normal UI fixture default remains unchanged. Its private saved helper setting
uses only the declared loopback model with Default reasoning. The responder
accepts title inference only for its known delegated child sources without tools;
real accepted-source authorization and native rename remain product-owned.
An owned CDP browser clicks
the enabled latest Plan Card. A finite downstream transport cut retains a real
Plan prefix and omits its terminal stop/DONE packets once; the actual native
owner must create the continuation successor and complete its heading-free
tail before the revision can become current. The browser remains open through
continued/incomplete Plan, approval, dispatch/results, partial/recovered outcome,
restart, Revert/Redo and helper-settings captures. Each checkpoint uses the real
appearance control in both themes at 1280×800 and 390×844. Mobile proof
enables touch, selects the
actual mobile Chat tab and verifies the target stays within the viewport without
horizontal overflow. Results use exact task/message identities so an older Plan
above the fold cannot count as an outcome capture. The model fixture ignores only
the native background-board presentation when selecting its known user request;
unrelated later user messages remain refused. Enabled approval captures precede
one 25-second live inspection pause within the existing overall deadline;
visual failures cancel the owned application rather than stall its provider.
After the final capture, a Plan-only private IPC checkpoint settles capture and
approval work, then physically stops the owned browser and removes its profile
before acknowledging application shutdown. Failure still attempts browser
cleanup and cannot acknowledge settlement. Parent-finally cleanup is idempotent.
The driver then awaits the normal production cleanup and must exit naturally
with code zero inside the unchanged 480-second lane deadline; an emitted
successful application result alone cannot qualify the lane.
After the owned host exits, an independent cleanup step scans its drained journal
within the existing cleanup deadline and writes `plan-journal-coverage.json`
before profile pruning. Qualification requires complete, nonempty coverage and
zero explicit or manifest gaps. The retained summary contains finite counts and
fixed gap/error codes only; deliberate error records remain counted and do not
by themselves fail this gate. Capture or evidence-write failure refuses the
lane while preserving its original failure and attempting the other cleanup.
The runner never
creates an Implement marker; it independently verifies the actual canonical
accepted source/version. Native root/child tool restrictions, writer leases,
termination receipts, exact checks, restart/history, retained partial check
failure recovery and tree Revert/Redo are verified through product owners.
Scoped Revert/Redo captures reload the canonical conversation and verify the
reverted suffix is absent, then restored. File-only Undo/Redo controls belong
to a separate session-change owner and cannot stand in for scoped restoration.
The file-only Undo checkpoint clicks its exact enabled confirmation dialog before
requiring the real card's Redo state; Redo dispatches directly. A cancelled,
ambiguous or unrelated dialog cannot qualify the file-restoration checkpoint.
Positive file-restoration screenshots recheck the exact enabled card after each
theme, viewport and tab transition; pending loading or button paint cannot
qualify. A displayed summary-read failure fails the capture without automatic
Retry. Bounded `session-changes-network.json` evidence retains only this owned
session's changes-route kinds, request IDs, directory-match flags, status codes
and timing, never bodies, raw URLs or headers. The helper save uses the existing
desktop DIV trigger and responsive mobile button, derives its model label from
the live exact catalog tuple, and reselects the unique current row in that
trigger's own menu. HTTP acknowledgment, fresh fallback revision, enabled
controls and exact persisted provider/model/revision after reload remain
mandatory. Before the helper capture, the exact captured menu must be closed
(`aria-expanded=false`), absent or fully nonpainted, and free of running/pending
closing animations; two animation frames recheck that same menu. Reload arms
the owned page-load waiter before navigation within the existing phase deadline.
The new document then supplies hit-ready Settings, Open Sessions, or hydrated
settings navigation; rect-only controls in closed drawers and the old textarea
cannot establish fresh shell readiness. Navigation uses those existing controls,
including opening the responsive session sidebar when necessary.
Synthetic responder/transport unit tests do not qualify this lifecycle.
The later retained actual lane passed all 60 captures and helper HTTP save/reload
checks on unchanged source; synthetic application acceptance does not qualify paid helpers or release assets.

`node scripts/verify-opencode-v2-native.mjs --plan-only` runs the source SDK
invocation-fence subset with real native tools/processes: write/edit and shell
write/delete/rename are denied in canonical Plan mode, confined inspection
succeeds without changed files, and a fresh writable objective publishes. Its
remaining full writer/recovery gates stay explicitly reported; it does not
replace the compiled application/UI approval lane.

The wire-only `fixture-host-facade.mjs` refuses Plan revision operations with
`qa_fixture_plan_authority_unavailable` (409). Synthetic transport IDs have no
native controller/primary/lease settlement authority, so that facade cannot
persist a successful Plan or qualify approval. The real application lane owns
that acceptance.

## Focused V2 compatibility regressions

`native-queued-input.test.ts` uses the original native database/projector/inbox
for an idle root and child with a busy or retry-suspended grandchild. It retains
one human queue ID through blocked delivery and an unavailable ancestry wake.
`native-compaction-checkpoint.graph.test.ts` exercises original committed
provider-window history across provider and model changes;
a different provider/model restores the local transcript without destroying the checkpoint.
It does not claim a physical provider compaction run.

The provider middleware graph checks exact ordered instruction blocks at the
actual transport in both locations and preserves GPT high-effort sampling
omission. A fiber-local token-sharing metadata seam checks native compaction
buffers of 0/12,000 over legacy 7,500 through the actual controller catalog,
without changing physical browser authorization; it does not qualify an actual
token-sharing credential flow. The controller webfetch graph starts a helper before any catalog route,
uses the shipping configured-instructions plugin for supported compatible-chat
zero sampling/top-p, and holds a real native cancellation finalizer before the
production helper route can acknowledge settlement. The compiled helper isolation
lane also requires actual compatible-chat sampling bytes; its receipt cannot
replace the full compiled package qualification.

## Explorer model admission acceptance

`node scripts/opencode-v2-native/package-managed-model-admission-lane.mjs --artifact-root <absolute-native-artifact-directory>` runs two private compiled arms with a synthetic loopback provider and its exact `low`, `high`, `max` reasoning variants. The Low arm requires one completed Explorer child with its real native parent relationship. The Medium arm requires the parent-visible actionable tool error, a correlated and flushed `variant_missing` diagnostic, zero durable tasks and zero native children. Each arm retains the existing compiled artifact/source identity checks and run-root cleanup. `--keep-artifacts` retains evidence explicitly. This narrow acceptance does not replace full package qualification.

Archived-session deletion has a focused compiled qualification:
`node scripts/verify-archived-session-removal.mjs --artifact-root <compiled-artifact>`.
It creates three real queued inputs, replaces the controller to establish their
recovery fences, archives them alongside two held deletion preparations, and
removes all five through the public client. It asserts no retained input ran,
all native conversation/input rows disappeared, and an active control session
and published project file survived. `archived-removal-passed` qualifies this
lane only; it does not stand in for full package qualification. Inherited bundle
ownership and invalid checkpoint proofs are covered by the removal owner tests.

## Reviewed Claude upgrade qualification

The held reviewed capture now targets plugin 1.11.2/Meridian 1.79.0 with SDK
0.2.141 and the already selected Claude Code 2.1.302. Focused Node suites cover
exact source/hash gates, startup/health cancellation, profile-loader parity,
selected-account renewal and retained checkpoint retry. Bun asset tests cover
the captured closure and resolution graph. Transport gate tests must prove
executor attachment precedes SDK input and confirmed termination precedes
transcript lease release. A raw managed package inside the execution boundary
must refuse instead of invoking upstream's ambient Node process wrapper.
Historical 1.8.0/1.62.6 inputs remain available for corrected-baseline probes;
use the candidate arm for both tuples and preserve strict prefix/history gates.
These fixtures establish no live provider, cache or quota acceptance.

The exact-source owner test runs with all OS identity probes denied: only the
host-attested current worker can acquire its own incarnation, and missing,
malformed or mismatched PID proofs refuse. Foreign identities remain
indeterminate. Native lifecycle GC cannot launch the upstream Node deletion
helper; it retains pending state with an explicit supervision-required refusal.


## Compiled Claude execution gate

`node scripts/opencode-v2-native/compiled-claude-execution.mjs --artifact-root <absolute-private-artifacts>` qualifies the actual compiled provider worker, transformed Meridian, Agent SDK and native Claude executable against a credential-free loopback Anthropic fixture. It requires the final assistant response, then holds an actual model response open, observes an armed nonrecoverable transcript writer lease, cancels, and requires zero active leases and native transport retirement after verified termination receipts. The fixture also answers Claude's observed bounded `HEAD /api/hello` metadata handshake. No account, Keychain or live provider is read. Private scratch is deleted on completion/failure unless explicitly retained with `--keep-artifacts`; `compiled-claude-execution.test.mjs` tests fixture packet and lifecycle inspection contracts. This lane complements the credential bridge, which refuses before SDK acquisition and cannot prove these process-gate paths.
