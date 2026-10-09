# Live journeys on OpenCode 1.18.33 (baseline)

Isolated hosts (`.cache/livetest/launch-host.mjs`, `preserveOrchestration` + `mirrorPersonalSetup`), workspace copies of `onehealth-connector`, Orchestrator `openai/gpt-6-astra`. One run per case. Times are wall-clock seconds from the first prompt; "first token" is the message-level proxy (assistant message created → first reasoning/text/tool part start), p50 over the case's assistant messages.

| Case | Expectation | Outcome | Total s | Dispatches (agents; overlap s) | Tools (n, p50 s / p90 s) | First token p50 root / child (ms) | Change record |
|---|---|---|---|---|---|---|---|
| `l0-direct` (p0a) | zero children; the root edits the file itself | settled; turns 54s | 54 | none | apply_patch 1, 19.8/19.8, read 2, 2.1/2.1, skill 1, 2.6/2.6 | 3215 / None | complete (1 files) |
| `l1-fix` (p0a) | one Fixer owns it; edits take seconds | settled; turns 236s | 236 | fixer (0) | apply_patch 2, 12.0/12.0, bash 2, 30.7/30.7, glob 2, 1.7/1.7, grep 2, 2.8/2.8, read 11, 1.1/2.4, skill 3, 0.5/0.8 | 5444 / 4625 | complete (2 files) |
| `l1-fix` (p0d) | one Fixer owns it; edits take seconds | settled; turns 192s | 193 | fixer (0) | apply_patch 2, 7.2/7.2, bash 2, 20.1/20.1, glob 4, 1.6/1.9, grep 1, 1.8/1.8, read 12, 0.8/1.4, skill 3, 0.7/3.0 | 4348 / 4458 | complete (2 files) |
| `l10-parent-resume` (p0b) | the parent resumes by itself when the result arrives and reports it | settled; turns 91s | 91 | explorer (0) | grep 8, 0.7/0.8, read 8, 0.4/0.9 | 3565 / 3344 | complete (0 files) |
| `l11-review-council` (p0b) | Oracle route (Anthropic via Meridian) and a council_session call (Council route); no writes | settled; turns 45s | 45 | oracle (0) | skill 1, 0.5/0.5, todowrite 1, 2.1/2.1 | 2833 / None | complete (0 files) |
| `l12-stop` (p0a) | after Stop the change record is complete (no incomplete-record banner) | settled (1 tool errors); turns 51s | 51 | none | bash 1, 39.9/39.9, skill 1, 0.4/0.4 | 2853 / None | complete (0 files) |
| `l13-three-way` (p0c) | three implementing children in one dispatch, all overlapping | settled (1 tool errors); turns 361s | 361 | fixer+fixer+designer+designer (106) | apply_patch 2, 26.5/26.5, bash 10, 21.2/44.6, glob 3, 1.0/1.9, grep 4, 0.9/1.3, read 17, 0.8/2.9, skill 3, 0.5/1.0, todowrite 1, 1.6/1.6, write 2, 26.3/26.3 | 5466 / 3871 | complete (6 files) |
| `l3-research` (p0a) | Librarian starts beside Explorer, same dispatch | settled; turns 117s | 117 | explorer+librarian (35) | glob 1, 0.9/0.9, grep 4, 1.5/1.8, read 8, 2.2/2.7, skill 1, 0.6/0.6, webfetch 2, 16.9/16.9 | 6377 / 3241 | complete (0 files) |
| `l4-two-fixers` (p0b) | two Fixers in one dispatch, overlapping in time | settled; turns 295s | 297 | fixer+fixer (141) | apply_patch 3, 26.7/51.6, bash 2, 54.2/54.2, glob 3, 3.2/3.5, grep 1, 1.9/1.9, read 16, 1.1/2.3, skill 3, 0.7/1.2, todowrite 2, 2.4/2.4 | 4490 / 4866 | complete (4 files) |
| `l4-two-fixers` (p0d) | two Fixers in one dispatch, overlapping in time | settled; turns 178s | 178 | fixer+fixer (79) | apply_patch 2, 8.9/8.9, bash 2, 14.0/14.0, glob 3, 0.9/1.0, grep 2, 1.4/1.4, read 17, 0.5/0.9, skill 4, 0.4/0.6, todowrite 3, 0.9/1.1 | 4021 / 3870 | complete (4 files) |
| `l5-fixer-designer` (p0c) | Fixer and Designer in one dispatch; cross-scope checks once, at the end | settled; turns 405s | 406 | fixer+designer (93) | apply_patch 1, 21.7/21.7, bash 8, 21.1/42.0, glob 1, 0.6/0.6, grep 1, 1.1/1.1, read 10, 0.8/1.2, skill 2, 5.6/5.6, todowrite 4, 1.2/2.0, write 2, 33.0/33.0 | 4729 / 3399 | complete (4 files) |
| `l5-fixer-designer` (p0d) | Fixer and Designer in one dispatch; cross-scope checks once, at the end | settled; turns 123s | 123 | fixer+designer (3) | apply_patch 1, 5.9/5.9, bash 1, 8.8/8.8, glob 2, 1.1/1.1, read 6, 0.3/0.8, skill 2, 0.3/0.3, todowrite 1, 0.9/0.9 | 3593 / 4180 | complete (2 files) |
| `l7-four-areas` (p0a) | four or more children in one dispatch | settled; turns 235s | 235 | explorer+explorer+explorer+explorer (62) | glob 5, 2.5/3.6, grep 18, 2.4/3.3, read 38, 2.8/4.8, skill 1, 0.7/0.7, todowrite 3, 1.1/6.1 | 4262 / 2785 | complete (0 files) |
| `l8-dev-server` (p0c) | the browser command returns when its tests finish; no idle tail | settled; turns 153s | 154 | fixer (0) | apply_patch 1, 8.9/8.9, bash 1, 18.5/18.5, glob 3, 1.7/2.2, read 7, 0.5/1.9, skill 2, 0.4/0.4, todowrite 2, 1.6/1.6 | 3922 / 6230 | complete (4 files) |
| `l9-many-edits` (p0b) | per-edit overhead stays in seconds across 12+ edits | settled; turns 411s | 411 | fixer (0) | apply_patch 6, 16.1/21.0, bash 1, 65.3/65.3, glob 1, 0.4/0.4, grep 1, 0.5/0.5, read 16, 1.1/1.8, skill 2, 0.6/0.6, todowrite 6, 1.9/2.3 | 3283 / 6231 | complete (6 files) |

## Per-case notes

### `l0-direct` (p0a)
- final: Added `// live-test marker` as the first line of `apps/web/src/utils/flags.ts`. No other changes, delegation, or tests.

### `l1-fix` (p0a)
- fixer completed 170s kind=start collected+8s 
- final: src/utils/__tests__/formatDisplayName.test.ts` covering the regression and existing behavior.  Ran only `npx vitest run apps/web/src/utils/__tests__/formatDisplayName.test.ts`; Vitest could not start because dependency `tinyglobby` is missing. Tests remain unverified until dependencies are restored.

### `l1-fix` (p0d)
- fixer completed 129s kind=start collected+6s 
- final: refix check, preserving original casing and trimming behavior.  Added `apps/web/src/utils/__tests__/formatDisplayName.test.ts` covering the regression and existing behavior.  Ran only `npx vitest run apps/web/src/utils/__tests__/formatDisplayName.test.ts`: **13 tests passed**. No remaining blockers.

### `l10-parent-resume` (p0b)
- explorer completed 50s kind=start collected+11s 
- final: emains unconfirmed. - **Tests and scope:** Coverage was located in `openingHours.test.ts`, `useClinicDetails.utils.test.ts`, and `clinicHeroOpeningStatus.test.ts`. `normalizeTime` has no direct production caller outside its own module. This was read-only discovery: no files changed and no tests ran.

### `l11-review-council` (p0b)
- oracle failed 3s kind=start collected+Nones provider_usage_limit
- final: Oracle hit a provider usage limit; automatic recovery is scheduled, Council awaits its findings, and no files have changed.

### `l12-stop` (p0a)
- tool errors: root/bash: Tool execution aborted
- final: 

### `l13-three-way` (p0c)
- fixer completed 124s kind=start collected+15s 
- fixer completed 106s kind=start collected+44s 
- designer completed 196s kind=start collected+15s 
- designer failed 55s kind=start collected+Nones provider_usage_limit
- tool errors: root/read: File not found: <HOME>/.cache/devryan-livetest/p0c/workspace/design-rules/README.md
- final: All three Vitest files passed; final completion is paused by a provider limit while correcting the pill’s text contrast.

### `l3-research` (p0a)
- explorer completed 47s kind=start collected+9s 
- librarian completed 35s kind=start collected+30s 
- final: .profile-inline-motion.config.ts:12` - `playwright.service-package-navigation.config.ts:15` - `admin-review-sync.visual.config.ts:15` - `tests/e2e/health-document.config.ts:16` - `playwright.mfa.config.ts:23`  All use `undefined` except `playwright.mfa.config.ts`, which uses `[]`.  No files changed.

### `l4-two-fixers` (p0b)
- fixer completed 206s kind=start collected+8s 
- fixer completed 141s kind=start collected+72s 
- final: test.ts`: Vite could not load `tsconfig.app.json`. - `npx vitest run packages/domain/src/searchLimits.test.ts`: Vite could not resolve `tinyglobby`.  Changes are unverified at runtime. Shared configuration and dependencies were left untouched; resolve those environment errors and rerun the commands.

### `l4-two-fixers` (p0d)
- fixer completed 86s kind=start collected+6s 
- fixer completed 79s kind=start collected+23s 
- final: y: string)` trims, then truncates to `SEARCH_QUERY_MAX_LENGTH`.  Verification: - `npx vitest run apps/web/src/utils/__tests__/retryWithBackoff.test.ts`: **5 tests passed**. - `npx vitest run packages/domain/src/searchLimits.test.ts`: **7 tests passed**.  No outstanding issues in the requested scope.

### `l5-fixer-designer` (p0c)
- fixer completed 115s kind=start collected+13s 
- designer completed 215s kind=start collected+7s 
- final: do as blocked and deferred, not passed. The formatter, badge, and tests are implemented; both test suites stop during setup because `tsconfig.app.json` is missing.  No additional files changed. The next step is to restore the repository’s original test configuration and rerun the two focused suites.

### `l5-fixer-designer` (p0d)
- fixer completed 82s kind=start collected+5s 
- designer failed 3s kind=start collected+Nones provider_usage_limit
- final: The formatter is implemented with 57 tests passing; the badge is blocked by a provider rate limit, with automatic recovery scheduled.

### `l7-four-areas` (p0a)
- explorer completed 91s kind=start collected+11s 
- explorer completed 49s kind=start collected+55s 
- explorer completed 79s kind=start collected+19s 
- explorer completed 62s kind=start collected+27s 
- final: es are not evaluated. Apart from 24-hour detection, status evaluation expects canonical `openTime`/`closeTime` values.  ---  **Read-only verification:** traced source definitions, exports, and immediate callers across all four areas. No files changed and no tests or runtime operations were executed.

### `l8-dev-server` (p0c)
- fixer completed 87s kind=start collected+6s 
- final: erver.mjs` - `playwright.livetest-smoke.config.ts` - `tests/e2e/livetest-smoke.spec.ts`  Ran `npx playwright test --config=playwright.livetest-smoke.config.ts`: **1 passed (1.5s)**.  This verifies the standalone HTTP server and Chromium heading assertion, without application or backend dependencies.

### `l9-many-edits` (p0b)
- fixer completed 351s kind=start collected+9s 
- commands over 60 s: 65s `npx eslint apps/web/src/utils/retryWithBackoff.ts apps/web/src/utils/nullToUndef`
- final: Added 8 one-line JSDoc summaries across 6 files. The other 6 files were already documented and left unchanged. No behavior changes.  ESLint ran on all 12 files: **0 errors, 27 existing warnings**. No tests were run, as requested.

