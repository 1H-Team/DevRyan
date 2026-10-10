# Startup import evaluation

Timing acceptance is deferred at the user's request while other work continues
in this checkout. No launch-speed improvement is claimed. The import candidates
are **not active** in production source.

Retained work adds monotonic bundle preparation/application import timings,
separate native verification/configuration synchronization/configuration/
controller/recovery/open timings, and bounded renderer readiness marks. The
usable-chat predicate and recovery order are unchanged. The packaged benchmark
now compares explicit source-pinned baseline/candidate artifacts in
B1/C1/C2/B2/B3/C3 order, requires matching native inputs, records journal checks,
and accepts only a 5% median improvement with every pair faster.

## Evidence and limits

- [Backend graph](backend-graph.json): all implementation modules reached by
  the broad barrel remain necessary. The narrowed route imports exclude only
  the barrel itself. This is static dependency analysis, not accepted runtime
  performance evidence.
- [Renderer graph](renderer-graph.json): the production trial build excluded
  About, Memory Debug and the MCP callback from the startup graph. Their separate
  chunks total 23,254 raw bytes; this is not an estimate of launch-time savings.
- [Diagnostic attempts](diagnostic-attempts.json): two natural baseline probes
  failed before usable chat. One app exited; the other timed out with a hidden
  renderer and provider/agent initialization errors. Explicit offline journal
  gap scans passed for both. A later comparison was refused because concurrent
  settings edits changed the source identity. None counts toward acceptance.
- The failed probes spent 10.29–12.61 seconds in the configuration stage.
  The added configuration-sync substage has not yet been measured. A follow-up
  should profile synchronization versus configuration assembly in a successful
  matched run before changing native behavior.

The [backend trial](backend-trial.patch) and [renderer trial](renderer-trial.patch)
are reviewable, unapplied patches. Both pass `git apply --check`. The renderer
trial built, but first-use Electron/web interactions, focus restoration, callback
processing and failure/retry journeys remain unqualified. Do not activate either
patch on the strength of this audit alone.

## Resume acceptance

Finish other source/build work, create fresh instrumented baseline and candidate
packages with identical dependencies/native inputs, and run:

```sh
bun scripts/qa/native-startup-benchmark.mjs \
  --baseline-package-evidence /absolute/repository/baseline/package-evidence.json \
  --candidate-package-evidence /absolute/repository/candidate/package-evidence.json \
  --artifact-root /absolute/repository/.cache/native-artifacts
```

Use natural startup first. If foreground control is necessary, qualify a separate
run with `--startup-mode foreground`. Evaluate each trial separately, retain only
demonstrated improvements, and complete deferred UI interaction checks before
acceptance. First install, service attachment and cold OS-cache qualification
remain outside scope.

## Verification

- `bun run build`: passed, including the Electron main bundle.
- `bun run bundle:check`: passed with unchanged budgets; 4,887,997 raw bytes and
  1,441,327 gzip bytes across the 26-file startup graph.
- `bun run validate:full`: lint, type checks and documentation validation passed.
  The test stage stopped outside the startup changes in
  `scripts/opencode-v2-native/native-openai.test.ts` (14 passed, 1 failed).
  Its immediate isolated rerun passed all 15 tests. The full gate is **not green**;
  a clean full-suite run remains outstanding.
- Focused benchmark tests: 17 passed. Readiness tests: 17 passed. Native runtime
  owner and timing-helper tests: 25 passed.
- The full UI shared-process batch had 4,082 passes and two failures in
  `describeSessionFailure`: native credential-fence wording and classification
  restored from its persisted code. The
  `packages/ui/src/sync/session-failure.test.ts` passed all five tests in isolation.
  The shared-suite failures remain unresolved; isolated passes do not replace
  the failed suite results.
- Other work continued changing this checkout, including provider and session
  failure code. These are command results from the tested snapshots, not a
  qualification of a frozen final checkout. Concurrent edits were preserved.
- `git diff --check` and both trial-patch applicability checks passed.
- Nine owned QA/retry directories were removed after proving no owned processes
  remained. Cache reporting and prune preview completed; no bulk prune was
  applied to unrelated work.
