# Model Switch Handoff Context Design

## Problem

DevRyan preserves ordinary model changes within the OpenCode runtime because Anthropic and OpenAI models continue the same server session history. Cursor runs through a separate runtime, so DevRyan adds a bounded synthetic conversation-context part when a turn crosses the OpenCode/Cursor boundary.

The live Test-project flow succeeded in both directions: Anthropic to OpenAI to Cursor retained a first codeword, and Cursor back to Anthropic retained a second codeword. However, a deterministic long-context reproduction exposed a boundary case in the synthetic handoff builder. It selects recent source-runtime messages newest-first, reverses them into chronological order, and then truncates the completed prompt from the end. When the 6,000-character cap is exceeded, that final prefix slice preserves older selected messages while discarding the newest messages—the context most important to the next model.

## Desired Behavior

- Anthropic and OpenAI changes within the OpenCode runtime continue to use native session history without adding synthetic context.
- Every OpenCode/Cursor boundary receives one bounded synthetic context part when visible source-runtime messages exist.
- The newest source-runtime messages always receive budget priority.
- Included messages are presented to the target model in chronological order.
- Handoff context remains limited to eight messages, 1,400 visible-text characters per message, and 6,000 characters total.
- Older overflow is omitted explicitly rather than silently displacing newer context.
- Synthetic handoff parts are never used as source material for a later handoff.

## Scope

The change belongs in the shared UI send path in `packages/ui/src/sync/session-ui-store.ts`, where runtime-boundary context is already constructed before optimistic submission. Focused regressions belong in `packages/ui/src/sync/session-ui-store.send.test.ts`.

No provider API, web-server route, Cursor runtime contract, dependency, or persisted session format changes are needed. Because the send path is shared UI logic, the same behavior applies to web and Electron runtimes.

## Handoff Selection

The builder continues to identify the target backend from the selected provider and the opposite backend as the source. Starting from the newest message, it considers only the contiguous source-backend block of user and assistant messages. Existing synthetic parts and messages without visible text remain excluded. Selection collects at most nine eligible candidates: eight possible entries plus one overflow sentinel, so reaching the message-count limit can be represented explicitly.

Each candidate text is first capped at 1,400 characters. If all formatted candidates fit, the builder retains up to eight without an omission marker. If the ninth candidate exists or the complete formatted transcript exceeds 6,000 characters, the builder reserves space for the context header and an explicit older-context omission marker, then adds complete formatted entries newest-first while the remaining budget permits. It stops at eight entries or when the next older entry does not fit; it does not retain a partial older entry.

After selection, the included entries are reversed into chronological order for presentation. If an otherwise eligible older entry was excluded by the message-count or character limit, the omission marker appears before the included transcript. The final assembled part must never exceed 6,000 characters.

This order of operations makes recency the allocation policy while keeping the prompt readable as a conversation.

## Invariants and Failure Behavior

- A same-backend switch returns the original outgoing parts unchanged.
- Missing provider metadata, missing source messages, or an empty visible transcript returns the original outgoing parts unchanged.
- A runtime-boundary switch prepends at most one synthetic text part to the current user turn.
- The current outgoing user text is not duplicated inside the synthetic history.
- Selected transcript entries preserve their user/assistant roles and chronological order.
- Older-context omission is visible to the target model whenever bounded selection drops otherwise eligible context.
- The builder retains at most nine handoff candidates during its reverse scan and does not add work to streaming event handlers.

## Testing

Focused tests will cover:

1. OpenCode to Cursor transfers short visible context.
2. Cursor to OpenCode transfers short visible context.
3. A verbose, over-budget transcript preserves the newest marker, excludes older overflow, includes the omission marker, remains chronological, and stays at or below 6,000 characters.
4. A same-backend model change does not inject synthetic context.
5. Synthetic context is not copied transitively into a later handoff.

After automated tests, the live Test-project sequence will be repeated across Anthropic, OpenAI, Cursor, and back to Anthropic. The test prompts will use harmless codewords and must leave `/Users/zoubair/Repositories/Test` unchanged.

Validation will include the focused session-send tests and the repository's changed-file-aware validation. Any workspace-wide validation limitation caused by unrelated concurrent work will be reported separately from the focused result.
