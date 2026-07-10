# GPT-5.6 Sol, Terra, and Luna Native Reasoning Implementation Plan

> **Requirement correction:** Max and Ultra are separate native levels. Sol and Terra support both; Luna supports Max only.

**Goal:** Expose the exact native Max/Ultra capability matrix across direct OpenAI and Cursor-backed models, preserve Fast as an independent dimension, and transport the literal selected wire value.

**Architecture:** Correct incomplete capabilities at provider boundaries, keep shared UI capability-driven, and preserve raw variant strings through state and send flows.

## Constraints

- Sol/Terra base and Fast: Extra High, Max, Ultra.
- Luna base and Fast: Extra High, Max; no Ultra.
- Pro models receive no inferred correction.
- Max sends `max`; Ultra sends `ultra`.
- Anthropic Max remains unchanged.
- No new dependencies or external schema changes.
- Preserve unrelated workspace changes.

## Task 1: Cursor Discovery and Execution

**Files:**

- `packages/cursor-sdk-runtime/index.js`
- `packages/cursor-sdk-runtime/model-discovery.test.js`

- [x] Preserve SDK-advertised `max` as a distinct Max variant.
- [x] Add literal Ultra only for exact Sol/Terra SDK IDs when discovery omits it.
- [x] Preserve context and Fast parameters while changing only the Ultra reasoning value to `ultra`.
- [x] Prove Sol/Terra base and Fast contain both levels.
- [x] Prove Luna, Pro controls, and Anthropic keep Max without inferred Ultra.

## Task 2: Direct OpenAI Runtime Metadata

**Files:**

- `packages/web/server/lib/opencode/runtime-agent-overlays.js`
- `packages/web/server/lib/opencode/runtime-agent-overlays.test.js`
- `packages/web/server/lib/opencode/DOCUMENTATION.md`

- [x] Advertise Max for exact Sol/Terra/Luna base and Fast IDs.
- [x] Advertise Ultra for exact Sol/Terra base and Fast IDs.
- [x] Use matching literal `reasoningEffort` values.
- [x] Deep-merge provider/model/variant records.
- [x] Leave Pro and unrelated providers untouched.

## Task 3: VS Code Parity

**Files:**

- `packages/vscode/src/opencodeConfig.ts`
- `packages/vscode/src/opencodeConfig.test.js`

- [x] Generate the same direct OpenAI capability matrix as Web/Electron.
- [x] Verify exact wire metadata and negative Pro coverage.

## Task 4: Shared UI and Send Fidelity

**Files:**

- `packages/ui/src/lib/providers/variantControls.ts`
- `packages/ui/src/lib/providers/variantControls.test.ts`
- `packages/ui/src/components/chat/mobileControlsUtils.ts`
- Shared selector and send-flow tests.

- [x] Order `max` after Extra High and before Ultra.
- [x] Keep Extra High, Max, and Ultra as separate labels and raw values.
- [x] Preserve Ultra and Max through Fast toggles.
- [x] Preserve raw variants through defaults, restoration, queued sends, cycling, and submission.
- [x] Keep unsupported levels absent after model switching.
- [x] Retain a rehydrated draft variant while its agent restores.

## Task 5: Electron Packaging

**Files:**

- `packages/electron/scripts/rebuild-native.mjs`
- `packages/electron/scripts/rebuild-native.test.mjs`

- [x] Rebuild Cursor SDK's transitive `sqlite3` package from Bun's isolated dependency tree.
- [x] Verify the packaged app contains a loadable architecture-correct `node_sqlite3.node`.

## Task 6: Verification, Install, and Visual QA

- [ ] Run focused Cursor, UI, Web, and VS Code tests.
- [ ] Run `bun run validate:full`.
- [ ] Build with `bun run electron:build`.
- [ ] Install and restart `/Applications/DevRyan.app` while preserving user data.
- [ ] Verify live metadata:
  - Sol/Terra base and Fast: Extra High, Max, Ultra.
  - Luna base and Fast: Extra High, Max only.
  - Pro: no inferred Ultra/Max correction.
  - Cursor worker ready from SDK discovery.
- [ ] At desktop and compact widths:
  - Verify separate Extra High, Max, and Ultra options.
  - Select Max and Ultra and confirm trigger/checkmark.
  - Toggle Fast and verify the reasoning level remains selected.
  - Reload and verify restoration.
  - Switch to Luna and Pro and confirm unsupported levels disappear.
  - Check mobile overflow and supporting selectors for clipping.
  - Capture screenshots and confirm no browser console errors.
- [ ] Run `git diff --check` and confirm only intended files changed.
