# Thinking slider verification — 2026-09-07

The chat composer and shared recovery picker use one native-level slider. The
final design has a 20px circular thumb on a 20px track, damped dragging with a
60% detent threshold, a centered popup, a lightbulb label, and a larger functional
Fast button. Drag previews stay local until release. New chat submissions use
explicit Medium, or the lower middle supported level; historical messages and
already captured queued configurations retain their values.

## Validation

- `bun run validate:full`: passed, including workspace type-check/lint, 3,512
  batched UI tests and 3,718 web tests (plus the isolated and other workspace suites).
- `bun run build`: passed.
- `bun run --cwd packages/electron build:web-assets`: passed.
- Isolated `thinking` QA: passed in web Chromium and the actual Electron shell.
- Isolated web `mobile` QA: passed all 16 checks.
- `git diff --check`: passed.

The thinking scenario exercises 0/1/2/3/4/5 native stops, disabled single-level
controls, pointer resistance and spring settling, commit on release, keyboard
navigation/focus return, Fast on/off, reduced motion, explicit native submission,
and reload. Web also exercises 390px layout and touch cancellation in both themes.
Mounted and resolver tests cover Cursor variants, recovery normalization, hydration,
model switching, and preservation of captured queue values.

Fast was verified through the normal HTTP submission as `fixture-model-fast`
with `variant: medium`; an ordinary submission also carried `variant: medium`.
The automated driver waits for popup keyboard focus and transcript restoration
before keyboard assertions to avoid racing Base UI focus and session hydration.

## Visual evidence

- [Web desktop, light](web-light.png)
- [Mobile, light](mobile-light.png)
- [Electron desktop, dark](electron-dark.png)
- [Fast enabled](fast-enabled.png)
- [Web scenario results](web-result.json)
- [Electron scenario results](electron-result.json)
- [Mobile smoke results](mobile-result.json)

Screenshots were inspected for thumb/track dimensions, centered placement, icon
clarity, theme contrast, and narrow-screen overflow. Browser pointer samples
confirmed progressive motion toward the next stop; reduced-motion checks assert
the thumb reaches the selected endpoint without spring settling.

These checks use deterministic OpenCode fixture responses through the real app
and transport. Live paid provider execution and physical touch hardware were not
tested. Recovery uses the same component and has automated coverage; no separate
recovery-card screenshot is included.
