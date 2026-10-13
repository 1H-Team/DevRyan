# Session creation banner verification

The recovery banner previously rendered as soon as an attempt became `created`,
including the normal handoff before the composer selected the created session.
`SessionCreationStatus` now hides recovery while the attempt's draft or created
session owns a pending-send controller. Recovery markers, draft retention,
navigation and duplicate-session confirmation keep their existing behavior.

## Checks

- Six component tests passed, with 29 assertions. Mounted tests use the real
  creation and session UI stores, exercise controller promotion and composer
  navigation, restore interrupted/late-created recovery, and reject interference
  from another draft/session's pending send.
- The visual fixture TypeScript check and production fixture build passed.
- The compiled isolated browser fixture stayed silent through creation,
  acknowledgement, controller promotion and completion. An uncertain outcome
  revealed recovery; a late-created result exposed Open Session and confirmed
  duplicate-session retry controls.
- Inspected [active-send screenshot](active-send.png): the attempt is `created`,
  the draft remains selected, and no recovery banner sits above the composer.
- Inspected [recovery screenshot](recovery.png): retained-draft recovery and the
  duplicate-session confirmation remain visible.
- `bun run validate:affected` expanded to full validation because of pre-existing
  release/workflow changes. Workspace lint, type checks and documentation
  validation passed; deterministic suites were still running when this record
  was first written.

## Limits

Development-server checks were discarded after hot reload reset transient fixture
controllers while retaining the persisted creation marker. The final browser
checks used a compiled fixture without hot reload. This is component/fixture
verification, not a live provider or packaged Electron first-message journey.
No journal correlated to the original reported flash was available in this
repository. The user's running application and data were not accessed.
