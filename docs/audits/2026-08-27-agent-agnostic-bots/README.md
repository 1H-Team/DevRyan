# Agent-agnostic Production Bots visual audit

Reviewed on 2026-08-27 against the committed Production Bots Vite fixture and
its dedicated packaged Electron shell, using an isolated renderer profile and
loopback-only fixture server. The fixture and shell are test-only and do not
enter the production bundle.

## Result

- 38 of 38 deterministic packaged-Electron cases passed.
- Light and dark themes, 1280×800 and 390×844 viewports, 220/280/500 px rails,
  and the mobile operations drawer were exercised.
- The matrix covers reasoning adapters, signed Bot specification import,
  structured policy and quotas, browser egress and isolation, runtime-service
  lifecycle, transcript deep-links, partial failures, paused/retired states,
  and Administrator/restricted Developer presentation.
- Every case passed bounds/overflow, header scroll-origin, focused-row
  visibility, keyboard focus, accessible-dialog-name, secret-sentinel, console,
  and unhandled-rejection assertions.
- Every browser-network case additionally proved that the real
  `BotPolicyEditor` network/isolation fieldset was inside the captured viewport;
  labels alone are not accepted as visual coverage.
- The pending transcript case exercised both **View activity** and **Review**
  and verified the exact durable Activity and Approval row became active and
  visible.
- A current-source Electron/AppKit smoke used a real CoreGraphics pointer click
  against an isolated data root and the password-free Administrator fixture;
  it opened the real Create Bot dialog. Its reviewed screenshot and sanitized
  assertion are in [native-pointer-source/evidence.json](native-pointer-source/evidence.json).
- Cross-machine pixel equality is deliberately not a blocking gate. The
  reviewed screenshots and machine-readable assertions are the evidence.

The primary evidence is in
[visual-packaged/evidence.json](visual-packaged/evidence.json). All 38
referenced PNG files were reviewed before `reviewStatus` was changed to
`reviewed`; generated logs, contact sheets, and failed/stale captures were not
copied. The earlier raw-Electron pass remains in
[visual/evidence.json](visual/evidence.json) as supplemental evidence.

## Reproduction

```bash
bun run visual:bots:build
bun run visual:bots:package-shell
node scripts/capture-production-bots-visuals.mjs \
  --electron-mode packaged \
  --output .cache/e2e/production-bots-visual/reviewed-packaged
```

The committed fixture renders real Bot settings, policy, transcript,
operations-rail components, dialogs, and narrow stores, but is excluded from
the production bundle. It never embeds a real endpoint token, action arguments,
credentials, or hidden target data.

The current-source AppKit pointer check passed. A fresh production-packaged app
pointer pass remains a release-host gate because `electron:build` correctly
refuses to package without the signed multi-architecture Bot runtime manifest
at `packages/electron/resources/bot-runtime/images.release.json`. That manifest
must come from the release image publication workflow; this audit does not
fabricate or weaken it. Real role/ACL verification uses the same password-free
`agent_test` flow on an interactive, Accessibility-enabled macOS host, with no
password stored or transmitted.
