# Tier 1 + selected Tier 2 integration record

Date: 2026-08-02

## Scope and base

- Canonical repository: DevRyan only. No upstream or external repository was inspected, fetched, cloned, or compared.
- Captured base: `0841a8c4b80bd5a94bc06a811356c60af458f619`.
- Integration branch: `port/tier-1-2-integration`.
- Feature branches, merged with `--no-ff` in this order:
  1. `port/github-hardening`
  2. `port/git-worktree-fixes`
  3. `port/server-misc`
  4. `port/ui-fixes`
- The original dirty checkout remained on `main`. Its porcelain-status SHA-256 was
  `0e053b78c8aff7028062776ebfa4ae984a3559c6cd8e23240b719dcb06f12c10`
  before work and remained identical after implementation and manual checks.

## Integrated behavior groups

### GitHub and PR status

- Added bounded PR-status refresh concurrency at four while retaining the existing
  request timers, signature deduplication, counters, and request tracking.
- Preserved partial Zustand updates and deterministic target ordering.
- Resolved independent remote and repository metadata work concurrently without
  changing candidate ranking or repository deduplication.
- Skipped PR resolution before remote work when the requested directory no longer exists.
- Added rate-limit cooldown tracking that remains distinct from authentication loss.
- Added a shared GitHub API-client factory and timeout-aware fetch wrapper. Stored-token
  and optional CLI credential selection remain intact, and OAuth clients use the same factory.
- Updated GitHub module documentation and its codemap.

### Git worktrees and project isolation

- Added bounded index-lock recovery to web and VS Code receipt-driven worktree population.
  Recovery deletes only an unchanged lock and does not mask non-lock failures.
- Suppressed expected deletion-race logging while preserving the existing rejection contract.
- Required a non-empty directory for repository clients, added a stable global-config
  client, and bound status collection to the exact requested repository root.
- Kept `/api/git/check` and `/api/git/status` aligned for repository roots, nested
  non-repository directories, and missing directories.
- Added `applyHunk` coverage under the stricter Git client contract.
- Updated web Git documentation, VS Code Git documentation, and their codemaps.

### Server behavior

- Registered a tested indexing-policy module after `trust proxy` and before application routes.
- Every response receives `X-Robots-Tag: noindex, nofollow`.
- `/robots.txt` returns the exact body `User-agent: *\nDisallow: /` as plain text with
  `Cache-Control: no-store`.
- The returned server controller exposes the managed runtime port but returns `null`
  when startup is skipped or the runtime is externally managed. Internal route wiring
  retains the actual runtime port it needs.
- Updated the server codemap for both focused modules.

### Shared UI

- Number steppers use an authoritative pending value so repeated desktop/mobile changes,
  decimal steps, blur commits, and min/max clamping do not drift before parent rerenders.
- Shell tool handling uses one predicate for `bash`, `shell`, `shell_command`, `cmd`, and
  `terminal`; icons, names, specialized content, and permission-pattern filtering share it.
- Glob patterns are the tool-description fallback and are also propagated into DevRyan's
  grouped search-row presentation. This grouped-row adaptation was added after live visual
  verification showed that the initial ToolPart-only path was bypassed by activity grouping.
- Slash-command routing reads the skill catalog imperatively through `getState()` when
  command snapshots are unavailable, without adding a store subscription.
- Pending questions and permissions take priority in the pure activity resolver and force
  idle/send state through the existing narrow hooks.

## Already covered and inapplicable work

- Existing ToolPart regressions already cover object and array coercion, circular runtime
  values, `Error` objects, malformed todo rows, and non-array todo payloads. No unique input
  shape remained, so no duplicate issue-named test or production change was added.
- Send-time question dismissal, including descendant questions and expected already-gone
  responses, was already implemented and tested. It was retained unchanged.
- Deleted account-path behavior was not restored.
- No new Tauri feature work was required; the server/shared UI changes apply to the Electron
  target, web runtime, and VS Code parity surfaces described above.

## Automated validation

- Clean base: `bun run validate:full` passed before editing (Electron web assets were built
  first, as required by the existing validation contract).
- `port/github-hardening`: web tests (1,193), UI tests (2,173), and affected validation passed.
- `port/git-worktree-fixes`: web tests, VS Code Vitest (150), VS Code Bun tests (17), and
  affected validation passed.
- `port/server-misc`: web tests (1,188 after the controller-boundary correction) and affected
  validation passed.
- `port/ui-fixes`: UI tests (2,185 after the grouped-glob adaptation), UI type-check, and UI
  lint passed.
- Every integration merge range was validated with `VALIDATE_BASE` set to its pre-merge ref.
  The final UI merge range passed with 2,189 UI tests plus dependent web/VS Code type-checks.
- Focused integrated UI regressions passed: 185 tests covering number values, all shell aliases,
  pattern deduplication, glob descriptions, slash-command routing, and pending-question activity.
- Final-suite commands and their results are recorded below after the integration-record commit.

## Manual and visual verification

- Managed runtime controller: returned a non-null managed OpenCode port and reported ready.
- External runtime controller: returned `null`; stopping DevRyan logged that external shutdown
  was skipped, and the external OpenCode health endpoint remained healthy afterward.
- Indexing policy: live `curl` checks confirmed the exact robots body, plain-text content type,
  no-store policy, and indexing header on robots, `/health`, and a real terminal 404 response.
- Git lock recovery: a real disposable worktree with an unchanged `index.lock` recovered on
  retry. Replacing the lock during the wait preserved the replacement and surfaced the
  original lock failure.
- Git isolation: live routes returned `isGitRepository: true` for a disposable repository root,
  while both check and status returned non-repository results for a nested project directory.
- Number input: the rendered speech-rate decimal stepper moved exactly `1.0 -> 1.5 -> 1.0`
  across repeated increment/decrement clicks without drift.
- Shell/glob tools: an authorized prompt in `/Users/zoubair/Repositories/Test` produced one
  shell-command row and a glob row visibly labeled `Searched 1 file  *.md`.
- Skill routing: `/using-superpowers ...` completed with `SKILL_ROUTE_OK`; the empty-command-
  snapshot transport fallback remains proven by its deterministic store regression.
- Pending question: a structured Alpha/Beta question remained actionable while the composer
  showed `Send Message` rather than `Stop Generating`.
- `/Users/zoubair/Repositories/Test` remained clean after the prompt checks.

## Blockers and handoff

- Live PR resolution was not run because the approved local Test repository has no remote or
  pull request. Repository discovery outside the supplied local artifacts was prohibited, so
  concurrency, cooldown, ordering, missing-directory, authentication distinction, and timeout
  behavior were verified deterministically instead.
- The original checkout still contains owner-managed WIP, including an overlapping
  `packages/ui/src/components/chat/message/parts/toolRenderUtils.test.ts` edit. Its complete
  status is byte-for-byte unchanged, but this remains a reconciliation blocker for merging the
  integration branch into dirty `main`.
- The integration branch was deliberately not merged into `main`.

## Final validation results

- `VALIDATE_BASE=0841a8c4b80bd5a94bc06a811356c60af458f619 bun run validate:affected`
  passed. UI, web, and VS Code lint/type checks passed; UI reported 2,189 tests,
  web 1,210, and VS Code 150 Vitest plus 17 Bun tests.
- `bun run validate:full` passed after preparing the existing Electron web-assets
  prerequisite. Workspace-wide lint, type-check, script tests, runtime tests, Electron
  tests, UI tests, web tests, and VS Code tests all completed successfully.
- `bun run build` passed for every workspace. Existing Vite chunk-size/eval warnings and
  VS Code's existing CJS `import.meta` warnings remained non-fatal.
- `git diff --check 0841a8c4b80bd5a94bc06a811356c60af458f619...HEAD` and the working-tree
  `git diff --check` both passed.
