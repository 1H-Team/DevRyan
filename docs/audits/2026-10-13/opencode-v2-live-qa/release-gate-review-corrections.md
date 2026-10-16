# Release gate review corrections

14 October 2026. Read-only review reproduced two release gate defects, then the
owning scripts were corrected without changing native production source.

Repeated successful workflow dispatches for one version could evict failures
because the admission window selected ten runs. The window now selects ten
distinct prior stable versions from complete paginated workflow history and retains
all runs of those versions for job and receipt inspection. Version/source identity
comes from immutable admission evidence, including branch-dispatched pre-tag
candidates. The existing admission artifact carries a compact identity inventory;
exact release-admission markers can also identify old published cohorts. Expired
evidence outside the selected window may age out after authoritative identity
resolution; missing or expired selected evidence still refuses admission. The current admission run
does not displace the tenth prior release. Existing GUI-only failure exclusions
and source admission checks remain required; unavailable history fails closed.

Receipt timing stopped before writing its digest witness. The outer receipt
owner now measures after both receipt JSON and witness I/O have settled and
commits a mandatory observation bound to both files' digests. Its measurement
explicitly excludes the observation's own commit, which is checked against the
same captured receipt and absolute deadline. Qualification requires all three
files. Failed or late observation commits remove qualifying evidence.

Publication, CI and workflow contracts passed 35 tests. Smoke and publication
contracts passed 27 tests, including a real two-second rename delay and
three-second witness delay: measured receipt I/O exceeds five seconds and the
derived final receipt allowance is at least fifteen seconds. Missing or foreign
observations and failed/late writes cannot qualify. Docs validation passed.

A later review found the final receipt was first read after deployment. The
finalizer now verifies all three receipt files, retained installer/app/manifest
identity and the qualified phase budgets before deployment or npm publication,
and repeats the same check before public asset finalization. Its identity/budget
artifact is retained for 90 days. Two unexplained failed jobs in one workflow run
count as two failures. A read-only new-source/version correction rehearsal remains
possible; write admission requires three actual green exact-source receipts,
common artifact identities, frozen metadata/budgets and upgrade proof from a run
started after the unresolved failures. Historical failures remain recorded.

The final publication/CI/workflow/script-runner group passed 73 tests. It includes
missing and foreign receipt files, changed source/manifest/app/budgets/installer,
pre-deployment ordering, branch-dispatched history, same-run failure counts,
inside/outside retention, and two failures → read-only correction → refused
unqualified write → exact repaired qualification. The smoke group had passed
12 tests on the preceding unchanged phase/receipt owner. Docs and diff checks pass.

Current-run earlier attempts are checked separately before heavy work or image
writers; excluding the current run from the rolling window does not exempt its
past gate failures. Exact retained metadata/receipt checks refuse product,
evidence and cleanup retries. Valid GUI prerequisite failures support only
**Re-run failed jobs**, through the unchanged smoke retry owner; selecting the
successful admission job again receives `release_retry_failed_gate_jobs_only`
before immutable artifacts could be rebuilt or re-uploaded, including a fully
successful prior candidate run with no failed gate rows. Published retries first
verify their original finalization/deployment proof, then reuse only an identical
same-run admission artifact and skip its immutable upload; a fresh read-only run
retains its own artifact. The final workflow
ordering regression also passed 11 tests.

The root's independent final group passed 59 tests in 11.45 seconds, including
these release/phase/retry contracts and two package-runner Node/Bun prerequisite
checks. The earlier independent release review passed 55 tests. These are
separate run counts, not unique totals; the owning combined group above is 73.

```text
node --test scripts/release-publication.test.mjs scripts/release-ci.test.mjs scripts/release-workflow.test.mjs
node --test scripts/release-publication.test.mjs scripts/release-ci.test.mjs scripts/release-workflow.test.mjs scripts/test-runner-utils.test.mjs
node --test scripts/qa/release-startup-smoke.test.mjs scripts/release-publication.test.mjs
bun run docs:validate
```

This is deterministic owner verification. No release was published, no tag or
external configuration was changed, and no macOS release smoke or deployed
workflow result is claimed.
