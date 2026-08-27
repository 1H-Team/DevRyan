# Bot titlebar-control alignment verification

- Date: 2026-08-26 (Africa/Casablanca)
- Host: macOS 26, Apple Silicon
- Runtime: source Electron 41.2.1 with isolated DevRyan and Chromium data
- Identity: password-free `developer@1health.ae` agent-test session

## Result

PASS. The Bot navigation and Bot Operations buttons both occupy the normal
48px desktop titlebar row. Their 32px targets have the same 24px vertical
centerline (0px delta), visually align with the macOS traffic-light row, and do
not move when either sidebar changes state. The separate content-driven Bot
identity header remains 88px tall without overlapping its avatar, text, borders,
or the Operations header.

The verification used a temporary `OPENCHAMBER_DATA_DIR` and Electron
`userData` directory. It did not reuse or modify the installed DevRyan profile.

## Evidence

All captures are sanitized 1229×768 screenshots of the assigned agent-test Bot.

- [`dark-sidebars-open.png`](dark-sidebars-open.png): dark theme, both sidebars open.
- [`dark-sidebars-closed.png`](dark-sidebars-closed.png): dark theme, both sidebars closed.
- [`light-sidebars-open.png`](light-sidebars-open.png): light theme, both sidebars open.
- [`light-sidebars-closed.png`](light-sidebars-closed.png): light theme, both sidebars closed.

## Automated verification

```text
bun test packages/ui/src/components/layout/DesktopEdgeChrome.desktop.test.ts \
  packages/ui/src/components/layout/BotSidebarControlButton.test.tsx \
  packages/ui/src/components/bots/chat/BotChatView.test.tsx
# 30 pass, 0 fail

bun run validate:quick
# UI suite: 3160 pass, 0 fail

bun run type-check
bun run lint
# all workspaces passed
```
