# Safe browser inspection and caller-evaluation diagnostics

## Incident evidence

Administrator Error Log event `789c0c55-69bb-5a2e-a0f8-6f10104ac82b`
was resolved through its detail API before examining the journal. The event
correlates to session `ses_fabc85566ffe6tFmBYAM8iX5Ws` and tool call
`call_aiB7AUnnuiasVY14B3bdBIiw`.

At **2026-08-30 22:52:05.631 UTC**, a caller-authored `devryan_browser eval`
queried a tooltip that had been closed approximately 19 seconds earlier,
then passed the missing element to `getComputedStyle`. Chromium rejected
the call because the argument was not an Element. The error reached OpenCode
as a string beginning `DEVRYAN_BROWSER_COMMAND_FAILED:`, without a structured
error code, and was classified as an actionable integration failure.

The journal retained the command and subsequent successful browser commands.
`bun scripts/journal.mjs gaps` returned no gap records. Those subsequent
successes do not by themselves prove an authoritative terminal recovery:
the historical Error Log outcome remains `unknown`. No historical event or
production session was rewritten, cleared, or restarted by this change.

## Changes

- `devryan_browser inspect` accepts a CSS selector and optional CSS property
  and attribute name arrays. Input validation runs before lease acquisition.
  A single synchronous page evaluation returns `found`, `missing`, or
  `ambiguous`, with values read only for exactly one match. It never reopens,
  retries, hovers, or modifies a page on behalf of the caller.
- Invalid CSS selectors produce `DEVRYAN_BROWSER_INPUT_INVALID`. Invalid,
  truncated, or mismatched inspection responses and unexpected generated
  script failures use `DEVRYAN_BROWSER_INSPECTION_FAILED`, keeping them
  actionable even if their details contain input-error wording. Existing output sanitization and
  limits, lease scope, cancellation, and cleanup remain in force.
- Explicit CLI evaluation envelopes for caller `TypeError`, `ReferenceError`,
  and `SyntaxError` become `DEVRYAN_BROWSER_EVAL_ERROR`; the tool still fails
  and returns sanitized details plus corrective guidance. Other failures are
  not broadly reclassified.
- The diagnostic classifier recognizes the two browser input codes through
  structured metadata or an exact leading string prefix. A supplied
  structured code takes precedence. Other tools and historical inference
  keep their prior behavior.
- If an expected script/input failure coincides with a failed final lease
  refresh, the host failure stays primary and actionable, with sanitized
  script details retained as secondary context. Input-error wording cannot
  override that host failure in either structured or string event form.
- Managed browser guidance now prefers `inspect` for DOM/style reads and
  explains null-safe same-evaluation checks for transient animation states.
  Provisioning upgrades untouched managed copies and preserves modified
  copies with an explicit conflict.

## Verification

The four focused web suites pass **209 tests**, covering the browser plugin,
diagnostic classification, audit projection, and skill provisioning, including
simultaneous script and lease-refresh failures. Final `bun run lint` passed.
JavaScript syntax checks, `git diff --check`, and all seven test-discovery
contract checks passed as well.

```sh
bun run --cwd packages/web test \
  server/default-config/plugins/devryan-browser.test.mjs \
  server/lib/multi-user/error-diagnostics.test.js \
  server/lib/multi-user/activity-projection.test.js \
  server/lib/agent-browser/install.test.js
node packages/electron/tests/browser-inspection/run.mjs
```

The isolated Electron fixture uses the pinned workspace Electron binary,
temporary repository-local profile directories, an in-memory partition,
blocked network access, and a data-URL document. It verifies computed style
values, a custom CSS property, absent attributes, tooltip removal, repeated
missing observations, ambiguous matches, invalid CSS, and quoted selectors.
It also reproduces the original Chromium exception once. It loads neither
the production runtime nor its authentication, audit, or journal stores.

`bun run validate:affected` selected the full repository gate because the
workspace already contained unrelated changes across packages, scripts, and
database migrations. Its lint stage passed, but its `bun run type-check`
stage did not complete within a 15-minute observation window and emitted no
TypeScript diagnostics. The validation-owned processes were stopped; the
subsequent full-test stage was not reached. A separately started duplicate
`bun run type-check` was stopped earlier to avoid duplicate compiler load.
These checks are **incomplete, not passing**, and no unrelated source changes
were made to bypass them. A full type-check/affected-gate rerun is still needed
before claiming repository-wide validation is green.

Packaging verification passed 36 asset/catalog/managed-plugin tests and three
targeted overlay tests. Repository-local staging copied all 28 canonical
assets, including 14 runtime plugins, verified exact source bytes, excluded
the browser test module, and successfully imported the staged browser plugin
with its loader-compatible exports. This was not a full distributable build.

## Delivery boundary

No dependency, database migration, unsupported host capability, or production
restart is included. Existing packaging/provisioning delivers the new plugin
and guidance with the next normal application update/restart. Arbitrary
caller-authored JavaScript may still fail; the supported inspection command
handles the missing-element case deterministically and remaining script
failures stay explicit.
