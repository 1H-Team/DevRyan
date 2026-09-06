# ECC Final Review Fixes Implementation Plan

**Goal:** Close the three Important findings from the final branch review without widening the evaluator or runtime contract.

**Architecture:** The Cursor runtime owns the reserved synthetic-patch marker and removes it from provider metadata before canonical tool parts are emitted. The evaluator excludes only completed runtime-shaped `apply_patch` presentation cards and treats recognizable but invalid Cursor shell envelopes as authoritative conflicts. Raw live artifacts stay under the configured ignored report root.

## 1. Lock the trust-boundary regressions with tests

- Extend `scripts/agent-evals/client.test.mjs` with direct and wrapper shell envelopes whose signals are non-null, missing, or malformed, including conflicting valid metadata.
- Extend `scripts/agent-evals/graders.test.mjs` so provider-marked real edit/test tools remain evidence while only an exact synthetic patch card is excluded.
- Extend `packages/web/server/lib/opencode/cursor-sdk-runtime.test.js` with a provider metadata collision that proves the reserved key is stripped and unrelated metadata survives.
- Run each focused test first and record the expected RED failure.

## 2. Implement the minimal runtime and evaluator hardening

- Sanitize provider-copied tool metadata in `packages/cursor-sdk-runtime/index.js`, preserving ordinary keys and setting the reserved marker only on the runtime-derived patch producer.
- Add an exact structural synthetic-patch predicate in `scripts/agent-evals/client.mjs`.
- Make Cursor shell parsing tri-state so recognizable invalid/signaled envelopes cannot fall back to metadata or raw marker evidence.
- Run the focused suites to GREEN, then update the nearest codemaps/documentation.

## 3. Restore the raw-artifact retention boundary

- Move the ignored `live-electron-data` tree beneath `.superpowers/sdd/tmp/reports/` without reading its files.
- Verify the source is absent and no task-owned live-data tree remains outside the report root.
- Correct the audit and ignored task report wording/counts.

## 4. Revalidate live behavior and release gates

- Restart the safe loopback Electron runtime using the retained private profile.
- Run one exact pinned Cursor repair evaluation (`cursor-acp/composer-2.5`, `Builder`, explicit null variant), verify PASS and the exact clean fixture invariant, then shut down the process tree.
- Append sanitized evidence, commit the follow-up separately, and report the commit SHA and any limitations.
