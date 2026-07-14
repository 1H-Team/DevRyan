# Model Switch Handoff Retention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve the newest visible messages when DevRyan builds bounded context for a model switch across the OpenCode/Cursor runtime boundary.

**Architecture:** Keep handoff construction in the shared session send path. Collect at most eight entries plus one overflow sentinel, detect whether the full transcript fits, and only on overflow allocate the 6,000-character budget newest-first before restoring chronological presentation order.

**Tech Stack:** TypeScript, Zustand session UI store, Bun test runner.

## Global Constraints

- Same-backend Anthropic/OpenAI and Cursor/Cursor switches must not add synthetic handoff context.
- Cross-runtime handoff context is limited to eight messages, 1,400 visible-text characters per message, and 6,000 characters total.
- Newest eligible messages receive budget priority; retained messages are presented chronologically.
- Older overflow is represented by `[older conversation context omitted]`.
- Synthetic parts are excluded from later handoff source material.
- No new dependencies, provider APIs, server routes, Cursor runtime contracts, or persisted formats.
- Preserve all unrelated dirty workspace changes.

---

### Task 1: Retain Newest Cross-Runtime Context

**Files:**
- Modify: `packages/ui/src/sync/session-ui-store.ts:1234-1287`
- Test: `packages/ui/src/sync/session-ui-store.send.test.ts:1587-1647`

**Interfaces:**
- Consumes: `getSyncMessages(sessionId, directory)`, `getSyncParts(messageId, directory)`, `getProviderBackend(providerId)`, `getVisibleTextFromParts(parts)`, and `truncateHandoffText(text)`.
- Produces: the existing private `buildCrossRuntimeHandoffPart(params): { text: string; synthetic: true } | undefined` behavior, with newest-first overflow allocation and chronological output.

- [ ] **Step 1: Add the failing over-budget regression and boundary characterization tests**

Add OpenCode-to-Cursor short-context, OpenCode same-backend, non-transitive synthetic-context, and over-budget tests beside the existing Cursor-to-OpenCode test. Construct eight chronological OpenCode messages with unique `OLDEST_CONTEXT` and `NEWEST_CONTEXT` markers and 1,390-character payloads. Assert that the resulting synthetic part includes the newest marker, omits the oldest marker, contains `[older conversation context omitted]`, keeps retained role lines in chronological order, and is no longer than 6,000 characters.

```ts
test("adds synthetic handoff context when switching from OpenCode to Cursor SDK", async () => {
  mockSyncMessages = [{
    id: "msg_open_assistant",
    role: "assistant",
    providerID: "anthropic",
    modelID: "claude-sonnet-4-5",
    time: { created: 1 },
  }]
  mockPartsByMessage = new Map([[
    "msg_open_assistant",
    [{ id: "prt_open", messageID: "msg_open_assistant", type: "text", text: "OpenCode retained this detail." }],
  ]])

  await useSessionUIStore.getState().sendMessageToSession(
    "session-a",
    "Continue in Cursor",
    "cursor-acp",
    "composer-2.5",
    "builder",
  )

  const additionalParts = sendMessageCalls[0]?.additionalParts as Array<Record<string, unknown>> | undefined
  expect(additionalParts?.[0]?.synthetic).toBe(true)
  expect(String(additionalParts?.[0]?.text)).toContain("Conversation context from OpenCode turns")
  expect(String(additionalParts?.[0]?.text)).toContain("Assistant: OpenCode retained this detail.")
})

test("does not add synthetic handoff context between OpenCode providers", async () => {
  mockSyncMessages = [{
    id: "msg_anthropic",
    role: "assistant",
    providerID: "anthropic",
    modelID: "claude-sonnet-4-5",
    time: { created: 1 },
  }]
  mockPartsByMessage = new Map([[
    "msg_anthropic",
    [{ id: "prt_anthropic", messageID: "msg_anthropic", type: "text", text: "Native history" }],
  ]])

  await useSessionUIStore.getState().sendMessageToSession(
    "session-a",
    "Continue with OpenAI",
    "openai",
    "gpt-5.5",
    "builder",
  )

  expect(sendMessageCalls[0]?.additionalParts).toBe(undefined)
})

test("does not copy synthetic context into a later runtime handoff", async () => {
  mockSyncMessages = [{
    id: "msg_cursor",
    role: "assistant",
    providerID: "cursor-acp",
    modelID: "composer-2.5",
    time: { created: 1 },
  }]
  mockPartsByMessage = new Map([[
    "msg_cursor",
    [
      { id: "prt_synthetic", messageID: "msg_cursor", type: "text", text: "STALE_SYNTHETIC_CONTEXT", synthetic: true },
      { id: "prt_visible", messageID: "msg_cursor", type: "text", text: "Newest real Cursor reply." },
    ],
  ]])

  await useSessionUIStore.getState().sendMessageToSession(
    "session-a",
    "Continue with OpenCode",
    "anthropic",
    "claude-sonnet-4-5",
    "builder",
  )

  const additionalParts = sendMessageCalls[0]?.additionalParts as Array<Record<string, unknown>> | undefined
  const handoff = String(additionalParts?.[0]?.text)
  expect(handoff).toContain("Newest real Cursor reply.")
  expect(handoff).not.toContain("STALE_SYNTHETIC_CONTEXT")
})

test("prioritizes newest messages when cross-runtime handoff context exceeds its budget", async () => {
  mockSyncMessages = Array.from({ length: 8 }, (_, index) => ({
    id: `msg_long_${index + 1}`,
    role: index % 2 === 0 ? "user" : "assistant",
    providerID: "anthropic",
    modelID: "claude-sonnet-4-5",
    time: { created: index + 1 },
  }))
  mockPartsByMessage = new Map(mockSyncMessages.map((message, index) => {
    const marker = index === 0 ? "OLDEST_CONTEXT" : index === 7 ? "NEWEST_CONTEXT" : `CONTEXT_${index + 1}`
    return [
      String(message.id),
      [{ id: `prt_long_${index + 1}`, messageID: message.id, type: "text", text: `${marker}:${"x".repeat(1390)}` }],
    ] as const
  }))

  await useSessionUIStore.getState().sendMessageToSession(
    "session-a",
    "Continue with the newest context",
    "cursor-acp",
    "composer-2.5",
    "builder",
  )

  const additionalParts = sendMessageCalls[0]?.additionalParts as Array<Record<string, unknown>> | undefined
  const handoff = String(additionalParts?.[0]?.text)
  expect(handoff).toContain("NEWEST_CONTEXT")
  expect(handoff).not.toContain("OLDEST_CONTEXT")
  expect(handoff).toContain("[older conversation context omitted]")
  expect(handoff.length).toBeLessThanOrEqual(6000)
  expect(handoff.indexOf("CONTEXT_5")).toBeLessThan(handoff.indexOf("NEWEST_CONTEXT"))
})
```

- [ ] **Step 2: Run the over-budget regression and verify RED**

Run:

```bash
bun test packages/ui/src/sync/session-ui-store.send.test.ts --test-name-pattern "prioritizes newest messages"
```

Expected: FAIL because the current prefix slice includes `OLDEST_CONTEXT`, drops `NEWEST_CONTEXT`, has no older-context omission marker, or exceeds 6,000 characters.

- [ ] **Step 3: Implement newest-first budget allocation**

Add the omission marker constant next to the existing limits:

```ts
const CROSS_RUNTIME_HANDOFF_OMISSION_MARKER = "[older conversation context omitted]"
```

Replace the handoff selection/assembly portion with bounded candidate collection and a formatting helper:

```ts
const candidates: Array<{ role: "user" | "assistant"; text: string }> = []
for (let index = messages.length - 1; index >= 0; index -= 1) {
  const message = messages[index]
  const role = message?.role
  if (role !== "user" && role !== "assistant") continue

  const backend = getProviderBackend(getMessageProviderId(message))
  if (backend !== sourceBackend) {
    if (candidates.length > 0) break
    continue
  }

  const text = getVisibleTextFromParts(getSyncParts(message.id, params.directory ?? undefined) as Part[])
  if (!text) continue

  candidates.push({ role, text: truncateHandoffText(text) })
  if (candidates.length > CROSS_RUNTIME_HANDOFF_MAX_MESSAGES) break
}

if (candidates.length === 0) return undefined

const sourceLabel = sourceBackend === "cursor" ? "Cursor SDK" : "OpenCode"
const targetLabel = targetBackend === "cursor" ? "Cursor SDK" : "OpenCode"
const header = `Conversation context from ${sourceLabel} turns, supplied because this reply is switching to ${targetLabel}:`
const formatEntry = (entry: { role: "user" | "assistant"; text: string }): string => (
  `${entry.role === "user" ? "User" : "Assistant"}: ${entry.text}`
)
const boundedCandidates = candidates.slice(0, CROSS_RUNTIME_HANDOFF_MAX_MESSAGES)
const formatTranscript = (
  entriesNewestFirst: Array<{ role: "user" | "assistant"; text: string }>,
  omitted: boolean,
): string => [
  header,
  ...(omitted ? [CROSS_RUNTIME_HANDOFF_OMISSION_MARKER] : []),
  ...[...entriesNewestFirst].reverse().map(formatEntry),
].join("\n\n").trim()

const completeText = formatTranscript(boundedCandidates, false)
const hasOverflow = candidates.length > CROSS_RUNTIME_HANDOFF_MAX_MESSAGES
  || completeText.length > CROSS_RUNTIME_HANDOFF_MAX_CHARS
if (!hasOverflow) return { text: completeText, synthetic: true }

const retained: Array<{ role: "user" | "assistant"; text: string }> = []
for (const candidate of boundedCandidates) {
  const next = [...retained, candidate]
  if (formatTranscript(next, true).length > CROSS_RUNTIME_HANDOFF_MAX_CHARS) break
  retained.push(candidate)
}

return { text: formatTranscript(retained, true), synthetic: true }
```

- [ ] **Step 4: Run the focused handoff tests and verify GREEN**

Run:

```bash
bun test packages/ui/src/sync/session-ui-store.send.test.ts --test-name-pattern "handoff|same-backend"
```

Expected: all matching tests pass with zero failures.

- [ ] **Step 5: Run the full session send test file**

Run:

```bash
bun test packages/ui/src/sync/session-ui-store.send.test.ts
```

Expected: all tests in the file pass with zero failures.

- [ ] **Step 6: Commit the focused code change**

```bash
git add packages/ui/src/sync/session-ui-store.ts packages/ui/src/sync/session-ui-store.send.test.ts
git commit -m "fix: preserve newest model handoff context"
```

### Task 2: Validate and Exercise the Model-Switch Flow

**Files:**
- Verify: `packages/ui/src/sync/session-ui-store.ts`
- Verify: `packages/ui/src/sync/session-ui-store.send.test.ts`
- Test project: `/Users/zoubair/Repositories/Test` (read and prompt only; no file changes)

**Interfaces:**
- Consumes: DevRyan's Electron UI and configured Anthropic, OpenAI/ChatGPT, and Cursor providers.
- Produces: verification evidence for native OpenCode continuity and both OpenCode/Cursor boundary directions.

- [ ] **Step 1: Run affected repository validation**

Run:

```bash
bun run validate:affected
```

Expected: affected lint, type-check, and UI tests complete with exit code 0. If unrelated workspace changes expand or block validation, record the exact failing command and keep it separate from focused handoff results.

- [ ] **Step 2: Repeat the live Test-project sequence**

In the DevRyan Electron app, open `/Users/zoubair/Repositories/Test` and send harmless prompts in one session:

1. Anthropic: remember `EMBER-614`, reply only `ANTHROPIC-READY`.
2. OpenAI/ChatGPT: report the first codeword as `OPENAI:<codeword>`.
3. Cursor: report the first codeword as `CURSOR:<codeword>`, then remember `GLACIER-927` and reply only `CURSOR-READY`.
4. Anthropic: report the second codeword as `ANTHROPIC-SECOND:<codeword>`.

Expected responses: `ANTHROPIC-READY`, `OPENAI:EMBER-614`, `CURSOR:EMBER-614`, `CURSOR-READY`, and `ANTHROPIC-SECOND:GLACIER-927`.

- [ ] **Step 3: Verify the Test project stayed clean**

Run:

```bash
git -C /Users/zoubair/Repositories/Test status --short --branch
```

Expected: only the branch line, with no modified or untracked files.

- [ ] **Step 4: Review the final diff and requirement checklist**

Run:

```bash
git show --stat --oneline HEAD
git show --check --format= HEAD
git status --short --branch
```

Expected: the focused implementation commit contains only the shared handoff implementation and its test; unrelated pre-existing workspace changes remain uncommitted and untouched.
