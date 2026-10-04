# Stage E native v 2 performance preparation

Status: current v 2-only collector and comparator passed focused correctness
checks; fresh calibration and paired runtime measurements remain unrun. Earlier
v 1/v 2 diagnostics below are historical harness evidence, superseded by the
v 2-only source contract. No hardware improvement or nonregression is claimed.

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

The source 8 cache-only handoff
`.cache/perf/r20-source8-stage-e-held-handoff.json`, SHA
`457c66137cdda6acb384b4b445c4ddfbf0da40fcc3571e9205389ad4bc08a903`, reuses the unchanged Node
runner, all seven workloads, six attribution arms, 21 calibrations, 42 paired
launches and frozen budgets. No measurements have run; launch requires a completed scoped local-behavior
declaration and fresh quiet/storage checks. Production remains **750 ms**.
The short diagnostic remains separate: 24 warmup plus 16 measured writer calls,
40 total. It may run only after competing jobs close and fresh quiet-window,
disk/load/free-memory observations and root release; a completed functional
index is not its prerequisite. The full 69-launch cohort additionally requires
all actual source 8 local functional gates and the assembled semantic index.
Live grants, journeys and compaction remain separate requirements.

The pre-performance observation
`.cache/perf/r20-source8-pre-performance-host-observation-1.json`, SHA
`5df2a07c53cfb0dada29877187c3eac04e33a25712d901ae99610180a1316e52`,
recorded about 103 GiB disk headroom and eight CPU cores, with
`mediaanalysisd` at 110.6–172.8% CPU. It approved no quiet slot and launched no
measurement. A fresh quiet observation and explicit release remain required;
that sample does not establish present quietness or a performance result.

After all qualification runtimes closed, the second observation
`.cache/perf/r20-source8-pre-performance-host-observation-2.json`, SHA
`0654b3ab761196e0eec89e135eecfc4ff57d2735549f1d51ff97f52f5854d8ba`,
recorded `mediaanalysisd` at 132.8–147.6% CPU and load near 6 on eight cores from
17:55:41 to 17:56:22 UTC. It also approved no quiet slot and launched no
measurement. Performance remains unrun pending a fresh quiet window and release.

The 36.5 GiB reserve remains a planning estimate, not current disk evidence or a
relaxed bound. Preserve every writer receipt, sampled process identity, grading
rule and failed historical command.

The optional `node scripts/verify-opencode-v2-native.mjs --managed-wake-attribution`
keeps the existing native acceptance and adds six actual managed children in
disabled/enabled, enabled/disabled, disabled/enabled order. Both arms consume
the same authenticated native event stream; enabled arms also feed its projected
activity into the existing managed owner. The observer correlates each canonical
final child assistant with its exact parent wait call. It reports inconclusive
timing if the child finishes before that wait is observed. Actual client HTTP
requests and private bridge RPC calls supply the operation count; the existing
owned process sampler supplies CPU/RSS evidence. The declared threshold is a
100ms median wait reduction with at most 10% resource growth plus the explicit
20ms CPU, 8MiB RSS and one-operation allowances. Missing timing/counts, sampling
failures or processes exiting before sampling prevent a retention claim. This
bounded attribution does not replace the seven-scenario paired upgrade matrix.
Its three synthetic contract checks passed; the actual attribution has not run.

## Available evidence and inputs

- The retained 1.18.33 baseline is documented in
  [the baseline note](../2026-09-30-opencode-v2-baseline/README.md). Its
  `ledger-benchmark.json` used two iterations and three warm calls, plus one
  eight-call burst. Seeded historical receipts are setup, not measured completed
  operations. Those data and live-journey summaries cannot supply three local
  run-level p95 distributions with 100 completed operations each.
- The inspected renderer baseline
  `.cache/perf/2026-09-05T21-38-29-302Z-foreground-resource-r1-four-stream-baseline-1/summary.json`
  is one foreground launch with no runtime fingerprint or native execution
  evidence. It remains renderer-fixture evidence.
- Repository-owned Stage C candidate 5 is
  `.cache/v2-validation/native-artifact-candidate-5/native-bundle.json`, build ID
  `312e762dd877e4c43bd55d46bdc3e970120a2d083f52f8b3dedd87d3c8f0ca44`.
  The retained compiled package result
  `.cache/v2-validation/package-k84goE/result.json` passed 28 acceptance cases.
  This is the earlier C graph, not the final D performance candidate.
- Current inputs must be fresh, verified native 2.0.20 artifacts with linked
  source hashes. Historical candidate pins above do not qualify current source.
  Calibration and candidate use distinct explicit arm IDs, artifact hashes and
  observed configuration hashes. A configuration experiment may use the same
  artifact for both arms; no v1 executable or installed-app data is a fallback.

## Actual native collector and measurement contract

`scripts/perf/native-upgrade-benchmark.mjs` launches only the explicit compiled
2.0.20 controller. Its isolated `performance-fixture.mjs` uses the production
execution host/private bridge, an empty private seed through the existing native
initializer, selected bundle and production runtime owner. Both native arms use
a deterministic loopback HTTP provider, actual tools/transcripts and HTTP/SSE.
Old conversations and diagnostic journals are not imported for acceptance. This
is a declared benchmark profile, not the user's personal setup.

Both observed model catalogs must report the same limits: 1,048,576 context,
1,000,000 input and 4,096 output tokens. This local profile retains the complete
operation history, including the long-history prefill. Any automatic compaction
during an arm fails this measurement. Compaction cost, native trigger thresholds
and continuity remain separate Stage F qualifications; the product's compaction
settings are unchanged. The native fixture enrolls each primary session through
the real managed owner before dispatch.

```sh
node scripts/perf/native-upgrade-benchmark.mjs --plan
node --test scripts/perf/native-upgrade-benchmark.test.mjs scripts/perf/runtime-upgrade-comparison.test.mjs
node scripts/perf/native-upgrade-benchmark.mjs --diagnostic --arm-id baseline --scenarios tools-1k --artifact-root "$PERF_NATIVE_ARTIFACT_ROOT" --output-root .cache/perf/stage-e-v2-diagnostic
# Only after artifact/source/environment freeze: 21 independent baseline arms.
node scripts/perf/native-upgrade-benchmark.mjs --arm-id baseline --artifact-root "$PERF_NATIVE_ARTIFACT_ROOT" --output-root .cache/perf/stage-e-v2-calibration
# Freeze prospective bands and comparison declarations before the paired cohort.
node scripts/perf/native-upgrade-benchmark.mjs --comparison-arms .cache/perf/stage-e-v2-arms.json --output-root .cache/perf/stage-e-v2-paired
```

The repository-owned comparison input is a two-entry JSON array, each with
`id`, `artifactRoot` and optional `eventReconcileIntervalMs`. For an experiment,
use `baseline` and `candidate` IDs with the same frozen artifact and explicitly
pinned reconcile settings. The existing production default is 750ms; passing a
fixture override does not change it. Freeze only the exact observed scalar
`configurationDelta` path `['policies', 'eventReconcileIntervalMs']`, with its
baseline/candidate values. No section-wide normalization is
allowed. Identical configurations require an empty delta. The collector retains
summaries but deliberately reports `not-compared`; explicitly freeze and grade
through the comparator APIs below before claiming nonregression.

The final command makes three fresh pairs in AB/BA/AB order **for each** of
seven declared scenarios: idle, one stream, four streams, long history, 1k-file
tools, 12k-file tools and repeated eight-call bursts. That is 42 fresh arms.
Each active scenario completes 100 measured operations per arm/launch; four
streams divide that quota across four simultaneous sessions. Long history
first completes 100 real historical turns. Three completed warmup operations,
historical seeds, model deltas and setup work never count toward the quota.
Each of the 100 eight-call batches must settle all eight actual writer calls.
Idle submits zero work and records a 30-second observation window with no model
requests; it is reported separately and has no operation quota.

Each completion records canonical user/assistant IDs, terminal time, exact
agent/provider/model/default variant, actual provider request hashes and native
tool results. Writers additionally require the exact call/session/message lease,
terminated/confined process receipt, published operation ID and expected file
bytes. The sampler observes the isolated fixture Node host plus its owned
controller, supervisor siblings and descendants with retained OS start identities.
Host CPU/RSS is counted separately from descendants. A sampling failure for a
still-running exact process identity now fails the arm and comparison, retaining
the partial receipts and resource evidence. Processes that exit between OS
discovery and resource sampling are recorded separately; their unsampled final
CPU remains part of the stated lower-bound limitation. Raw process samples,
event-loop delay, HTTP/SSE hashes, per-operation latency, cleanup and source
cohort checks remain in each arm. Failed arms retain evidence and stop the
cohort; they cannot be replaced inside a successful comparison.
Each arm also records start/end timestamps, OS load averages and available host
memory. These observations describe shared-machine conditions; they do not stop
the user's applications or guarantee an otherwise idle machine.

The collector reports run-level p50/p95, median/range of the three run-level
values, throughput, process CPU and peak/settled RSS. It does not pool latency
samples across launches. OS sampling can miss short-lived children, so descendant
CPU is an observed lower bound. The measured Node host includes the collector
and local provider; completed provider bodies are replaced with their retained
hash/identity rather than accumulating quadratic history copies in RSS.
Startup measures runtime launch-to-readiness before the fixture file grid is
populated; file-tool measurement begins after grid creation, commit and warmup.
No renderer/GPU, Chromium interaction, paid-provider TTFT/TPS or signing result
is inferred from this headless collector.

Each arm verifies the actual benchmark role bytes and selection, and retains the
full observed tool catalog. The comparison fingerprint declares the reduced
`glob`/`write` workload catalog; it does not claim full personal-plugin parity.
The native arm resolves copied mutable settings under its immutable reviewed
registration policy on each start using the existing bounded snapshot resolver.
The constructor-only fixture loader reads copied user and stamped `.opencode`
project layers, preserves exact native provider configuration, and rejects
unexpected active package/skill/command/MCP inputs or symlinks. Snapshot revision,
source stamp and digest are retained by the runtime; no parent HOME is changed.

`runtime-upgrade-comparison.mjs` accepts a distinct `native-process-tree`
measurement kind with matched owned-process conditions. Its original UI branch
continues to require matching visible Chromium conditions. Both require true
native execution evidence bound to artifact/source/observations/fingerprint hashes,
and environment JSON bound to its hash. Every active scenario run requires at
least 100 completed receipt-backed operations; idle instead requires zero submitted
and completed work plus duration/sample/observation evidence. Exact declared scalar configuration changes and per-side plugin hashes are the
only allowed fingerprint differences. Runtime version and all other observed
fingerprint fields must match. Each summary binds its distinct arm ID and
configuration SHA-256; using the same artifact does not conflate the arms.
The comparator verifies these bindings; the collector verifies the underlying
artifacts and actual receipts. The original comparison remains descriptive. The separate frozen-policy grader
below provides the prospective Stage E gate; no measurement has run against it.

## Independent calibration and frozen grading policy

`freezeRuntimeUpgradePolicy(calibration, { frozenAt, frozenInputs,
monotonicPrecisionMs, configurationDelta, runtimePluginMigrations })` consumes
the complete native generation-2 baseline summary: seven
scenarios with three independent, sequential launches each (21 arms). Its input
contains no candidate measurements. Persist the returned policy and its SHA-256
before starting the 42 paired arms. `frozenInputs` must contain SHA-256 values
for configuration, policy source, baseline source, candidate source, the pinned
candidate native manifest bytes, common
protocol and environment (`configurationSha256`, `policySourceSha256`,
`baselineSourceSha256`, `candidateSourceSha256`, `candidateArtifactSha256`,
`upgradeProtocolSha256`,
`environmentSha256`), plus `baselineConfigurationSha256`,
`candidateConfigurationSha256` and `comparisonDeclarationSha256`. Bind
`baselineArmID` and `candidateArmID` separately. The comparison declaration hash
is SHA-256 of JSON `{ configurationDelta, runtimePluginMigrations }`; freeze it
before observing candidate data. The baseline artifact, semantic fixture, fingerprint,
process conditions, timing conditions and raw calibration-summary hash are
also retained. Freeze the policy's own returned `policySha256` in the cohort
manifest. Every candidate summary must retain the exact `candidateArtifactSha256`
as its observed execution artifact hash; replacing the manifest closes grading.
These bindings cannot be recalculated after inspecting candidate data.

`gradeRuntimeUpgradePolicy(policy, baseline, candidate, { frozenInputs,
runtimePluginMigrations })` preserves the existing fingerprint, workload,
receipt and launch checks. It verifies that all paired arms started after the
freeze, were sequential, and follow AB/BA/AB for each scenario; no calibration
arm may be reused. Three run-level values supply a median and range, never a
pooled distribution or a three-sample p95. A missing, nonfinite or negative
mandatory value, sampling coverage gap, changed freeze, baseline drift or
unresolved calibration returns `inconclusive`. Clean measurements outside a
band return `regressed`; only a complete unchanged cohort inside every band
returns `nonregressing` for this headless local scope.

For each mandatory metric, let B be the calibration median, R its full range,
and q the actual counter precision in that metric's units. The allowed increase
is A = max(0.05 B, R + 2 q). If A > 0.10 B, calibration is inconclusive; do not
widen the band or replace an arm. Each paired baseline value **and** its median
must remain within max(R, 2 q) of B. Both the candidate median increase over the frozen calibration B and every
adjacent pair's increase must be at most A; permitted baseline drift never
adds a second allowance.
Equality is allowed. Throughput is compared as cost `1000 / operationsPerSecond`
in milliseconds per completed operation, so every mandatory metric has the
same lower-is-better direction.

The gates are startup duration, run-level operation p95, throughput cost, host
CPU, sampled descendant CPU, peak and settled whole-tree RSS, and host loop
p95. The eight-call scenario additionally gates the median **actual burst**:
for each receipt, latest completed tool timestamp minus earliest started tool
timestamp across its eight calls, then the median of the 100 burst durations.
Missing tool timestamps are inconclusive; whole prompt duration is not a burst
substitute. Whole-tree peak is max(host RSS + descendant RSS) over the same samples;
settled tree RSS is the last same-sample sum. It is never the sum of independently
timed component peaks. Separate host/descendant RSS, operation p50, SSE terminal
arrival/observation-gap timing and process counts remain descriptive attribution;
counts additionally bound counter error.

Counter units are fixed by the existing Darwin observer: `process.cpuUsage`
microseconds give host CPU q = 0.001ms; `ps time` centiseconds give descendant
CPU q = 10ms times N, the maximum sampled process identity count among the
three baseline arms. Any paired arm above N is inconclusive. `ps rss` KiB and Node host RSS bytes use the conservative whole-tree
bound q = (N+1)/1024 MiB. The final runner must retain an actual `ps` format
witness establishing the declared counter units before calibration; platform
identity alone is not that witness.
Event-loop histogram nanoseconds give q = 0.000001ms. Canonical tool timestamps
use integer milliseconds. Supply the declared monotonic clock precision for
startup/operation timings; throughput-cost q divides that precision by the
100-operation quota. Other OS `ps` precision is unqualified by this policy.
The 250ms process sampling cadence and the 10ms loop probe cadence are not
counter quanta. The existing 25ms completion polling is a measured part of the
end-to-end operation cost, not an extra 25ms uncertainty added to its band.

Near-zero idle resource metrics use fixed absolute **increase** budgets instead
of ratios: 20ms host CPU, 20ms times N descendant CPU, 1MiB each whole-tree RSS metric, and
20ms loop delay. This branch applies when the idle calibration median is at or
below its corresponding budget and requires calibration range at most half the
budget. Larger idle values and idle startup use the normal percentage rule.
These allowances and branch conditions are fixed before calibration.

Process observations must retain sampling failures, exited-before-sample rows,
exact OS identities and actual samples. Every writer ledger token also needs
`resource.receiptProcessIdentities = { status: 'observed', required, observed,
unavailable: [], identities: [{ receiptToken, pid, startIdentity }] }`, with
required/observed counts equal to the distinct measured ledger tokens. Each token
has one distinct supervisor identity, joined to at least one actual sample
by exact PID **and** start identity. A known receipt process missing from samples
makes mandatory descendant CPU inconclusive. The existing observer exports only
actually joined supervisor identities at the unchanged sampling cadence; missing
or conflicting joins remain unavailable. No measured matrix coverage is implied
by this contract. Even a complete join establishes only sampled process CPU, not
a complete census of short-lived
subprocess work. Missing terminal attribution does not become fabricated zero
latency, and these gates do not qualify paid providers, renderer/GPU behavior,
confinement, signing or the separate optimization-retention thresholds.

The full prospective workload is 63 fresh arms: 21 independent calibration arms
then 42 paired arms, with 100 completed active operations per scenario, arm and
launch. Preserve source, artifact, environment and policy hashes throughout;
run in a quiet declared machine window without concurrent validation/builds or
other QA loads. Failures remain retained, stop the cohort, and require a new
cohort rather than selective replacement. Synthetic comparator tests establish
this policy's boundary behavior only; no performance result is claimed.

## Historical diagnostic evidence and remaining qualification

All v1 launches and earlier build/source pins in this section are archived
evidence only. Their runner commands and migration assumptions are superseded;
they must not be used as the current calibration or as supported runtime proof.

`stage-e-native-collector-unit.log` passed 13 focused Node tests, including an
actual local HTTP/SSE transport, actual OS sibling sampling, exact copied
provider/selection/revision settings, symlink refusal and comparator negatives.
The v1 `tools-1k` diagnostic completed actual native glob calls with clean owned
shutdown. Its earlier sampler excluded Node-owned supervisor siblings, so it is
harness evidence rather than final measurements. A separate v1 eight-call
writer diagnostic completed all three warmup and two measured batches with
actual published/terminated/confined receipts; source changed during that arm,
so its retained result correctly failed the cohort check.

The historical first v2 diagnostic exposed the then-current extraction
contract. Current fixtures use an empty private seed and native initialization;
that old migration prerequisite is no longer an acceptance gate. The second stopped during compiled migration.
Stage D builds 1/2 had a proven bare-import resolver packaging defect affecting
Effect namespace reexports; no native work or performance result from those
artifacts is claimed. The bounded build-3 diagnostic completed the actual copy/migration but stopped
at selection because the extracted fixture lacked its prepared candidate checkpoint.
That fixture wiring now recognizes only its actual prepared never-started bundles
and clears those checkpoints before runtime startup. Its failed arm remains at
`.cache/perf/native-upgrade-smoke-v2-build3/`; no runtime work was measured.
The build-4 diagnostic then passed preparation/import/selection and reached
compiled controller startup, but failed before readiness with
`native_process_response_uncorrelated`. The controller's pre-bound startup
exception reply was rejected as uncorrelated, so the underlying startup cause
requires integration-owner diagnosis. Evidence is retained at
`.cache/perf/native-upgrade-smoke-v2-build4/1-tools-1k-g2-d7djif/result.json`
and `stage-e-native-collector-v2-build4.log`; cleanup had no failures.
Neither diagnostic supplies measured native operations or performance acceptance.

The build-11 diagnostic completed its first native glob/continuation warmup, then
stopped at the next warmup. Its retained result is
`.cache/perf/native-upgrade-smoke-v2-build11/1-tools-1k-g2-9kAJUr/result.json`.
The evidence retry at
`.cache/perf/native-upgrade-smoke-v2-build11-evidence/1-tools-1k-g2-bCQRyd/result.json`
captured the actual `context_objective_owner_unavailable` execution failure.
The fixture had omitted primary enrollment and used unmatched model limits:
v2's 16,384-token input limit left only 384 tokens after its native reserve.
The collector now retains diagnostics on failure and reports actual native
execution/step/tool failures immediately. The matched large-context profile and
primary enrollment above correct those fixture defects; neither failed arm is
performance evidence. Focused collector/comparator checks passed 15 tests in
`stage-e-matched-limits-fixture.log` before actual catalog verification.

Both corrected `tools-1k` diagnostics then passed three warmups and two measured
operations with exact observed model limits and clean owned-process shutdown:
`.cache/perf/native-upgrade-matched-limits-v1/result.json` and
`.cache/perf/native-upgrade-matched-limits-v2/result.json`. Each individual source
cohort was unchanged. They ran during Stage D work against different source
digests, so their timings are not a paired comparison or baseline calibration.

Fresh v2-v2 three-pair measurements have not run. Freeze the complete current
graph and artifact, retain hardware/load conditions, qualify the v2 diagnostic,
and freeze independent calibration before the paired cohort. The existing Electron fixture and ledger benchmarks
remain useful scoped measurements, but REST/SSE simulation summaries and short
ledger runs cannot substitute for native operation counts. Installed-data readers
such as `session-pipeline-profile.mjs` must not run by default in this task.

## Child event wake and missed-event proof

Scheduler `waitForAnyTask` and `waitForResultCommit` already take their initial
snapshot and register under the existing mutation queue. Their focused tests
cover already committed output, late commits, a commit suspended during wait
registration, timeout, cancellation and restart cursor identity.

The child executor now separately subscribes to session status/terminal/user
and reconnect hints before canonical observation. A revision remembers events
arriving during awaited reads. A healthy wait races that revision against an
abortable reconciliation timer and drains the timer on event, terminal exit or
shutdown. Every event remains a hint: canonical status/transcript and existing
task/lease fences determine results. Stream deltas still only stamp first output.
The default reconciliation ceiling remains 750 ms; a longer constructor setting
needs matched measurements before production selection. Error/Stop/retry and idle
debounce paths retain their existing timing and reconciliation semantics.

`open-code-activity.test.js` now exercises a terminal hint during a blocked real
observation, an entirely missed hint recovered at the bounded backstop, reconnect
with canonical idle, and shutdown during a suspended event wait. These are local
state-machine correctness tests, not claims about network reliability or measured
performance. Actual event-feed disconnect/reconnect plus old/new native controller
replacement still belongs in the final composed run.

Focused implementation evidence: `stage-e-child-event-wake.log` passed 209 Bun
tests/690 expectations across executor, registry and scheduler waits;
`stage-e-native-collector-unit.log` passed 13 Node tests across collector and comparator. Full runtime performance qualification
remains not run.

The resource-evidence gate passed 15 focused collector/comparator tests in
`stage-e-resource-evidence-gate.log`, including a real OS sibling sampler and
injected observation-failure refusal. This is collector correctness evidence,
not a hardware performance result.

The historical repository-owned phase driver at
`.cache/perf/stage-e-freeze-and-grade.mjs` prepares the exact original control
plugin hashes and candidate reviewed-plugin hashes before calibration. It checks
those declarations against each observed arm, requires a frozen policy before
paired launches, and pins both completed generation reports before grading.
Its synthetic selfcheck rejects changed report metrics even when source,
artifact and plugin bindings remain unchanged. The frozen preparation manifest
SHA-256 is `265a32b9419f9ef6bc12e005725ce97c569682b51638b36dbf54da1bfa5e3cb2`.
Syntax and synthetic checks passed; actual preparation, counter/clock witnesses,
calibration and paired measurements have not run. This cached driver and its old preparation hash do not qualify the current
v2-v2 contract. Any new phase driver must bind the explicit arm/configuration
fields and fresh qualified artifacts described above before use.
