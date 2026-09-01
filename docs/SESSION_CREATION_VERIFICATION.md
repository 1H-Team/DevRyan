# Session creation implementation and verification

Verified on macOS arm64, 2026-08-31, using OpenCode 1.18.25 and Context Mode
1.0.169. The user's live DevRyan/OpenCode processes were not restarted or patched.
Unrelated working-tree changes and existing user indexes were preserved.

## Changes

- Managed provisioning checks the exact Context Mode adapter, executor, and
  server sources before activating worker execution. Four workers are scoped to
  exact project and runtime storage settings, serialize their calls, and allow at
  most 32 queued calls / 64 MiB of queued input. Active calls and background
  commands prevent eviction. Failed calls are explicit errors and are not replayed.
- Draft submission owns one immutable attempt and one 120-second budget. Only
  an explicit rejection before creation during restart can retry automatically.
  Ambiguous outcomes retain the draft and require confirmation to create again.
- Cancellation stops local preparation and subsequent prompt dispatch. Late
  acknowledgements stay with the original attempt, without changing the current
  selection. Raw text, attachment revisions, draft identity, account namespace,
  and captured send configuration protect promotion and failure recovery.
- Immediate waiting/Cancel UI, a five-second slow-runtime message, content-free
  creation timings, and separate recent health probes make delays diagnosable.
  Successful payloads, ownership gates, bootstrap gates, title generation, and
  background configuration activation retain their contracts.
- Full-UI verification found a revert bug: attachment hydration was counted as a
  user edit and invalidated the restored prompt on composer remount. Attachment
  actions now own those revisions; hydration does not. A second integration
  finding corrected timing records to use fields preserved by the journal sanitizer.

## Measurements

Each latency row below has 30 samples. Creation includes an explicit controlled
10 ms ownership delay. These are local-runtime measurements, not a hosted
Supabase p95 guarantee.

| Scenario | p95 | Limit |
| --- | ---: | ---: |
| Cold process, already provisioned profile, quiet repeat | 686.5 ms | <1,000 ms |
| Warm creation | 34.6 ms | <1,000 ms |
| Creation during fresh 200-file indexing | 31.1 ms | warm +250 ms |
| Creation during populated 200-file indexing | 22.5 ms | warm +250 ms |
| Submission feedback in packaged component renderer | 1.0 ms | <100 ms |
| Promotion after acknowledgement, store-level sample | max 1 ms | <100 ms |

The indexing workload contained 200 synthetic Markdown files and 6,200 chunks.
Search recovered the expected document after indexing. Four session records were
present; this was an indexing-concurrency test, not four simultaneous model turns.
An earlier independent indexing run added 24.7 ms to p95. Small negative overhead
in the table is measurement noise, not a claim that indexing improves creation.

The quiet cold run was repeated after a loaded run measured 1,730 ms p95 while
the full regression suite was running. First-ever setup of an empty OpenCode
profile was separately observed at 13.7 seconds (22.6 seconds in an earlier run).
That dependency/bootstrap cost is not included in the provisioned cold-process
result and has not been eliminated by this change.

Feedback measurements record React commit, not a hardware display timestamp;
the actual waiting state was also inspected visually in packaged Electron.
The full managed route recorded one real creation at 207 ms: upstream creation
at 11 ms, followed by durable ownership acknowledgement at 207 ms. This is a
single diagnostic sample, not a replacement for the controlled benchmark.

## Regression and integration checks

`bun run validate:affected`, full `bun run type-check`, and full `bun run lint`
passed. The affected run included 3,178 web tests, 243 VS Code tests plus its
21-test Bun batch, the UI's 3,327-test shared batch, and isolated UI suites
including 110 session-action and 121 send-routing tests. A final focused worker
and route run passed 25 tests after adding the legacy storage-scope check.
UI/web production builds also passed.

Coverage includes competing sends, navigation, edited/deleted drafts, late
success, reload markers, pre/post-dispatch cancellation, bounded restart retries,
ambiguous errors, expired preparation, ownership retry/cleanup errors, directory
aliases, worktree bootstrap, captured selections, revert rollback, unrevert,
fork, concurrent suffix events, and late reconciliation.

Real Context Mode workers indexed six separate projects with a four-worker cap,
evicted/reopened idle workers without losing indexes, kept project results
separate, preserved background commands across other-project activity, and stopped
owned commands after an injected worker crash. Hash incompatibility leaves the
package unchanged; existing path/deny and storage-recovery tests passed.

Computer Use checked a separately packaged Electron shell with both the focused
component fixture and the built DevRyan UI against an isolated server:

- Immediate waiting, delayed waiting, Cancel, explicit retry confirmation,
  retained text/attachment fixture, late acknowledgement, and reload recovery.
- Reserved Test Administrator login without passwords; double Enter produced
  one session and one prompt; creation, revert restoration, edit/resend, and fork.
- Reserved Test Developer login: administrator sessions/drafts were absent and
  administrative settings were hidden. Real HTTP checks returned 403 for foreign
  session reads and out-of-scope creation, and 200 for the owner's created session.
- Sanitized journal records retained the same opaque operation ID before and
  after the session ID existed. The isolated journal reported no gaps.

The packaged shell checks exercise the production renderer and actual web
backend, but do not constitute a signed installer/update test. Windows worker
process-tree cleanup was not run on this Mac. No live runtime rollout occurred.

## Reproduction and artifacts

Install Context Mode 1.0.169 only in a disposable directory under repository
`.cache`, then run:

```sh
bun scripts/verify-context-mode-workers.mjs .cache/context-mode-worker-check
node scripts/benchmark-session-creation.mjs .cache/context-mode-worker-check
```

The benchmark creates its own synthetic repository, config, storage, and OpenCode
child. It never targets the user's runtime. An optional second argument reuses
one of its synthetic profiles for a quiet 30-sample cold-process-only repeat.

Local evidence is under `.cache/session-create-benchmark-cJuTAf/`,
`.cache/e2e/session-creation-visual/`, and
`.cache/session-creation-managed-verify/`. Verification sessions were removed.
Host deletion acknowledged cleanup before all isolated upstream reads stopped
showing records; cleanup was finished through the isolated OpenCode API and its
session list was checked. This observation is not claimed as a deletion fix.
Copied verification credentials and authenticated renderer profiles are removed
at cleanup; sanitized journal evidence is retained separately.

Rollout remains normal managed provisioning after active work finishes. Keep the
dependency pinned. If compatibility validation fails, leave the adapter disabled
and restore the prior repository provisioning implementation; indexes require no
rollback or migration. Do not restart a busy runtime to chase a latency target.
