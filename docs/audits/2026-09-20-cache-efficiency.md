# Cache efficiency implementation — 2026-09-20

Implemented the three review groups described in [the operating guide](../CACHE_EFFICIENCY.md):
shared usage contracts and retained-journal reconciliation; owned, bounded QA
wire observation and serializer fixtures; and default-off route-qualified title
experiment scaffolding with durable attempt limits. No inference default was changed.

The accounting report was replayed over the retained pilot journal. Its four
whole-task cache-read ratios, including deleted title helpers, reproduce the
pilot: Sol 38.92%, Astra 38.93%, Opus 39.67%, Grok 44.78%. It correctly leaves
request hit rate unknown for runtime-only evidence. Native-response helpers
retain Claude model/write-lifetime evidence and distinguish Codex last/cumulative
counters without interpreting ambiguous write zeros as authoritative.

Actual OpenCode 1.18.31 serializers were exercised against loopback synthetic
endpoints for Sol, Astra and Grok at medium effort. All six responses were correct;
both-turn instruction/tool/prior-history/cache-parameter checks passed. Endpoint,
observer and reservation counts agreed, actual synthetic response model was
captured, and no observer gaps or owned-process survivors remained. These checks
do not establish live-provider cache reuse, complete DevRyan overlay serialization,
or managed OAuth acceptance. The fixture disables default plugins.

Validation:

- `bun run validate:full` passed on retry, including workspace lint, type checks
  and deterministic suites. The first run found an export-file-count assertion,
  which was updated for the new usage file; subsequent fixture failures were
  caused by disk exhaustion. The rerun passed without weakening tests or changing
  concurrent session-revert work. Five opt-in native execution tests were skipped
  by their existing prerequisites; they are not reported as passes.
- Focused accounting, sanitizer, journal, export and QA tests passed again after
  final review corrections. That review fixed session-manifest attribution:
  helper relations must not make a root its own parent, and assistant parent IDs
  are message IDs, not session IDs.
- `bun run build`, `bun run bundle:check`, `bun run docs:validate` and
  `git diff --check` passed.

Evidence is retained below repository `.cache/qa`: the `cache-implementation-*`
logs, `cache-serializer-verified.log` and its referenced owned run directory,
and `cache-pilot-PSeTuD/usage-v1.json`.
The post-review replay includes the current attribution-conflict fields. Fresh
installed-adapter evidence is `cache-serializer-review.log` and
`cache-serializer-duC0MY/result.json`: six correct responses, all prefix and
observer checks passing, no surviving owned processes. All six dispatch records
show an omitted redirect mode, so these adapters do not meet the bounded live
runner's explicit redirect prerequisite. No route was silently enabled.

No additional live-provider HTTP attempts were made during implementation.
Managed OAuth and native subprocess attempt coverage remain unqualified, so the
paired runner keeps those routes observability-only. The Grok title flag still
requires matching live route/runtime evidence, the lowest advertised verified
effort, and wire confirmation for each arm. The xAI affinity candidate remains
excluded from this phase's 160/40 budget. No production savings percentage or
title-equivalence claim is made.

The implementation received a further read-only critical review in the same
Claude desktop session using Fable 5.1 Extra. Findings and proposed corrections
were discussed before edits. The confirmed cumulative-cost bug was fixed:
`[1, null, 3]` no longer counts as four dollars; the missing interval is unknown
and flagged. Copied native responses now resolve shared roots after all relations
are available. Empty stream deltas do not start first-token timing, and parser
exceptions preserve the response stream while recording a gap.

The review also tightened the inactive QA workflow: live profiles share a parent
campaign ledger; qualification includes the endpoint; inference route changes
are refused; trial results reconcile actual wire records; and title effort/model
checks cannot be satisfied by adapter assertions. Title trials balance arm order
and use a separate blinded grading callback with a recorded rubric hash. A/A uses
six pairs with four attempt slots reserved for helpers/retries. Actual transport
coverage remains an operator evidence requirement. A verified host send adapter,
live route qualification and complete overlay serialization verification remain
pending; this change does not claim a runnable live optimization.

The final review found no delivery blockers within that scope. Its remaining
future-live edge cases were discussed and corrected: accounting cursors now span
arm boundaries and the final tail, transient/unattributed failures are incomplete,
and real endpoints require campaign admission regardless of the evidence label.
Only a structured effort-parameter error with a 400/422 response can reject the
candidate on request-error grounds. Request/error text is not retained.

Post-review verification: `bun run validate:full` passed with no skipped tests,
followed by final workspace lint/type checks and 23 QA regression tests.
Accounting/normalization/export fixtures also passed (18 tests), as did the final
build. Logs use the `cache-review-*` prefix. The five optional native skips above
belong to the earlier implementation run.

Concurrent UI, settings, session-revert and validation-tool work was preserved.
