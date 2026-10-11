# Dedicated Claude profile sign-in and provider page trim (2026-10-11)

## Defect

Adding a dedicated Claude profile from Settings → Providers failed before any
sign-in opened. The page sends the active project directory, and the enrollment
binding in `packages/web/server/lib/opencode/runtime-host/native-runtime-owner.js`
accepted only directories in the bundle's static project map. A registered
project outside that map was refused with
`native_claude_enrollment_location_unreviewed`; the list call failed the same
way, and the page showed one generic recovery message for every refusal.

## Change

- `native-claude-enrollment-location.js` binds an unreviewed request directory
  to the default location and still refuses when no reviewed default exists.
- Enrollment route failures are journaled as `claude_enrollment_failed` with
  `{ action, code, statusCode }` only.
- The page reports load, start and confirmation failures separately.
- Claude compatibility mode moved into Connection Details; status and
  dedicated-profile copy were shortened.

## Verification

Passed:

- `packages/web` vitest: `provider-routes.test.js`,
  `native-claude-enrollment-location.test.js`, `native-claude-enrollment.test.js`,
  `native-claude-inspection.test.js`, `native-runtime-owner.test.js`
  (5 files, 146 tests).
- `packages/ui` through `scripts/test-ui.mjs`: every test in
  `src/components/sections/providers` plus `controlCopy.test.ts` (0 failures).
- `bun run validate:full`: workspace lint and type checks passed; all suites
  before `packages/web` passed.

Not passed or unavailable:

- `bun run validate:full` exited nonzero: 4 of 6577 `packages/web` tests failed
  (`quota/routes.test.js`, `native-integration-owner.test.js`, and timeouts in
  `bundle-harness-integrity.test.js` and `native-session-removal.test.js`).
  None exercise the files changed here, the first two files were being edited
  by concurrent uncommitted work, and all four files passed when rerun alone.
  A clean full run was not obtained.
- Live verification was not performed. The isolated host diagnostic
  (`scripts/qa/native-profile-factory-diagnostic.mjs --hold-chatgpt-signin`)
  stopped on an unrelated assertion from concurrent uncommitted edits to that
  script. The fix has therefore not been observed against a running runtime,
  and the steps after the location binding (legacy-fence migration and the
  keychain probe) have never been observed to pass on this machine.
