// Live prompts for the disposable onehealth-connector copy. Each one states
// what the orchestration setup must show.
const NO_QUESTIONS = ' Do not ask me questions; make reasonable choices and finish.';

export const CASES = {
  // L0: a trivial change the orchestrator should make itself.
  'l0-direct': { expect: 'zero children; the root edits the file itself', timeoutMinutes: 10,
    prompt: 'Add the single line comment "// live-test marker" as the first line of apps/web/src/utils/flags.ts. That is the whole task: one line in one file. Do it directly without delegating and without running tests.' + NO_QUESTIONS },
  // L11: read-only review through Oracle, then a Council decision.
  'l11-review-council': { expect: 'Oracle route (Anthropic via Meridian) and a council_session call (Council route); no writes', timeoutMinutes: 30,
    prompt: 'Two read-only steps. (1) Have the Oracle review apps/web/src/utils/retryWithBackoff.ts for correctness and edge cases (negative or zero attempts, jitter bounds, abort handling) and report at most five findings. (2) Then convene the Council on one question: should the default backoff multiplier in that file stay as it is or change to 2, given the findings? Report the Council decision with its reasoning. No code changes.' + NO_QUESTIONS },
  // L1: small bug fix in one file.
  'l1-fix': { expect: 'one Fixer owns it; edits take seconds', timeoutMinutes: 25,
    prompt: 'In apps/web/src/utils/formatDisplayName.ts, formatDisplayName repeats the title when the name already starts with it: formatDisplayName("Dr. John Doe", "Dr.") returns "Dr. Dr. John Doe". It must return "Dr. John Doe" (compare case-insensitively). Fix it and add a test file apps/web/src/utils/__tests__/formatDisplayName.test.ts covering this and the existing behaviour. Run only that test file with vitest.' + NO_QUESTIONS },
  // L3: a question that needs current external documentation.
  'l3-research': { expect: 'Librarian starts beside Explorer, same dispatch', timeoutMinutes: 25,
    prompt: 'According to the current official Playwright documentation, what does the webServer "gracefulShutdown" option do and what is its default? Give me the documentation URL. Also list which Playwright config files in this repository define a webServer. No code changes.' + NO_QUESTIONS },
  // L4: two unrelated changes in different subsystems.
  'l4-two-fixers': { expect: 'two Fixers in one dispatch, overlapping in time', timeoutMinutes: 30,
    prompt: 'Two unrelated changes. (1) apps/web/src/utils/retryWithBackoff.ts: add an optional fourth parameter maxDelay (milliseconds, default no cap) so the computed delay never exceeds it, and extend apps/web/src/utils/__tests__/retryWithBackoff.test.ts. (2) packages/domain/src/searchLimits.ts: add clampSearchQuery(query: string): string that trims the query and truncates it to SEARCH_QUERY_MAX_LENGTH, with a new test file packages/domain/src/searchLimits.test.ts. Run each test file with vitest.' + NO_QUESTIONS },
  // L5: behaviour change plus visual change, disjoint files, contract stated up front.
  'l5-fixer-designer': { expect: 'Fixer and Designer in one dispatch; cross-scope checks once, at the end', timeoutMinutes: 45,
    prompt: 'Add a compact rating display. Behaviour: add RatingUtils.formatCompact(rating, reviewCount) to apps/web/src/utils/ratingUtils.ts returning for example "4.7 · 120", and "New" when there is no valid rating, with tests in apps/web/src/utils/__tests__/ratingUtils.test.ts. Visual: create apps/web/src/components/common/CompactRatingBadge.tsx, a small pill with a star icon that takes one prop, label: string (the already formatted text), styled with the existing design tokens, with a render test beside it. The component only receives the formatted label, so the two parts do not depend on each other. Keep visual verification to the render test; do not start a dev server.' + NO_QUESTIONS },
  // L6: plan mode, then Implement Plan, with independent phases.
  'l6-plan-implement': { expect: 'plan phases state Owner and Depends on; independent phases dispatched together', timeoutMinutes: 60, plan: true,
    followUps: ['Implement plan.'],
    prompt: 'Add an "opening soon" hint. Behaviour: in apps/web/src/utils/openingHours.ts add minutesUntilOpen(hours, now) returning the minutes until the next opening today, or null when already open or not opening today, with tests. Visual: a new presentational component apps/web/src/components/common/OpeningSoonHint.tsx that takes minutes: number and renders "Opens in N min" as a subtle inline hint with the existing design tokens, with a render test beside it. The component only receives the number. Keep visual verification to the render test; do not start a dev server.' + NO_QUESTIONS },
  // L7: four independent areas to map.
  'l7-four-areas': { expect: 'four or more children in one dispatch', timeoutMinutes: 30,
    prompt: 'Read-only. Map how these four independent areas work and give me the entry points and main functions of each: (1) search limits and query validation under packages/domain/src/search and packages/domain/src/searchLimits.ts; (2) the booking utilities under apps/web/src/utils/booking and bookingCalendar.ts; (3) the CSV import processors apps/web/src/utils/csv*.ts and enhancedCsvProcessor.ts; (4) opening hours in apps/web/src/utils/openingHours.ts and clinicHeroOpeningStatus.ts. No code changes.' + NO_QUESTIONS },
  // L8: a check that starts and stops its own dev server.
  'l8-dev-server': { expect: 'the browser command returns when its tests finish; no idle tail', timeoutMinutes: 30,
    prompt: 'Add a self-contained browser smoke check. Create tests/e2e/livetest-static-server.mjs (a tiny node:http server on 127.0.0.1:8123 serving one HTML page with <h1 id="ready">ready</h1>), playwright.livetest-smoke.config.ts (chromium only, one worker, line reporter, webServer running "node tests/e2e/livetest-static-server.mjs" with url http://127.0.0.1:8123 and reuseExistingServer false, testDir tests/e2e, testMatch livetest-smoke.spec.ts, outputDir .artifacts/livetest-smoke) and tests/e2e/livetest-smoke.spec.ts asserting the heading text. Then run "npx playwright test --config=playwright.livetest-smoke.config.ts" and report the result.' + NO_QUESTIONS },
  // L9: many edits in one child.
  'l9-many-edits': { expect: 'per-edit overhead stays in seconds across 12+ edits', timeoutMinutes: 40,
    prompt: 'In each of these 12 files add a one-line JSDoc summary above every exported function that has none, without changing behaviour: apps/web/src/utils/retryWithBackoff.ts, apps/web/src/utils/nullToUndefined.ts, apps/web/src/utils/nullConversion.ts, apps/web/src/utils/color.ts, apps/web/src/utils/flags.ts, apps/web/src/utils/sanitizeSearch.ts, apps/web/src/utils/normalizeStorageHost.ts, apps/web/src/utils/platformInfo.ts, apps/web/src/utils/entityNameHelper.ts, apps/web/src/utils/navigationUtils.ts, apps/web/src/utils/locationParsing.ts, apps/web/src/utils/errorMessages.ts. This is one coherent change for one Fixer. Edit file by file. No tests are needed; run eslint on those files at the end.' + NO_QUESTIONS },
  // L13: three implementers at once, two behaviour changes and one visual.
  'l13-three-way': { expect: 'three implementing children in one dispatch, all overlapping', timeoutMinutes: 45,
    prompt: 'Three unrelated changes. (1) apps/web/src/utils/nullToUndefined.ts: add an exported helper emptyToUndefined(value: string | null | undefined): string | undefined that returns undefined for null, undefined and whitespace-only strings and the trimmed string otherwise, with a new test file apps/web/src/utils/__tests__/emptyToUndefined.test.ts. (2) packages/domain/src/directoryEntityTabOrder.ts: add isDirectoryEntityTabId(value: unknown): value is DirectoryEntityTabId, with tests added to packages/domain/src/directoryEntityTabOrder.test.ts. (3) Visual: create apps/web/src/components/common/EntityTypePill.tsx, a small pill that takes label: string and tone: "neutral" | "accent" and uses the existing design tokens, with a render test beside it. None of the three depends on another. Run each test file with vitest; do not start a dev server.' + NO_QUESTIONS },
  // L12: Stop while a confined command is running.
  'l12-stop': { expect: 'after Stop the change record is complete (no incomplete-record banner)', timeoutMinutes: 10, abortAfterSeconds: 45,
    prompt: 'Do this yourself, without delegating: run the shell command "sleep 300; echo done" with a timeout of ten minutes and tell me its output.' },
  // L10: the parent turn ends while a child is still running.
  'l10-parent-resume': { expect: 'the parent resumes by itself when the result arrives and reports it', timeoutMinutes: 30,
    prompt: 'Start one Explorer to map how apps/web/src/utils/openingHours.ts is used across the app. After starting it, do not wait for it: end your turn immediately with the single sentence "Explorer started." When its result is delivered to you later, summarise it in five bullet points.' },
};
