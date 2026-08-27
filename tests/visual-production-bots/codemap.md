# tests/visual-production-bots

## Responsibility

Committed, test-only visual fixture for Production Bots. It renders the real
settings, policy, transcript, operations rail, dialogs, and narrow stores across
the reviewed state matrix without entering any production bundle.

## Entry points

- `src/main.tsx`: deterministic scenes and role/state fixtures using production UI components.
  Network scenes viewport the real `BotPolicyEditor` network/isolation fieldset
  and mark it as the keyboard-focus scope so screenshots cannot pass on a label
  while the relevant controls remain below the fold.
- `matrix.mjs`: light/dark, viewport, rail, drawer, state, and interaction matrix.
- `electron-shell.cjs`: isolated CDP shell that loads only the loopback Vite fixture URL.
- `electron-builder.cjs`: packages that shell separately under ignored `.cache/e2e/` for release-candidate testing.
- `vite.config.ts`: test-only aliases into shared UI source and the ignored build output.

## Verification

`scripts/capture-production-bots-visuals.mjs` owns layout, focus, keyboard,
feature-scope visibility, accessible-name, secret-sentinel, console, and
screenshot assertions. The
packaged-shell builder is `scripts/package-production-bots-visual-shell.mjs`.
The deterministic matrix test is part of `bun run test:full`; screenshot review
and the native-pointer pairing remain explicit acceptance-host work documented
in `docs/TESTING.md`.
