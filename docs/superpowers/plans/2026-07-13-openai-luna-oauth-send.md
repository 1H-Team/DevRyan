# OpenAI Luna OAuth Send Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make OpenAI `gpt-5.6-luna` and its Fast mode complete real chat turns through ChatGPT/Codex OAuth in DevRyan, without advertising a Luna reasoning mode that the active OpenCode runtime cannot execute.

**Architecture:** Treat the active OpenCode runtime and its provider catalog as the execution authority. Reproduce the failure against OpenCode 1.17.19, add the missing Codex identity headers only to OAuth Luna requests in DevRyan's managed-runtime plugin, and remove only the synthetic Luna capability that the upstream catalog does not expose. Preserve the exact upstream model row, Fast service tier, and supported reasoning variants, keep web/Electron and VS Code behavior aligned, and verify the final path through the shared UI against the external Test project.

**Tech Stack:** Bun, OpenCode 1.17.19, Express proxy routes, TypeScript/React/Zustand shared UI, Vitest/Bun tests, in-app browser visual testing.

## Global Constraints

- Work only in `/Users/zoubair/Repositories/DevRyan`; `/Users/zoubair/Repositories/Test` is authorized only as the external visual/runtime fixture.
- Do not inspect or modify any upstream OpenChamber checkout.
- Do not log or persist OAuth access tokens, refresh tokens, account IDs, provider response bodies, or prompt transcripts in repository artifacts.
- Preserve API-key and external-OpenCode catalogs exactly as supplied by their provider runtime.
- Keep web/Electron and VS Code provider behavior in parity.
- Make no dependency changes; OpenCode and `@opencode-ai/sdk` remain pinned to `1.17.19`.
- Before completion, run `bun run validate:affected`; because this touches `packages/web/server/**`, also ensure the web server suite runs, and run `bun run build` only if implementation changes package/build wiring.

## Evidence and Working Hypothesis

- DevRyan and the locally resolved CLI target OpenCode `1.17.19`.
- OpenCode `1.17.19` added Luna Responses Lite OAuth request rewriting for the exact wire model `gpt-5.6-luna`.
- The direct `opencode models openai --verbose` catalog exposes Luna and Luna Fast with `none`, `low`, `medium`, `high`, and `xhigh`; Luna Fast maps to API model `gpt-5.6-luna` plus `serviceTier: priority`.
- DevRyan's bundled `openai-gpt-5-6-models.mjs` currently adds a synthetic `max` reasoning effort to Luna and Luna Fast.
- Confirmed root cause: OpenCode 1.17.19 contains the Responses Lite body transformation but still receives `Model not found gpt-5.6-luna` until `originator: codex_cli_rs` and `User-Agent: codex_cli_rs/0.0.0 (OpenCode)` are attached. The same OAuth credential completes Sol without those headers and completes Luna with them.
- Separate catalog mismatch: DevRyan's bundled plugin adds a synthetic Luna `max` mode that the direct 1.17.19 catalog does not advertise. The live visual pass also showed that stale or richer runtime input can still carry `max`/`ultra`, so normalization must remove those keys explicitly and preserve Luna's verified `none` through `xhigh` matrix.

---

### Task 1: Reproduce and identify the failing boundary

**Files:**
- Inspect: `packages/web/server/lib/opencode/version-policy.js`
- Inspect: `packages/web/server/default-config/plugins/openai-gpt-5-6-models.mjs`
- Inspect: `packages/ui/src/sync/send-config.ts`
- Runtime fixture: `/Users/zoubair/Repositories/Test`

**Interfaces:**
- Consumes: `/global/health`, `/api/config/opencode-resolution`, `/api/config/providers`, the shared UI send path, and OpenCode session events.
- Produces: one root-cause record containing active runtime version, selected catalog row, selected reasoning variant, actual model/variant sent, terminal error text, and whether the direct OpenCode control succeeds.

- [ ] **Step 1: Start a clean source runtime against the Test project**

Run:

```bash
bun run dev:web:hmr
```

Open the reported loopback URL in the in-app browser, select `/Users/zoubair/Repositories/Test` as the project, and ensure no older DevRyan-owned OpenCode process is still serving the app.

Expected: one DevRyan runtime and one managed OpenCode runtime; the app opens the Test project without modifying its tracked files.

- [ ] **Step 2: Record the authoritative runtime and provider state without secrets**

Read `/api/config/opencode-resolution`, `/api/config/providers`, and the proxied `/global/health`. Record only:

```text
targetVersion
detectedVersion
health.version
openai.authType
gpt-5.6-luna variant keys
gpt-5.6-luna-fast variant keys
```

Expected: all runtime version fields report `1.17.19`; OAuth is connected; Luna base and Fast are present. If the live health version is older, restart after installing the target version and repeat before changing code.

- [ ] **Step 3: Reproduce in DevRyan with a supported control variant**

In the shared chat UI, choose OpenAI → GPT-5.6 Luna, disable Fast, choose `medium`, and send:

```text
Reply with exactly LUNA_OK. Do not use tools or change files.
```

Expected after the fix: the UI enters busy state, streams an assistant response, settles to idle, and displays `LUNA_OK` without retry/error state.

- [ ] **Step 4: Reproduce the suspected synthetic-mode failure**

If `max` is visible before the fix, select it and send the same prompt in a fresh session. Capture the terminal provider error and the final message/session status, but do not save the response body or credentials.

Expected before the fix: this is the failing case if the primary hypothesis is correct. If `medium` fails identically, continue to Step 5 because the problem is below DevRyan's synthetic variant layer.

- [ ] **Step 5: Run a direct OpenCode control**

Run from `/Users/zoubair/Repositories/Test`:

```bash
opencode run --model openai/gpt-5.6-luna --variant medium "Reply with exactly LUNA_OK. Do not use tools or change files."
```

Expected: OpenCode 1.17.19 completes with `LUNA_OK`.

Decision gate:

- If direct OpenCode succeeds and DevRyan `medium` succeeds but `max` fails, implement Tasks 2–4 as written.
- If direct OpenCode succeeds and DevRyan `medium` fails, inspect the DevRyan request/session event record and add a focused failing test at the first differing boundary before modifying it; do not remove unrelated provider policy.
- If direct OpenCode also fails, stop: the defect is external to DevRyan or the OAuth session, so preserve the evidence and do not mask it with UI policy.

### Task 2: Complete the managed OAuth Luna request contract

**Files:**
- Modify: `packages/web/server/default-config/plugins/openai-gpt-5-6-models.mjs`
- Test: `packages/web/server/default-config/plugins/openai-gpt-5-6-models.test.mjs`
- Modify documentation: `packages/web/server/lib/opencode/DOCUMENTATION.md`

**Interfaces:**
- Consumes: OpenCode's OAuth-filtered model map and each model's upstream `variants` object.
- Produces: `normalizeOpenAIOAuthGpt56Models(models)` that retains Luna base/Fast rows without adding `max`/`ultra`, plus a Luna-only OAuth `chat.headers` hook that supplies the Codex identity required by Responses Lite.

- [ ] **Step 1: Change the focused test to describe the authoritative Luna matrix**

Replace the Luna assertions with:

```js
expect(Object.keys(models["gpt-5.6-luna"].variants)).toEqual([
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
]);
expect(Object.keys(models["gpt-5.6-luna-fast"].variants)).toEqual([
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
]);
expect(models["gpt-5.6-luna"].variants.max).toBeUndefined();
expect(models["gpt-5.6-luna-fast"].variants.max).toBeUndefined();
```

- [ ] **Step 2: Run the focused test and verify the regression is real**

Run:

```bash
bun test packages/web/server/default-config/plugins/openai-gpt-5-6-models.test.mjs
```

Expected: FAIL because the current plugin inserts `max` into both Luna rows.

- [ ] **Step 3: Narrow DevRyan's synthetic reasoning matrix**

Change the model sets so Luna remains visible but is not in the set receiving synthetic `max`:

```js
const MAX_MODEL_IDS = new Set([
  "gpt-5.6-sol",
  "gpt-5.6-sol-fast",
  "gpt-5.6-terra",
  "gpt-5.6-terra-fast",
]);

const VISIBLE_GPT_56_MODEL_IDS = new Set([
  ...MAX_MODEL_IDS,
  "gpt-5.6-luna",
  "gpt-5.6-luna-fast",
]);
```

Keep `ULTRA_MODEL_IDS` unchanged. Do not synthesize or rename model rows and do not change API-key behavior.

- [ ] **Step 4: Add the OAuth Luna Codex identity hook**

Track whether the OpenAI provider's `models` hook received OAuth auth, then add these headers only when the resolved API model is `gpt-5.6-luna`:

```js
output.headers.originator = "codex_cli_rs";
output.headers["User-Agent"] = "codex_cli_rs/0.0.0 (OpenCode)";
```

Cover Luna base, Luna Fast, API-key Luna, and OAuth Sol so the hook cannot widen silently.

- [ ] **Step 5: Run the focused test and verify it passes**

Run:

```bash
bun test packages/web/server/default-config/plugins/openai-gpt-5-6-models.test.mjs
```

Expected: PASS; Luna retains only upstream variants, while Sol/Terra keep their existing Max/Ultra behavior.

- [ ] **Step 6: Update module documentation**

In `packages/web/server/lib/opencode/DOCUMENTATION.md`, state that the bundled GPT-5.6 plugin preserves upstream Luna/Luna Fast variants because OpenCode owns Responses Lite compatibility, while the existing Sol/Terra additions remain unchanged.

### Task 3: Lock the shared UI send contract for Luna base and Fast

**Files:**
- Test: `packages/ui/src/lib/providers/variantControls.test.ts`
- Test: `packages/ui/src/sync/send-config.test.ts`
- Inspect: `packages/ui/src/lib/providers/variantControls.ts`
- Inspect: `packages/ui/src/sync/send-config.ts`

**Interfaces:**
- Consumes: upstream provider rows `gpt-5.6-luna` and `gpt-5.6-luna-fast` and supported reasoning variants.
- Produces: an exact send selection `{ providerID: "openai", modelID, variant }` without remapping Luna to a fabricated model or variant.

- [ ] **Step 1: Update the variant-control fixture**

Represent Luna base/Fast with only upstream variants:

```ts
{ id: 'gpt-5.6-luna', variants: { none: {}, low: {}, medium: {}, high: {}, xhigh: {} } },
{ id: 'gpt-5.6-luna-fast', variants: { none: {}, low: {}, medium: {}, high: {}, xhigh: {} } },
```

Assert that Luna's visible choices end at `xhigh`, and that toggling Fast changes only the selected catalog row.

- [ ] **Step 2: Add send-config regressions for base and Fast**

Add two cases to `send-config.test.ts`:

```ts
expect(resolveSessionSendConfigSnapshot(lunaBaseSnapshot)).toMatchObject({
  providerID: 'openai',
  modelID: 'gpt-5.6-luna',
  variant: 'medium',
});

expect(resolveSessionSendConfigSnapshot(lunaFastSnapshot)).toMatchObject({
  providerID: 'openai',
  modelID: 'gpt-5.6-luna-fast',
  variant: 'xhigh',
});
```

Build each snapshot with real provider rows and no `max` key. Use the existing local test helpers and exact resolver signature already present in the file.

- [ ] **Step 3: Run the focused UI tests**

Run:

```bash
bun test packages/ui/src/lib/providers/variantControls.test.ts packages/ui/src/sync/send-config.test.ts
```

Expected: PASS. If a test reveals that Fast is converted into a `fast` pseudo-variant instead of the `gpt-5.6-luna-fast` row, fix only `variantControls.ts` and keep the model row authoritative.

### Task 4: Verify cross-runtime catalogs and the real visual flow

**Files:**
- Test: `packages/web/server/lib/opencode/provider-routes.test.js`
- Test: `packages/vscode/src/bridge-proxy-runtime.test.ts`
- Runtime fixture: `/Users/zoubair/Repositories/Test`

**Interfaces:**
- Consumes: managed web/Electron provider proxy, VS Code provider proxy, shared UI model selection, OpenCode 1.17.19 OAuth runtime.
- Produces: parity evidence plus successful visual base and Fast Luna turns.

- [ ] **Step 1: Preserve provider-catalog parity assertions**

Extend the existing web and VS Code OAuth catalog fixtures with Luna base/Fast variant maps and assert both proxies preserve those maps without credentials or DevRyan-only `max`/`ultra` additions.

Run:

```bash
bun test packages/web/server/lib/opencode/provider-routes.test.js
bun run --cwd packages/vscode test
```

Expected: PASS in both runtimes; API-key and external-OpenCode catalog tests remain unchanged.

- [ ] **Step 2: Run affected validation**

Run:

```bash
bun run validate:affected
```

Expected: affected type-check, lint, UI tests, web server tests, and VS Code tests all pass with no new warnings.

- [ ] **Step 3: Visually test Luna base in the Test project**

Reload the source app in the in-app browser, open `/Users/zoubair/Repositories/Test`, create a fresh session, select Luna base + `medium`, and send the exact `LUNA_OK` prompt from Task 1.

Verify visually:

```text
Luna is selectable.
Max and Ultra are absent for Luna.
The user message appears once.
The assistant streams and displays LUNA_OK.
The session returns to idle without retry/error UI.
No tracked Test-project file changes are created.
```

- [ ] **Step 4: Visually test Luna Fast**

Create a second fresh session, enable Fast, select `xhigh`, and send the same prompt.

Expected: the assistant completes with `LUNA_OK`; the selected UI state remains Luna + Fast + `xhigh`; no duplicate message, fallback model, retry loop, or project change appears.

- [ ] **Step 5: Verify failure recovery and cleanup**

Confirm the two sessions can be revisited without their model/variant selection changing. Delete only the test sessions created by this plan, leave `/Users/zoubair/Repositories/Test` clean, and stop the development runtime and its managed OpenCode child.

Expected: Test repository `git status --short` is empty and no DevRyan-owned listener/process remains.
