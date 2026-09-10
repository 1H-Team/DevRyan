# DevRyan 1.2.1 pre-release verification

Reviewed on 2026-09-10 (Africa/Casablanca), against the release working tree based
on `a82ca5fff1c5ccace020b02316c8b14ff1f4040c`. The retained results correctly record
that base revision and `dirty: true`; they do not claim to test a later clean tag.

## Local gates

- `bun run validate:full`: passed, including lint, types, documentation and all
  deterministic workspace suites. Initial failures were corrected: two loopback
  tests now allow host scheduling time without changing their exact assertions;
  recovery fixtures canonicalize macOS temporary paths; packaged-agent assertions
  reflect the updated prompts while preserving their line cap.
- `bun run build`: passed (production web assets and Electron JavaScript bundle).
- `bun run bundle:check`: passed; initial JavaScript 4,714,134 bytes raw and
  1,386,114 bytes gzip, within the recorded budgets.
- `bun run --cwd packages/electron build:web-assets`: passed before final QA.
- `git diff --check`: passed.

## Session changes acceptance

| Host | Result | Checks | Original PNGs reviewed |
| --- | --- | --- | --- |
| Web, 1280px and 390px, both themes | [Passed](web/result.json) | 26/26 | 41/41 |
| Actual development Electron host, 1280px and 600px, both themes | [Passed](electron/result.json) | 26/26 | 41/41 |

Both runs used isolated profiles and deterministic loopback providers. They
verified exact session ownership, independent-writer exclusion, live receipt SSE,
late receipt repair without reload, 28 native receipts beyond the 24-item preview,
pending-to-settled reconciliation, segment navigation and patch pagination,
child selection/reload, precise capture limitations, conflict rejection, and
Undo/Redo preserving unrelated files. Both recorded no console or cleanup errors.
Journal `gaps --verify` exited zero for both retained journals, with zero gap
records and no journal errors in diagnostic health.

Every original PNG was inspected. Session-change cards, diff navigation,
limitations, and confirmation controls remain readable and usable in all tested
layouts. The 600px Electron chrome is cramped, but does not obscure these controls.
One dark mobile child-reload capture temporarily labels the composer context
“New session”; the selected child's exact change card remains correct. This is
not a claim of complete mobile navigation or physical-device acceptance.

Selected evidence: [web recovery](web/changes-after-late-recovery.png),
[web native settlement](web/changes-native-settled.png),
[web narrow confirmation](web/changes-dark-390-undo-confirmation.png),
[Electron recovery](electron/changes-after-late-recovery.png),
[Electron native settlement](electron/changes-native-settled.png), and
[Electron narrow confirmation](electron/changes-dark-600-undo-confirmation.png).
The machine-generated results retain `visualReview: pending`; this separately
authored review supplies the visual assessment without rewriting original results.

Full local evidence remains in `.cache/qa/web-session-changes-qMImum/` and
`.cache/qa/electron-session-changes-oXK44S/`. An earlier attempt remains in
`.cache/qa/web-session-changes-oNIOXo/`: it failed because it overlapped an asset
rebuild, which removed the served `dist/index.html`. The fresh runs above began
after asset staging completed; the failed attempt is not counted as a pass.

## Database and remaining boundaries

The [Supabase migration dry run](https://github.com/1H-Team/DevRyan/actions/runs/34412337993)
passed: remote migrations were current through `20260908182901`, matching the
schema marker. No pending migration was found. The release workflow performs its
normal production migration/parity check again before publication.

Packaged architecture checks, release signing, image verification, and artifact
gates remain the release workflow's responsibility; these local development-host
checks do not replace them. Packaged updater installation, native pointer/quit
journeys, physical-device behavior and live-provider conformance were not rerun.
Automatic Claude recovery remains gated off pending production conformance.
The concurrent-revert mutation foundation is internal and not enabled as a
production feature; the changelog explicitly distinguishes it from shipped work.
