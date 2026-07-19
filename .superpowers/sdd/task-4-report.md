# Task 4 Report: Tighten Orchestrator instructions

Date: 2026-07-15
Branch: `codex/ecc-performance-pass`
Status: implemented and verified

## Implementation

- Changed the packaged Orchestrator priority contract so correctness and reliability are hard gates, followed by latency/resource efficiency and then cost.
- Consolidated question routing into one authoritative `Question routing` rule. The routing section now references that rule for missing Designer intent instead of repeating the question policy.
- Consolidated skill-announcement and visible-reasoning policy into one authoritative hard-rule line each.
- Consolidated normal-mode plan-approval policy into one authoritative `Plan approval` rule while preserving the separate plan-only execution behavior.
- Left the complete YAML frontmatter and permission map unchanged.
- Preserved managed dispatch and result disposition, the single managed recovery limit, allowed agents, provider-native delegation boundary, Git boundary, completion contract, routing map, plan-mode behavior, subagent terminal marker, and other always-on safety policy in the packaged prompt.
- Kept all guardrails in the packaged prompt; no policy moved into an optional skill.
- Added focused audits for the priority order, unique canonical policy occurrences, exact frontmatter, required execution contracts, and literal UTF-8 byte counts.
- Updated existing agent-loader assertions only where their expected wording moved to the canonical rule.
- No module ownership or entrypoint changed, so no codemap or module-documentation update was needed.

## Files

- `packages/web/server/default-config/agents/orchestrator.md`
- `packages/web/server/lib/opencode/packaged-agent-defaults.test.js`
- `packages/web/server/opencode-agents.test.js`
- `.superpowers/sdd/task-4-report.md`

## UTF-8 byte record

- Pre-task source: commit `2e87f6d9`, measured with `git cat-file -s 2e87f6d9:packages/web/server/default-config/agents/orchestrator.md`.
- Before: 15,902 bytes.
- After: 14,667 bytes, verified independently by `wc -c`, `Buffer.byteLength(content, 'utf8')`, and `TextEncoder().encode(content).byteLength`.
- Removed: 1,235 bytes.
- Reduction: 7.7663%.
- This is below the 10% threshold, so this task makes no context-performance claim. No guardrail was removed to chase the threshold.

## RED to GREEN evidence

1. Priority, canonical policy ownership, preserved contracts, and exact bytes
   - RED: `bun run --cwd packages/web test server/lib/opencode/packaged-agent-defaults.test.js`
   - Exit 1; 4 expected failures and 14 passes. The old prompt lacked the new priority and canonical markers, measured 15,902 instead of the initially designed tightened size, and still used the previous question-routing wording.
   - GREEN: same command, exit 0; 18 tests passed.

2. Preserve explicit user-intent and clear-next-step guardrails inside the canonical question rule
   - RED: same command, exit 1; 2 expected failures and 16 passes. The consolidated rule did not yet state the no-guess/no-permission guardrail and still measured 14,569 instead of the final 14,667 bytes.
   - GREEN: same command, exit 0; 18 tests passed.

## Final verification

- Focused prompt/harness integration: `bun run --cwd packages/web test server/lib/opencode/packaged-agent-defaults.test.js server/opencode-agents.test.js server/lib/opencode/harness-preflight.test.js`
  - Exit 0; 3 files passed; 79 tests passed.
- Required affected validation: `bun run validate:affected`
  - Exit 0.
  - Web lint and web type-check passed.
  - 102 web test files passed; 870 tests passed.
- Workspace type-check: `bun run type-check`
  - Exit 0 across desktop, UI, web, Electron, and root packages.
- Workspace lint: `bun run lint`
  - Exit 0 across desktop, web, Electron, UI, and root packages.
- Whitespace audit: `git diff --check`
  - Exit 0.

## Self-review

- Scope audit: only the packaged Orchestrator prompt, two focused prompt-audit/loader tests, and this report changed. No runtime code, dependencies, Tauri files, upstream repositories, or other packaged agent prompts were touched.
- Priority audit: the new body states the correctness/reliability gates before latency/resource efficiency and cost; the unchanged frontmatter description remains compatibility metadata rather than an ordering contract.
- Deduplication audit: each canonical rule marker occurs once, `structured question tool` occurs once, and each canonical skill-announcement, visible-reasoning, and plan-approval sentence occurs once.
- Safety audit: exact frontmatter comparison and required-contract assertions cover permissions, managed orchestration/recovery, allowed agents, Git, completion, routing, plan mode, terminal markers, real-tool use, provider-native fallback denial, and the general-purpose-agent denial.
- Compatibility audit: the production agent parser, packaged defaults, agent API tests, and harness prompt audit all consume the tightened prompt successfully.

## Concerns

- No known functional blocker remains.
- The 7.7663% byte reduction is measured context shrinkage only and does not establish lower latency, lower resource use, lower cost, or improved model behavior.
- Test output includes the repository's existing Node `module.register()` and `util._extend` deprecation warnings; they are unrelated to this change and did not affect exit status.

## Review-fix pass

Review source: `.superpowers/sdd/task-4-review.md`
Date: 2026-07-15

### Findings resolved

- Resolved P1 by restricting structured questions to unresolved user-owned intent, requirements, preferences, or choices that materially change scope, user-visible outcome, external effects, or an irreversible tradeoff.
- Made precedence explicit in the canonical Question-routing rule: an implementation approach or plan already grounded by the requested outcome is not sent to the user for ratification and instead defers to the Plan-approval rule.
- Moved the one canonical normal-mode Plan-approval rule into the always-on Hard Rules block. It now covers the sufficient-intent case directly, while Plan Mode references it and retains the plan-only execution contract.
- Resolved P2 by requiring every question in a 1–3 question batch to have its own 2–3 mutually exclusive, concrete, decision-ready options.
- Added a cross-rule semantic regression that extracts both canonical rules, checks their precedence as one interaction, rejects `competing implementation approaches` as a question trigger, verifies always-on placement, and checks the Plan Mode reference.
- Preserved the complete frontmatter and every previously audited managed-orchestration, recovery, agent, Git, completion, routing, plan-only, and terminal-marker contract.

### Review-fix RED to GREEN evidence

- RED: `bun run --cwd packages/web test server/lib/opencode/packaged-agent-defaults.test.js`
  - Exit 1; 5 expected failures and 15 passes. Missing behavior included the user-owned/material-impact boundary, grounded-implementation precedence, always-on Plan-approval placement, per-question mutually exclusive options, and the new exact byte total.
- GREEN: same command, exit 0; 20 tests passed.
  - The first implementation run left one test failure because the semantic matcher incorrectly required the Plan rule immediately after the Question-rule deferral sentence. The prompt already satisfied the intended boundary; broadening the matcher to allow the remainder of the same canonical Question paragraph made the test accurately model the contract.

### Final byte record after review fix

- Full packaged source: 15,902 bytes at `2e87f6d9`; 14,943 bytes after the review fix.
- Loaded prompt body: 14,772 bytes at `2e87f6d9`; 13,813 bytes after the review fix.
- Removed from either measurement: 959 bytes.
- Full-source reduction: 6.0307%; loaded-body reduction: 6.4920%.
- Both are below 10%, so the review fix makes no context-performance, latency, resource, cost, or behavior-improvement claim.

### Review-fix verification

- Focused prompt/harness integration: `bun run --cwd packages/web test server/lib/opencode/packaged-agent-defaults.test.js server/opencode-agents.test.js server/lib/opencode/harness-preflight.test.js`
  - Exit 0; 3 files passed; 81 tests passed.
- Required affected validation: `bun run validate:affected`
  - Exit 0; web lint and type-check passed; 102 web test files and 872 tests passed.
- Workspace type-check: `bun run type-check`
  - Exit 0 across desktop, UI, web, Electron, and root packages.
- Workspace lint: `bun run lint`
  - Exit 0 across desktop, web, Electron, UI, and root packages.
- Remaining output is limited to the same unrelated Node deprecation warnings recorded above.
