# packages/web/src/api/

## Responsibility
Implements web-platform `RuntimeAPIs` adapters that bridge shared UI calls to server HTTP/SSE/WebSocket endpoints.

## Design
- **Per-domain adapter modules** (`terminal`, `git`, `files`, `settings`, `permissions`, `notifications`, `github`, `push`, `tools`).
- **Composition root**: `index.ts` returns a single `RuntimeAPIs` object with fixed `runtime.platform = "web"` metadata.
- **Contract parity**: adapter shapes mirror interfaces defined in `@openchamber/ui/lib/api/types`.
- **Tool discovery contract**: dynamic tool IDs are validated, deduplicated, sorted, and attributed to the active directory through the shared tool-manifest helper; unknown plugin tools remain available through generic presentation fallback.
- **Adapter regression contract**: `index.test.ts` asserts required shared capabilities and records web-only optional capabilities explicitly.

## Flow
1. `createWebAPIs()` instantiates each feature adapter.
2. UI hooks/components call RuntimeAPI methods.
3. Adapters execute fetch/WebSocket operations against `/api/*` routes.
4. Responses are normalized into shared-ui friendly payloads/errors.

## Integration
- Upstream consumer: `packages/web/src/main.tsx`.
- Downstream dependencies: server routes in `packages/web/server/index.js` + `server/lib/**`.
- Type contract owner: `@openchamber/ui` runtime API definitions.
