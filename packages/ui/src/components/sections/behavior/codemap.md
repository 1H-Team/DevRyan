# packages/ui/src/components/sections/behavior/

## Responsibility

Settings → Agents behavior controls shared by the web, Electron, and VS Code renderers.

## Files

- `BehaviorPage.tsx`: renders Global Agent Behavior and Response Style, with independent loading and persistence state for each feature.
- `globalAgentsMdApi.ts`: validates the `/api/behavior/agents-md` read/save contract and exposes warning detection for persisted saves whose runtime refresh failed.

## Data flow

- Global Agent Behavior reads and writes only `~/.config/opencode/AGENTS.md` through `/api/behavior/agents-md`. The editor keeps the server-returned canonical content as its dirty-state baseline.
- Response Style continues to read and write `/api/config/settings`; the legacy `globalBehaviorPrompt` field is deliberately ignored here.
- External OpenCode runtimes return a non-editable AGENTS.md document with an `unavailableReason`, which the page displays without disabling Response Style.

## Verification

- API contract tests: `globalAgentsMdApi.test.ts`
- User-visible behavior should also be checked at desktop and mobile viewport sizes in light and dark themes.
