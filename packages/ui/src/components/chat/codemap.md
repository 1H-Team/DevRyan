# packages/ui/src/components/chat/

## Responsibility
Implements the interactive chat surface: message timeline, composer/input, streaming status UI, permission/question blocking cards, and chat-specific navigation/scroll behavior.

## Design
- **Container + leaf split**: `ChatContainer.tsx` orchestrates state wiring, while specialized children (`MessageList`, `ChatInput`, `StatusRow*`, cards) handle focused rendering.
- **Performance-oriented memoization**: heavy/hot paths use `React.memo`, stable callbacks, and selector discipline to reduce render fanout during streaming.
- **Local domain helpers**: `lib/`, `hooks/`, and focused helpers such as `chatInputDraftPersistence.ts` encapsulate turn navigation, timeline, blocking requests, composer persistence, and scroll/follow logic.
- **Question-card ownership**: `QuestionCard.tsx` owns navigation and request lifecycle, `QuestionOptionRow.tsx` is the sole interactive owner for each option, and `questionCardSubmission.ts` provides session-scoped identities, acknowledgement reconciliation, retry filtering, and the duplicate-submit lock.
- **Managed-task dispatch projection**: `managedTaskDispatch.ts`, `ManagedTaskList.tsx`, and `ManagedTaskRow.tsx` replace raw `devryan_task` calls at their exact assistant-message position. Each dispatch card groups task rows under one agent heading, shows humanized subtask names and running/complete/error state, and links to child sessions; raw bridge calls never render as generic tool activity.
- **Manual model recovery**: `ModelRecoveryCard.tsx`, `PrimaryModelRecovery.tsx`, and `ControlledModelPicker.tsx` provide one Agent Dispatch-style recovery surface with locally controlled model and thinking-level selection for failed primary turns and resumable managed children.
- **Contract-aware message rendering**: message parts and tool activity rendering live under `message/parts/*` to map SDK part types to UI blocks.
- **Draft send ownership**: `draftAwareAgentChange.ts` resolves agent switches synchronously from the target agent's draft override, then its configured default, then an available fallback, and persists the resolved agent/model/variant atomically into the draft send snapshot. No delayed agent watcher may reapply stale state after rapid switching.
- **Mobile control ownership**: `ChatInput.tsx` renders the dedicated compact agent/model buttons, while `ModelControls.tsx` stays mounted with `hideInlineControls` to own only the mobile selector panels. Do not hide that owner with conflicting display utilities or render a second inline control row over the mobile buttons.

## Flow
1. `ChatView` mounts `ChatContainer`.
2. `ChatContainer` reads current session, messages, status, and permissions/questions from sync + stores.
3. `MessageList` renders timeline; `ChatInput` prepares/queues/sends user prompts with attachments and model/agent config.
4. Streaming events update sync state; chat auto-follow and status overlays react to live deltas.
5. Low-frequency managed-task projections render at the initiating start/retry call inside the assistant turn and notify the existing structural auto-follow path without subscribing chat chrome to the whole scheduler ledger.

## Integration
- Primary integrations: `src/sync/*` (`sync-context`, streaming/session actions), `stores/*` (UI/config/queue/git/directory and managed orchestration), `lib/opencode/client`, and `lib/orchestrationApi`.
- Consumed by `components/views/ChatView.tsx` and embedded runtime shells.
- Collaborates with `components/session/*` (pickers), `components/ui/*` primitives, and `hooks/*` for keyboard/voice/activity behavior.
