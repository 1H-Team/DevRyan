# packages/ui/src/lib/

## Responsibility
Shared non-React application logic for the UI package: API clients, routing/serialization, theme/typography, persistence helpers, runtime detection, domain utilities (git, messages, permissions, quota, terminal, search, worktrees).

## Design
- **Domain-partitioned utility modules**: subfolders (`opencode`, `router`, `theme`, `git`, `messages`, `permissions`, `quota`, `startup`, `terminal`, `tools`, `worktrees`) isolate contracts per concern.
- **Client abstraction**: `opencode/client.ts` wraps SDK usage, directory scoping, retries/circuit checks, and path normalization so features avoid direct transport logic.
- **Pure helper bias**: many modules expose deterministic transforms/serializers to keep component/store code thin.
- **Runtime capability gates**: desktop/vscode/web differences are centralized (e.g., `desktop.ts`, runtime API detection helpers).
- **Startup readiness and recovery**: `startup/readiness.ts` defines the low-frequency phase contract shared by web, Electron, and VS Code chat boot gates and coordinates a managed OpenCode restart before client reinitialization when health reports the runtime down; `startup/*-warmup.ts` contains non-fatal chunk/runtime warmups used before dismissing startup.
- **Tool manifest helpers**: `tools/manifest.ts` normalizes runtime tool IDs and permission alias groups for web/VS Code runtime API parity.

## Flow
1. Components/hooks/stores call `lib/*` functions for normalization, transport, and policy checks.
2. API modules interact with backend routes or SDK clients.
3. Returned normalized data feeds store reducers/selectors and feature renderers.
4. Persistence and auto-save helpers synchronize selected UI preferences with local storage and desktop settings APIs.

## Integration
- Heavy consumers: `components/chat/*`, `components/views/SettingsView.tsx`, and `stores/*`.
- Bridges to backend through `/api/*` and `@opencode-ai/sdk/v2`.
- Provides foundational contracts for `hooks/*` and `sync/*` (routing, message/session helpers, runtime/platform checks).
