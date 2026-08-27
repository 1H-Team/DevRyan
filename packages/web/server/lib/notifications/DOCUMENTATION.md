# Notifications Module Documentation

## Purpose
This module owns server-side notification classification, template preparation, and fanout for native shells, connected UI runtimes, and web push. Message preparation includes text truncation, plain-text normalization, and optional summarization.

## Entrypoints and structure
- `packages/web/server/lib/notifications/index.js`: public entrypoint imported by `packages/web/server/index.js`.
- `packages/web/server/lib/notifications/routes.js`: route registration for push, visibility, and session status/attention endpoints.
- `packages/web/server/lib/notifications/push-runtime.js`: push subscription persistence, VAPID initialization, and UI visibility runtime.
- `packages/web/server/lib/notifications/emitter-runtime.js`: desktop/stdout + UI SSE notification emission runtime.
- `packages/web/server/lib/notifications/runtime.js`: trigger runtime for OpenCode event-driven notification fanout.
- `packages/web/server/lib/notifications/plan-ready.js`: classifier for actionable plan revisions from event-backed or fetched message snapshots.
- `packages/web/server/lib/notifications/template-runtime.js`: notification template variables, zen-model helpers, and session text/title enrichment runtime.
- `packages/web/server/lib/notifications/message.js`: helper implementation module.
- `packages/web/server/lib/notifications/message.test.js`: unit tests for notification message helpers.

## Public exports

### Notifications API (re-exported from message.js)
- `truncateNotificationText(text, maxLength)`: Truncates text to specified max length, appending `...` if truncated.
- `prepareNotificationLastMessage({ message, settings, summarize })`: Prepares the last message for notification display, with optional summarization support.

### Route registration API (routes.js)
- `registerNotificationRoutes(app, dependencies)`: Registers notification-owned endpoints:
  - `GET /api/push/vapid-public-key`
  - `POST /api/push/subscribe`
  - `DELETE /api/push/subscribe`
  - `POST /api/push/visibility`
  - `GET /api/push/visibility`
  - `GET /api/session-activity`
  - `GET /api/sessions/snapshot`
  - `GET /api/sessions/status`
  - `GET /api/sessions/:id/status`
  - `GET /api/sessions/attention`
  - `GET /api/sessions/:id/attention`
  - `POST /api/sessions/:id/view`
  - `POST /api/sessions/:id/unview`
  - `POST /api/sessions/:id/message-sent`

### Trigger runtime API (runtime.js)
- `createNotificationTriggerRuntime(dependencies)`: creates runtime-owned serialized trigger handling for OpenCode events.
- Returned API:
  - `maybeSendPushForTrigger(payload)`
- Owns:
  - completion/error/question/permission trigger routing
  - per-session completion settlement for user-visible sessions, preserving an eligible terminal candidate across transient failures until delivery or intentional suppression
  - exact suppression of hidden helper sessions such as `smartfetch-secondary` and `Commit generation workflow` before any user-facing notification fanout
  - a 500 ms stable-idle window after the authoritative terminal assistant/idle boundary so Session Completion follows the UI's green-indicator settlement
  - assistant-message deduplication for generic completions and source-message deduplication for Plan Ready revisions
  - event-backed Plan Ready caching from plan-mode instructions and `<!--plan-->` content received through `message.part.updated`
  - bounded message-tail fetching only when an event-backed snapshot cannot complete compatibility classification
  - Plan Ready classification at the same settled revision boundary used by the Plan card and sidebar indicator
  - replacement of generic completion with `plan-ready` delivery for plan-producing turns; disabling Plan Ready does not fall back to generic completion
  - one Plan Ready notification per session/source-message revision, with cleanup on session deletion
  - question/permission and incomplete-todo gates so a blocked plan is not announced as actionable
  - completion suppression while the session's latest todo snapshot contains `pending` or `in_progress` work
  - session parent cache for subtask suppression
  - template resolution and fallback behavior
  - lazy Zen-model resolution only when last-message summarization is enabled and the message exceeds its configured threshold
  - generated session-title projections shared with the UI, with meaningful titles preserved across later placeholder snapshots
  - native notification fanout and web push payload fanout

### Completion settlement behavior

Completion-related events are processed in arrival order through a per-session queue. A terminal assistant update becomes that session's pending completion candidate; repeated updates for the same assistant message merge without losing an earlier generic-completion signal. The candidate settles only after a later authoritative `idle` status, after todo, question, and permission blockers clear, and after idle remains stable for 500 ms. A busy/retry transition or new blocker cancels that timer; a later authoritative idle edge re-arms it. Deduplication remains per assistant message, so a later user work cycle in the same visible session can produce one new completion.

Before dispatch, the runtime resolves the authoritative cached or fetched session record. Hidden helper sessions never emit completion, Plan Ready, error, question, or permission notifications. A missing completion record retries after 250/1000/3000 ms; if metadata remains unavailable after those retries, the candidate is intentionally suppressed instead of being guessed visible. Root Session Completion and child Subagent Completion use independent settings.

Transient settings or settlement failures retain the candidate and retry with capped backoff. Session deletion clears pending candidates, retry timers, plan snapshots, and deduplication state. A successfully dispatched or intentionally suppressed candidate is recorded by assistant message ID so duplicate terminal or `idle` events cannot emit it again.

Plan classification first uses the bounded event cache populated by `message.part.updated`. An explicit `<!--plan-->` sentinel is sufficient to classify the terminal assistant snapshot even when its parent user message is not yet visible through message history. Plan-mode instructions also allow structured plan content to be classified from the event snapshot. Compatibility history reads request only the latest 50 messages and use a short retry window for endpoint lag.

History and enrichment failures do not consume an eligible alert: ordinary completions use their default title/body, and sentinel-backed plans use the default Plan Ready title/body when template preparation fails. Once a plan revision is confirmed, it owns the terminal event; disabling Plan Ready intentionally suppresses that event rather than falling through to Session Completion.

The user-facing completion name is **Session Completion**. Plan-producing turns remain Plan Ready (yellow lifecycle state); the later implementation turn produces Session Completion only after the green completed state settles.

### Push runtime API (push-runtime.js)
- `createPushRuntime(dependencies)`: creates runtime for web push and UI visibility state.
- Returned API:
  - `getOrCreateVapidKeys()`
  - `ensurePushInitialized()`
  - `setPushInitialized(value)`
  - `addOrUpdatePushSubscription(uiSessionToken, subscription, userAgent)`
  - `removePushSubscription(uiSessionToken, endpoint)`
  - `sendPushToAllUiSessions(payload, options?)`
  - `updateUiVisibility(token, visible)`
  - `isAnyUiVisible()`
  - `isUiVisible(token)`

### Emitter runtime API (emitter-runtime.js)
- `createNotificationEmitterRuntime(dependencies)`: creates runtime for unified notification emission channels.
- Returned API:
  - `writeSseEvent(res, payload)`
  - `emitDesktopNotification(payload)`
  - `broadcastUiNotification(payload)`

### Template runtime API (template-runtime.js)
- `createNotificationTemplateRuntime(dependencies)`: creates shared notification/template runtime and consumes shared text summarization from `packages/web/server/lib/text/summarization.js` in `notification` mode.
- Returned API:
  - `resolveNotificationTemplate(template, variables)`
  - `shouldApplyResolvedTemplateMessage(template, resolved, variables)`
  - `fetchFreeZenModels()`
  - `resolveZenModel(override)`
  - `validateZenModelAtStartup()`
  - `summarizeText(text, targetLength, zenModel)`
  - `extractLastMessageText(payload, maxLength?)`
  - `fetchSessionMessages(sessionId, limit?)`
  - `fetchLastAssistantMessageText(sessionId, messageId, maxLength?)`
  - `maybeCacheSessionInfoFromEvent(payload)`
  - `buildTemplateVariables(payload, sessionId)`
  - `getCachedZenModels()`

## Constants

### Default values
- `DEFAULT_NOTIFICATION_MESSAGE_MAX_LENGTH`: 250 (default max length for notification text).
- `DEFAULT_NOTIFICATION_SUMMARY_THRESHOLD`: 200 (minimum message length to trigger summarization).
- `DEFAULT_NOTIFICATION_SUMMARY_LENGTH`: 100 (target length for summarized messages).

## Settings object format

The `settings` parameter for `prepareNotificationLastMessage` supports:
- `summarizeLastMessage` (boolean): Whether to enable summarization for long messages.
- `summaryThreshold` (number): Minimum message length to trigger summarization (default: 200).
- `summaryLength` (number): Target length for summarized messages (default: 100).
- `maxLastMessageLength` (number): Maximum length for the final notification text (default: 250).

Notification delivery additionally consumes:
- `notifyOnCompletion` (boolean, default `true`): Enables Session Completion for user-visible root sessions. The compatibility key is unchanged.
- `notifyOnSubtasks` (boolean, default `false` for new/missing settings): Independently enables completion alerts for visible child sessions. Existing saved booleans are preserved.
- `notifyOnPlanReady` (boolean, default `true`): Enables the independently configurable Plan Ready event.
- `notifyOnPermission` (boolean, default `true`): Enables Permissions Needed alerts for external-folder access requests. Other tool approvals retain the Agent Questions setting. Legacy settings inherit the former `notifyOnQuestion` value.
- `notificationTemplates.planReady`: `{ title, message }`, defaulting to `Plan ready` / `A plan is ready for review`.
- `notificationTemplates.permission`: `{ title, message }`, defaulting to `Permissions needed` / `Folder access is required: {last_message}`. For folder requests, `{last_message}` resolves to the first requested path pattern.

The foreground browser preference `nativeNotificationsEnabled` is personal
managed settings state. The UI obtains browser permission from the direct user
gesture, then persists it through `PUT /api/config/settings`; the multi-user
policy layer authorizes that field through Notifications Edit independently of
Sessions. Background web-push subscription routes and behavior are unchanged.
- `{last_message}` in the Plan Ready template resolves from the canonical plan markdown selected by the classifier, then follows the same summarization and truncation path as other templates.
- `{session_name}` prefers the latest meaningful generated or manual title. Generated `New session - <ISO>`, `Untitled Session`, Cursor error, and plan-control placeholders cannot overwrite a meaningful cached title while OpenCode is still persisting the rename.

Plan Ready native/UI payloads use `kind: "plan-ready"`; web push uses `data.type: "plan-ready"`. The tag contains both session ID and plan source message ID so distinct revisions remain independently deliverable.

## Response contracts

### `truncateNotificationText`
- Returns empty string for non-string input.
- Returns original text if under max length.
- Returns `${text.slice(0, maxLength)}...` for truncated text.

### `prepareNotificationLastMessage`
- Returns empty string for empty/null message.
- Returns truncated original message if summarization disabled, message under threshold, or summarization fails.
- Returns truncated summary if summarization succeeds and returns non-empty string.
- Normalizes markdown-like formatting to plain text before truncation.
- Always applies `maxLastMessageLength` truncation to final result.

## Notes for contributors

### Adding new notification helpers
1. Add new helper functions to `packages/web/server/lib/notifications/message.js`.
2. Export functions that are intended for public use.
3. Follow existing patterns for input validation (e.g., type checking for strings).
4. Use `resolvePositiveNumber` for numeric parameters with fallbacks to maintain safe defaults.
5. Add corresponding unit tests in `packages/web/server/lib/notifications/message.test.js`.

### Error handling
- `prepareNotificationLastMessage` catches summarization errors and falls back to original message.
- Completion settlement retains and retries candidates when required settings/delivery work fails.
- Plan history and template enrichment failures fall back without consuming otherwise eligible completion or sentinel-backed Plan Ready events.
- Invalid numeric parameters default to safe fallback values.
- Non-string inputs are handled gracefully (return empty string).

### Testing
- Run `bun run --cwd packages/web test` for server notification changes, followed by `bun run validate:affected`.
- Unit tests should cover truncation behavior, summarization success/failure, and edge cases (empty strings, invalid inputs).
