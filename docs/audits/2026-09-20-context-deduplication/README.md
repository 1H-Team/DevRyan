# Context pipeline repair and duplicate-output verification

Date: 2026-09-20. Implemented in the shared working tree while preserving unrelated uncommitted work. No installed runtime was restarted or updated.

The managed harness now owns skill and managed-result projection and edits the array consumed by OpenCode. Changed message/part/state records are cloned. The standalone skill plugin retains discovery, aliases, descriptions and catalog formatting. Unique versions, protected provider material, attachments, unknown metadata and native-pruned sources remain full. Repeated calls alternate between a retained full observation and a smaller reference, per key, including across intervening tools.

The `duplicateOutputs` capability is independent of checkpoint policy. Host qualification matches runtime version/executable hash, provider/model/variant, the selected provider configuration, authentication transport, and ordered plugin content hashes. Absolute source hashes still require exact agreement between the native caller and host; installation paths do not prevent the same verified managed bytes from qualifying in another installation. Unknown configurations remain full. Optional discovery has nonblocking retries; required-check enforcement retains its fail-closed recovery. Per-session suppression protects native summaries and ordinary usage metadata. The verified OpenAI profile described below is now a release default; other configurations remain off even with explicit opt-in. `DEVRYAN_DUPLICATE_OUTPUTS=0` overrides those defaults after the normal managed-host restart.

## Verification

- `bun run validate:full` passed, including 391 web test files and 4,206 web tests, plus the other workspace, script, lint, type and documentation gates.
- Final focused projection, managed-dispatch, skill and host qualification coverage passed: 251 tests. Additional host fingerprint, report and trace checks passed after final diagnostic hardening.
- `bun run build`, `bun run bundle:check`, documentation validation and `git diff --check` passed. Existing dependency/build and historical-document warnings remain warnings.
- The real-runtime loopback probe passed on OpenCode 1.18.31 and the available 1.18.31-devryan.2 companion executable. Exact executable and plugin hashes are retained in [evidence.json](evidence.json). This identifies the tested cached companion artifact; it does not attest any independently changing companion patch/build work.
- Request assertions cover paired sizes, retained unique evidence, call/result pairing, references resolving to full outputs, native-pruned anchors, two successive manual compactions, automatic compaction, summary suppression ordering and owned-process cleanup. Unit tests additionally cover capability outages, cancellation/failure, queued requests, concurrent sessions, changed model/configuration, signed sibling parts, repeat-call escape, append stability, headroom preservation and composition with document/input transforms.

The native command is:

```sh
node scripts/qa/cache-serializer-probe.mjs /absolute/path/to/opencode --duplicates
```

It uses private homes/workspaces, the existing repository SDK and a synthetic loopback provider. The fixture bridge authorizes only the synthetic experiment; production qualification is tested separately; this synthetic experiment alone cannot approve a profile. Built-in native auth plugins are disabled in this fixture. Bodies are inspected in memory, with only structural evidence retained. No installed-app history or real provider credential is needed.

## Observed request sizes

Both tested executables produced the same paired sizes:

| Synthetic request | Projection off | Projection on |
| --- | ---: | ---: |
| No duplicate control | 43,200 bytes | 43,200 bytes |
| Repeated skill and managed observations | 72,459 bytes | 54,741 bytes |
| First anchors natively pruned | 63,172 bytes | 54,313 bytes |

Every retained managed reference resolved to a full matching task/envelope result. All summary requests had zero injected deduplication references. Each arm crossed two manual and one automatic native summary boundary. Canonical history stayed unchanged by projection. Per-hook timing samples and peak serialized request size are recorded separately; these timings are not end-to-end latency measurements. The synthetic usage values used to trigger automatic compaction are not provider accounting. Actual provider input/cache tokens and peak input are unknown for these synthetic probes; the live measurements below are separate.

These fixtures deliberately contain duplicates and do not establish representative savings, monetary savings, or live task continuity. The earlier replacement-array measurements are corrected narrowly in the [original harness audit](../2026-09-10-harness-optimization.md); valid checkpoint, continuation and token-based headroom evidence is preserved.

## Live qualification and activation

The release default is enabled for `opencode-1.18.31-openai-sol-medium`: the exact macOS arm64 OpenCode 1.18.31 executable, OpenAI managed ChatGPT OAuth Responses transport, `gpt-5.6-sol`, Medium effort, matching selected-provider configuration and the 22 ordered managed plugin entries. All 17 bundled plugin entries still match their tested bytes. Other native binaries, providers, models, efforts, API-key transports, changed/custom plugin configurations and unavailable identities retain full output. The separate checkpoint and compact-result switches keep their existing defaults. `DEVRYAN_DUPLICATE_OUTPUTS=0` disables duplicate projection after the normal managed-host restart.

The [complete live acceptance evidence](live-acceptance.json) records ten matched pairs: five skill-reuse and five managed-result-continuity cases, 20 completed primary responses, zero critical continuity failures, zero repeated mutations, and no extra same-key calls in either arm. Each candidate request contains two references whose full source remains visible. Unique facts, call/result pairs and canonical histories remain intact. System and tool prefixes match in every pair. No-duplicate controls are unchanged at 61,307 bytes; their auxiliary requests are unchanged at 6,940 bytes.

| Live primary requests (10 per arm) | Projection off | Projection on |
| --- | ---: | ---: |
| Serialized size range | 112,935–121,463 bytes | 89,289–94,011 bytes |
| Total provider input, including cache reads | 232,120 tokens | 181,339 tokens |
| Provider cache-read input | 86,272 tokens | 79,232 tokens |
| Peak provider input | 24,113 tokens | 18,661 tokens |
| Native compactions during these short trials | 0 | 0 |
| Additional same-key tool calls | 0 | 0 |

Actual applied-hook timing in the accepted candidate batch: median 0.482 ms, maximum 13.980 ms across ten samples. These are transform measurements, not end-to-end latency. Auxiliary requests and their usage are retained separately in the wire evidence. The earlier collector did not retain usage in the pilot and failed batch, so these totals cover the accepted batch, not all verification traffic. Cache-read counts vary with cache state and trial order; no monetary savings are inferred.

The histories are synthetic repository fixtures, delivered through the actual native runtime and full managed plugin pipeline to a live model. They test retention and behavior in the presence of completed observations; they do not claim that a real managed child executed the seeded failed task. Baselines ran before candidates, so this is a correctness smoke test, not a statistical or latency comparison. Native pruning and append stability remain covered by the separate deterministic tests.

The [first full live batch](live-incomplete.json) failed qualification: one candidate request received HTTP 503, then the native runtime retried the identical body and returned correct facts. That incomplete trial was retained as a failed gate; a fresh complete ten-pair batch passed without provider failures. Two earlier pilot batches diagnosed the collector and metadata traffic; they are excluded from acceptance. The [enablement evidence](enablement.json) retains those attempt identities, provider-failure accounting, applied timings and the subsequent default-activation check.

After promotion, the private host was switched to the exact shipped qualification code and release profile, with no experimental admission override. Skill and managed checks passed with the candidate environment switch **unset**, and the same checks retained full output with the switch set to `0`. This verifies automatic activation and the rollback path without restarting or modifying the user's installed application. The installed app receives these defaults through its normal update and managed-runtime restart.

The [default activation check](default-verification.json) is separate from the ten-pair qualification. A further [full managed configuration native check](native-managed-compaction.json) passed two consecutive manual summaries and one automatic summary, with no deduplication references in summary requests. That check used synthetic Responses and a synthetic 300,000-token pressure report with unchanged native model limits; those counters are not live provider usage. Both ordinary skill and managed projections remained active, and the owned processes cleaned up.

Generic read/search/web pruning, semantic scoring, unique-output offloading, extra model calls in the feature, runtime forks, legacy Tauri and Production Bots changes remain outside this work.
