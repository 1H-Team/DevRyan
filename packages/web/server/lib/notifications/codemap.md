# packages/web/server/lib/notifications/

## Responsibility
Notification subsystem for browser push and in-app streaming: subscription lifecycle, visibility/session-attention tracking, message templating, and emission triggers.

## Design
- **Route + runtime separation**: `routes.js` handles HTTP/SSE contracts; runtime/template/push modules encapsulate generation and delivery logic.
- **Session-aware delivery**: visibility and activity state prevents noisy notifications when UI is foregrounded, and authoritative todo progress suppresses ready notifications while tasks remain pending or in progress.
- **Template pipeline**: optional summarization/model-based message shaping before push dispatch.
- **Plan intent**: `plan-ready.js` rejects exact managed maintenance and valid Implement turns before sentinel classification. `runtime.js` retains those markers in its bounded cache and verifies a candidate's exact canonical parent before fanout; missing parent metadata follows bounded retries.

## Flow
1. Client subscribes/unsubscribes push endpoint (`/api/push/*`) and opens notification SSE stream.
2. Server stores endpoint keyed to UI session token and tracks visibility/status snapshots.
3. Session/message events invoke notification trigger runtime.
4. Push runtime sends VAPID payloads and SSE stream notifies connected UI clients.

## Integration
- Registered by `server/index.js`; consumed by `src/api/notifications.ts` and `src/api/push.ts`.
- Depends on `ui-auth` session tokens and OpenCode event/session state.
- Integrates with `web-push` and text summarization/LLM helpers for payload quality.
