# tests/visual-production-bots

## Responsibility

Committed, test-only visual fixture for Production Bots. It renders the real
settings, policy, transcript, operations rail, dialogs, and narrow stores across
the reviewed state matrix without entering any production bundle.

## Entry points

- `src/main.tsx`: deterministic scenes and role/state fixtures using production
  UI components, including the real Bot transcript and decoded Computer canvas.
  Its test-only fetch interceptor emits a valid bounded 1280×720 multipart JPEG
  stream without a binary fixture or production dependency.
  Network scenes viewport the real `BotPolicyEditor` network/isolation fieldset
  and mark it as the keyboard-focus scope so screenshots cannot pass on a label
  while the relevant controls remain below the fold.
- `matrix.mjs`: light/dark, viewport, rail, drawer, state, and interaction matrix.
- `electron-shell.cjs`: isolated CDP shell that loads only the loopback Vite fixture URL.
- `electron-builder.cjs`: packages that shell separately under ignored `.cache/e2e/` for release-candidate testing.
- `vite.config.ts`: test-only aliases into shared UI source and the ignored build output.

## Verification

`scripts/capture-production-bots-visuals.mjs` owns layout, focus, keyboard,
feature-scope visibility, accessible-name, secret-sentinel, console, transcript
ordering/no-internal-heading, complete-frame, control-state, and screenshot
assertions. Overview scenes cover the compact Provider/Model/Thinking row and
its narrow missing-credential direction. The owned-control scene also clicks the real canvas and requires the
fixture API to observe its ordered pointer down/up events. The matrix includes
permanent retry refusal (real HTTP client/store and notice), distinct timeout copy,
hidden historical acknowledgment/verified-result presentation plus
connecting/live/disconnected, owned/view-only/conflicting/waiting control, and
generated-image loading/decoded/error-retry scenes in desktop and narrow
light/dark role variants. The
packaged-shell builder is `scripts/package-production-bots-visual-shell.mjs`.
The deterministic matrix test is part of `bun run test:full`; screenshot review
and the native-pointer pairing remain explicit acceptance-host work documented
in `docs/TESTING.md`.

- `src/BotUpgradeScene.tsx` adds `?scene=upgrade&count=100|1000|5000` interactive long-history, final-answer, draft/paint benchmark, and automatic inline-computer verification. Screen counters report opened, active, stopped, and peak simultaneous ephemeral fixture streams.
- `src/BotTelegramScene.tsx` adds `?scene=telegram` for independently saved setup,
  numeric pairing confirmation, uncertain delivery and scoped speech settings.
  All requests are intercepted by an in-memory fixture API; never enter real credentials.
