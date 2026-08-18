# packages/ui/src/lib/

## Responsibility
Shared non-React application logic for the UI package: API clients, routing/serialization, theme/typography, persistence helpers, runtime detection, domain utilities (git, messages, permissions, quota, terminal, search, worktrees).

## Design
- **Domain-partitioned utility modules**: subfolders (`opencode`, `router`, `theme`, `git`, `messages`, `permissions`, `quota`, `startup`, `terminal`, `tools`, `worktrees`) isolate contracts per concern.
- **Client abstraction**: `opencode/client.ts` wraps SDK usage, directory scoping, retries/circuit checks, and path normalization so features avoid direct transport logic.
- **Pure helper bias**: many modules expose deterministic transforms/serializers to keep component/store code thin.
- **Managed workspace hydration**: `directoryPersistence.ts` validates persisted directories against the accepted principal, `managedProjectsApi.ts` persists administrator-owned metadata, and `worktrees/managedBranches.ts` filters discovered real worktrees and draft local-branch choices against assignment-backed visibility without replacing server UUIDs.
- **Shared byte presentation**: `formatBytes.ts` is the single 1024-based formatter used by diagnostic-journal and Electron-cache status UI.
- **Authoritative session-change projection**: `sessionChangeAttribution.ts` derives repository-relative paths only from completed successful file-tool parts, records successful shell mutations as explicitly unattributed, and ignores shared-working-tree message summaries and patch snapshots.
- **Runtime capability gates**: desktop/vscode/web differences are centralized (e.g., `desktop.ts`, runtime API detection helpers).
- **Attachment capability gates**: `attachments/attachmentCapabilities.ts` treats PDFs as locally extractable when authoritative runtime status is managed while preserving provider-native checks for external OpenCode servers.
- **Annotation screenshot capture**: `preview/screenshot-capture.ts` owns preview/browser annotation screenshots with a fixed strategy order (native `desktop_capture_page_rect` → snapDOM DOM capture → html-to-image), lazily importing the capture libraries so they stay out of the startup bundle; it deliberately excludes proxy-target caching and external-resource proxying (loopback-only cookie proxy model).
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
