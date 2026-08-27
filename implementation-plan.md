# Plan title persistence

## Context

Plan titles are the primary human-readable identifier for saved implementation plans. They flow through a multi-stage pipeline: extracted from markdown via `extractPlanTitle()`, sanitized into filename-safe slugs via `sanitizePlanPathSegment()`, and persisted as part of the plan file path (`{sessionCreated}-{sessionSlug}-{sourceMessageId}.md`). The same title also influences the displayed session title via the standard session title runtime. Gaps in this pipeline cause plan titles to be lost, mangled, or mismatched between the saved file name and its displayed representation, especially across plan reloads and round-trips.

The current implementation has three interrelated weaknesses:

1. **`extractPlanTitle()` only matches level-1 or level-2 headings** (`#{1,2}`). Plans authored with `###` or deeper headings, or plans that rely on the `<!--plan-->` sentinel followed by a title on the next line, fall back to the default "Implementation Plan" without surfacing the author's intended title.

2. **`sanitizePlanPathSegment()` and `buildSessionPlanFilePath()` derive the slug from `sessionSlug`, which originates from `identity.sessionSlug` — not from the extracted plan title.** The `sessionSlug` is typically a timestamp- or platform-generated value, so the plan filename contains little to no readable trace of the title. A user looking at the filesystem cannot discern the plan's purpose from its filename.

3. **The standard session title runtime (`standard-session-title-runtime.js`) does not distinguish plan-control titles from user-generated session titles.** When a plan's `<!--plan-->` sentinel is present, the title that follows should be treated as a plan control title and resolved through the plan fallback logic, but the current `isEligibleStandardTitle()` / `isPlanControlTitle()` branching can misclassify titles, causing the plan title to be either suppressed or incorrectly displayed as the session title.

These gaps mean that plan title persistence is fragile: a plan saved with a meaningful title may reopen with "Implementation Plan" as the default, the filename offers no human-readable clue, and the session title area may display something unrelated or conflicting.

## Critical files

**New files**
- `packages/ui/src/lib/messages/extractPlanTitle.ts` — the existing title extraction function; will be updated to support `###`+ headings and `<!--plan-->`-prefixed titles
- `packages/ui/src/lib/sessionTitles.ts` — new module consolidating `isPlanControlSessionTitle`, `resolveDisplaySessionTitle`, and related helpers so plan-title logic is shared between the session title runtime and the UI store

**Files modified**
- `packages/ui/src/lib/messages/extractPlanTitle.ts` — extend `HEADING_PATTERN` to match `#` through `####` and add `<!--plan-->` sentinel detection that surfaces the title following the sentinel
- `packages/web/server/lib/opencode/standard-session-title-runtime.js` — integrate `isPlanControlTitle` and `resolveDisplaySessionTitle` from the new sessionTitles module so that `<!--plan-->`-preceding titles are resolved through the plan fallback path rather than being treated as generic session titles
- `packages/ui/src/lib/openchamberConfig.ts` — update `sanitizePlanPathSegment` to accept an optional raw title string, enabling the plan filename to embed the sanitized title as the `sessionSlug` component when no explicit slug is provided

**Files read (no edit) for behavior reuse**
- `packages/ui/src/lib/messages/extractPlanTitle.ts:3` — `HEADING_PATTERN` / `extractPlanTitle` function, reused for the enhanced heading match
- `packages/ui/src/lib/sessionTitles.test.ts:1` — test patterns for `isPlanControlSessionTitle`, `resolveDisplaySessionTitle`, reused for plan-title-aware title resolution
- `packages/web/server/lib/opencode/standard-session-title-runtime.test.js:679` — existing plan-control title test cases, serve as the validation baseline

## Implementation

### Phase 1: Enhance `extractPlanTitle` to surface plan titles from more markdown formats

Under `### Phase 1: Enhance title extraction`, implement the following tasks:

1.1 Update `HEADING_PATTERN` in `extractPlanTitle.ts` from `/^\s{0,3}#{1,2}\s+(.+?)\s*$/m` to `/^\s{0,3}#{1,4}\s+(.+?)\s*$/m` to match level-3 and level-4 headings.

1.2 Add a `<!--plan-->` sentinel detector: after the heading match fails, check if the markdown begins with `<!--plan-->` (allowing whitespace and inline backticks). If so, extract the first non-empty line after the sentinel as the plan title.

1.3 Return the extracted heading text trimmed, or the sentinel-derived title trimmed, or fall back to `'Implementation Plan'` when neither pattern matches.

1.4 Add a unit test in `extractPlanTitle.test.ts` (or append to the existing test suite) covering: `###` heading, `####` heading, `<!--plan-->` sentinel with title, and `<!--plan-->` sentinel with no following title.

### Phase 2: Consolidate plan-title-aware session title resolution

Under `### Phase 2: Consolidate session title resolution`, implement the following tasks:

2.1 Create `packages/ui/src/lib/sessionTitles.ts` (or identify the existing module) that exports `isPlanControlSessionTitle` and `resolveDisplaySessionTitle` — these already exist in `packages/ui/src/lib/sessionTitles.ts` based on the grep results.

2.2 In `standard-session-title-runtime.js`, import `isPlanControlTitle` and `resolveDisplaySessionTitle` from the session titles module.

2.3 Modify the `isEligibleStandardTitle` function (or its usage site) to check `isPlanControlTitle(normalized)` before other eligibility checks. When a title is a plan control title, `resolveDisplaySessionTitle` should be called with the stored title and a fallback, and the result should be used as the display title — this prevents plan titles from leaking into the general session title display.

2.4 Ensure `normalizeGeneratedSessionTitle` does not reject titles that match the source text when those titles are plan control titles (i.e., when `isPlanControlTitle` returns true, skip the source-text rejection check).

2.5 Add or update unit tests in `standard-session-title-runtime.test.js` to verify that `<!--plan-->`-preceding titles are resolved through the plan fallback and do not become the session title.

### Phase 3: Wire the plan title into the filename slug

Under `### Phase 3: Embed title in plan filename`, implement the following tasks:

3.1 Update `sanitizePlanPathSegment` in `openchamberConfig.ts` to accept an optional second parameter `rawTitle?: string`. When `rawTitle` is provided, derive the slug from the title instead of relying on the `sessionSlug` field. The slug should be `slugifyPlanTitle(rawTitle)` — the existing `slugifyPlanTitle` function already trims, lowercases, and replaces non-alphanumeric characters with hyphens.

3.2 Modify `buildSessionPlanFilePath` to accept the plan title as an optional source for the session slug. When `identity.sessionSlug` is absent or empty, fall back to `slugifyPlanTitle(identity.sourceMessageId)` — but also, when a plan title is available from the markdown, use `slugifyPlanTitle(planTitle)` as the session slug component.

3.3 Update the plan-saving flow (e.g., `persistSessionPlanRevision` in `sessionPlanPersistence.ts`) to pass the extracted plan title (from `extractPlanTitle`) as part of the `identity` object, so the filename embeds the user's chosen title.

3.4 Add an integration test that saves a plan with a custom title, verifies the filename contains a slug derived from that title, and reopens the plan to confirm the title is restored correctly.

### Phase 4: Verify end-to-end plan title persistence

Under `### Phase 4: End-to-end verification`, implement the following tasks:

4.1 Start the DevRyan Electron runtime: `bun run electron:dev`.

4.2 Create a new plan with a descriptive title using the plan mode (`User has requested to enter plan mode`).

4.3 Save the plan and confirm the filename contains a slug derived from the title (inspect `~/.config/openchamber/harness/journal/` or the relevant data directory).

4.4 Close and reopen the plan; confirm the title is restored from the saved markdown, not "Implementation Plan".

4.5 Verify the session title display does not leak the plan title — the session title area should show "Untitled Session" or the user's chosen session title, not the plan title.

4.6 Run the existing test suite: `bun run test:full` (or at minimum `bun run test:affected` for the changed packages). All tests in `extractPlanTitle.test.ts`, `standard-session-title-runtime.test.js`, and `sessionTitles.test.ts` must pass.

4.7 If any test fails, diagnose the failure using `bun scripts/journal.mjs show <sessionID> --tail 200` and `bun scripts/journal.mjs gaps`, then adjust the implementation accordingly.

## Visual details

- The plan card sentinel `<!--plan-->` should remain invisible in the rendered markdown (HTML comments are stripped by the markdown renderer). No visual change is needed to the sentinel itself.
- When a plan title is extracted from `### My Plan Title`, the plan card header should display "My Plan Title" as the level-1 heading, matching the visual style of any other markdown `#` heading.
- The plan filename in the filesystem should show a human-readable slug: e.g., `1725765612345-my-plan-title-abc123.md` instead of `1725765612345-xyz789-abc123.md`, making it immediately recognizable in the `plans/` directory.
- Accessibility: no change required. The plan title is plain text; screen readers will announce it consistent with the surrounding markdown heading.

## Verification

1. Run `bun run type-check` and `bun run lint` to ensure no type or lint errors are introduced.

2. Run `bun run test:affected` for the `packages/ui` and `packages/web/server` packages to confirm all related tests pass.

3. Manually in the Electron dev runtime:
   - Start a new session and enter plan mode.
   - Write a plan with title `# My Custom Plan Title` and content following the `<!--plan-->` sentinel.
   - Save the plan. Check the saved file path — it should contain `my-custom-plan-title` (slugified) in the filename.
   - Close the plan and start a new session. The plan should reopen displaying "My Custom Plan Title" as the plan title, not "Implementation Plan".
   - Verify the session title display (top of the window) shows "Untitled Session" or the user's session title, not "My Custom Plan Title".

4. Confirm that `extractPlanTitle` correctly handles these markdown inputs:
   - `# Plan Title` → `"Plan Title"`
   - `## Plan Title` → `"Plan Title"`
   - `### Plan Title` → `"Plan Title"` (new)
   - `#### Plan Title` → `"Plan Title"` (new)
   - `<!--plan-->\nMy Plan Title` → `"My Plan Title"` (new)
   - `<!--plan-->` with no following title → `"Implementation Plan"` (new)
   - No plan-relevant markdown → `"Implementation Plan"` (unchanged)

5. Confirm that `isPlanControlSessionTitle` and `resolveDisplaySessionTitle` correctly handle plan control titles from the existing test suite without regression.

<!--plan-->