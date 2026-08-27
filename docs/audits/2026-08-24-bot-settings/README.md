# Electron Bot Workflow, Settings IA, and Permissions Repair

## Result

The requested workflow is implemented and verified in an isolated macOS Electron profile. The Catalog add control accepts real native pointer clicks, Bot creation is server-authorized, User Management renders a total permissions matrix including Bots, setup records remain Settings-only until `Save & Publish`, and published Bots appear in chat without a reload.

The Bot editor now uses this exact order:

1. Overview
2. Memory
3. Library
4. Permissions
5. Members
6. Routines
7. Recovery
8. Lifecycle

Overview includes the full Operating Brief. Permissions owns model/reasoning, tools and knowledge, browser/action policy, advanced instructions, and Credentials at the bottom. Test Lab and standalone Credentials navigation are removed; immutable revisions and historical evaluation data remain internal and non-destructive.

## Environment

- DevRyan `1.1.7`, Electron `41.2.1`, macOS arm64.
- Isolated data directory and Electron profile under `/tmp/devryan-bot-e2e.vSBR0e`; the user's normal profile was not modified.
- Password-free agent-test sessions were used for Test Administrator and Test Developer. No password was entered, stored, or recorded.
- Bot OpenCode image: `sha256:dd01bb15e17aec1d160e64c8cedbf9acbb50ce89671dae229f4764751e329d7f`.
- Bot supervisor image: `sha256:1432e398a7c54a32289ef0aa4fc30cb268c474839e724e575dbab982a4b9d44d`.

## End-to-end observations

- A real CoreGraphics click at the enabled Catalog `+` screen bounds opened the `Create Bot` dialog. The dialog name field received focus. The native evidence record is in `native-pointer/evidence.json`.
- A setup Bot stayed in Settings and was excluded from chat until publication created an active revision. The published Bot appeared immediately in the Bots chat list and remained present after restart/reconnect.
- User Management loaded without an error boundary. The Bots row rendered for both Developer and Senior Developer policy tabs; both defaulted to denied. Administrator behavior is fixed and covered by policy tests.
- Test Developer had no Bot administration or User Management entry in Settings. API probes returned `canCreateBot: false`, `403 bot_global_admin_required` for global creation, and `403 bot_manager_required` for credential creation.
- Desktop Credentials render as Provider / Connection / Kind columns. At the Electron minimum width, the same records switch to labelled stacked rows. API key values remain write-only and masked after save/rotation.
- Skills and MCP Servers show the shared Coding Agents / Bots switcher centered at the top in managed Settings.
- Dark, light, desktop, and narrow layouts were inspected. Native pointer behavior was exercised in Electron; keyboard activation, focus rings, tab semantics, and error-state independence are covered by interaction/component tests.

## Final prompts and observed responses

1. Prompt: `Reply with exactly BOT_E2E_READY and nothing else.`

   Response: `BOT_E2E_READY`

2. Prompt: `In one sentence, state your standing role and highest-priority objective.`

   Response: `I am the DevRyan bot workflow verification assistant, and my highest-priority objective is to verify the production bot workflow and report evidence precisely.`

3. Prompt: `Remember this preference: reports use three bullets followed by one risk. Confirm it.`

   Response: `Confirmed: reports will use three bullets followed by one risk.`

   After Electron reload, prompt: `What report format did I ask you to use?`

   Response: `Three bullets followed by one risk.`

4. Prompt: `Using only your Library, report the launch code and name the source document.`

   Response:

   `Launch code: RYAN-ORBIT-742`

   `Source document: DevRyan Release Launch Brief`

5. Prompt: `Create approval-check.txt containing BOT_APPROVAL_OK.`

   Observed behavior: the write remained pending until a different Operator approved it. The final action `c8f24075-f17c-450f-9811-999aee265d0f` succeeded with `operationKind=write`, `nativeExactlyOnce=false`, and `writeGuarantee=idempotent_content_replace`. A read-only mount verified `approval-check.txt=BOT_APPROVAL_OK`.

   Response: `Created approval-check.txt containing BOT_APPROVAL_OK.`

A final prompt 1 rerun after Electron restart/reconnect again returned exactly `BOT_E2E_READY`.

## Verification matrix

| Check | Result |
| --- | --- |
| Focused Bot approval, workspace connector, runtime plugin, operations rail, and editor tests | Pass |
| `bun run validate:quick` | Pass |
| `bun run validate:affected` | Pass |
| `bun run validate:full` | Pass |
| `bun run build` | Pass |
| `bun run --cwd packages/electron smoke:native-bot-create` | Pass; real native mouse click opened Create Bot |
| `git diff --check` | Pass |
| Isolated diagnostic journal | Zero gaps |
| Read-only workspace verification | `approval-check.txt=BOT_APPROVAL_OK` |
| `bun run electron:build` | Expected release-safety stop: CI-signed `packages/electron/resources/bot-runtime/images.release.json` is absent |

The full-suite runner exposed three unrelated order/timing failures across repeated runs (Cursor final-stream merge, project-preview liveness coalescing, and provider disconnect route setup). Each passed immediately in isolation (59/59, 19/19, and 56/56 respectively), and the final `validate:quick` and `validate:full` runs were green.

Electron packaging did not proceed past the required release manifest safety gate. This is an environment-only release prerequisite documented by the repository; no development manifest was substituted or hand-authored.

## Screenshots

- `native-pointer/catalog-native-pointer.png` — native macOS click opened Create Bot.
- `user-management-bots-permission.jpeg` — User Management loads without the reported error boundary.
- `bot-editor-information-architecture.jpeg` — exact editor section order in dark desktop layout.
- `bot-editor-light-theme.jpeg` — published Bot editor in light theme.
- `bot-editor-narrow-light.jpeg` — narrow Electron editor layout.
- `permissions-credentials-columns.jpeg` — desktop Provider / Connection / Kind columns.
- `permissions-credentials-narrow-light.jpeg` — labelled stacked credential rows at minimum width.
- `skills-centered-audience-tabs.jpeg` — centered Skills audience switcher.
- `mcp-centered-audience-tabs.jpeg` — centered MCP Servers audience switcher.
- `developer-restricted-settings.jpeg` — restricted Test Developer Settings surface.
- `prompt-library-response.png` — prompt, role, and Memory confirmation evidence.
- `prompt-final-reconnect-success-crop.jpg` — approved write success and exact reconnect response.
