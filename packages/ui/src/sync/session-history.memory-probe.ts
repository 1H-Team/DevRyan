// Run in an isolated process: bun run --cwd packages/ui src/sync/session-history.memory-probe.ts
import assert from "node:assert/strict"
import type { AssistantMessage, Message, Part, Session, UserMessage } from "@opencode-ai/sdk/v2/client"
import { opencodeClient } from "@/lib/opencode/client"
import { useFeatureFlagsStore } from "@/stores/useFeatureFlagsStore"
import { buildTurnWindowModel, windowMessagesByTurn } from "@/components/chat/lib/turns/windowTurns"
import { ChildStoreManager } from "./child-store"
import { SessionHistory } from "./session-history"
import { SessionMessageLoader } from "./session-message-loader"

type RecordRow = { info: Message; parts: Part[] }
const target = { directory: "/devryan-isolated-memory-probe", sessionID: "ses_memory_probe" }
const session: Session = { id: target.sessionID, slug: "memory-probe", projectID: "probe", directory: target.directory,
  title: "Isolated memory probe", version: "fixture", time: { created: 1, updated: 1 } }

function turn(index: number, steps: number, calls: number, outputBytes: number): RecordRow[] {
  const created = index * 1_000 + 1
  const user: UserMessage = { id: `msg_${index}_user`, sessionID: target.sessionID, role: "user", time: { created },
    agent: "build", model: { providerID: "fixture", modelID: "fixture" } }
  const rows: RecordRow[] = [{ info: user, parts: [{ id: `${user.id}_text`, messageID: user.id,
    sessionID: target.sessionID, type: "text", text: `Inspect fixture turn ${index}.` }] }]
  for (let step = 0; step <= steps; step++) {
    const final = step === steps
    const info: AssistantMessage = { id: `msg_${index}_step_${step}`, sessionID: target.sessionID,
      role: "assistant", parentID: user.id, time: { created: created + step + 1, completed: created + step + 2 },
      agent: "build", mode: "build", modelID: "fixture", providerID: "fixture",
      path: { cwd: target.directory, root: target.directory }, cost: 0,
      tokens: { input: 10, output: 10, reasoning: 0, cache: { read: 0, write: 0 } }, finish: final ? "stop" : "tool-calls" }
    const parts: Part[] = final
      ? [{ id: `${info.id}_text`, messageID: info.id, sessionID: target.sessionID, type: "text", text: "Inspection complete." }]
      : Array.from({ length: calls }, (_, call): Part => ({
        id: `${info.id}_tool_${call}`, messageID: info.id, sessionID: target.sessionID,
        type: "tool", callID: `${info.id}_call_${call}`, tool: "read",
        state: { status: "completed", input: { filePath: `fixture-${index}-${step}-${call}.txt` },
          output: `${index}:${step}:${call}:`.padEnd(outputBytes, "x").slice(0, outputBytes),
          title: "Read fixture", metadata: {}, time: { start: created + step, end: created + step + 1 } },
      }))
    rows.push({ info, parts })
  }
  return rows
}

async function probe(turns: number, steps: number, calls: number, outputBytes: number) {
  const stores = new ChildStoreManager()
  const loader = new SessionMessageLoader(stores)
  const history = new SessionHistory({ childStores: stores, loader,
    getSdk: directory => opencodeClient.getScopedSdkClient(directory) })
  // Mirrors the SyncProvider's selected/loading/optimistic protection callback.
  stores.configure({ isHistoryProtected: (_directory, id) => id === target.sessionID,
    onHistoryEvict: (directory, sessionID) => loader.invalidateSession({ directory, sessionID }) })
  const records: RecordRow[] = []
  let latestPage: RecordRow[] = []
  const durations: number[] = []
  const original = Object.getOwnPropertyDescriptor(opencodeClient, "getScopedSdkClient")
  Object.defineProperty(opencodeClient, "getScopedSdkClient", { configurable: true,
    value: () => ({ session: {
      get: async () => ({ data: session }),
      messages: async ({ limit }: { limit: number }) => {
        latestPage = records.slice(-limit)
        return { data: latestPage, response: { headers: { get: (name: string) => name === "x-next-cursor" && records.length > limit ? "v2:opaque-fixture-cursor" : null } } }
      },
    } }) })
  try {
    for (let index = 0; index < turns; index++) {
      records.push(...turn(index, steps, calls, outputBytes))
      const started = performance.now()
      if (index === 0) await history.ensureFirstPage(target)
      else await loader.refreshTail(target)
      assert.equal(loader.getSnapshot(target).status, "ready")
      durations.push(performance.now() - started)
    }
    stores.historyBudget.flush()
    const state = stores.getChild(target.directory)?.getState()
    assert.ok(state)
    const retained = (state.message[target.sessionID] ?? []).map(info => ({ info, parts: state.part[info.id] ?? [] }))
    const model = buildTurnWindowModel(retained)
    const visible = windowMessagesByTurn(retained, model, Math.max(0, model.turnCount - 10))
    const completedToolOutputBytes = retained.reduce((total, row) => total + row.parts.reduce((sum, part) => (
      sum + (part.type === "tool" && part.state.status === "completed" ? Buffer.byteLength(part.state.output) : 0)
    ), 0), 0)
    const pageWithoutOutputs = latestPage.map(row => ({ ...row, parts: row.parts.map(part => (
      part.type === "tool" && part.state.status === "completed" ? { ...part, state: { ...part.state, output: "" } } : part
    )) }))
    durations.sort((left, right) => left - right)
    // The fixture intentionally models an active session that continues receiving tail pages.
    assert.equal(retained.length, records.length)
    const result = { turns, stepsPerTurn: steps, callsPerStep: calls, outputBytesPerCall: outputBytes,
      retainedRecords: retained.length, retainedToolParts: turns * steps * calls,
      windowedRecords: visible.length, retainedJsonBytes: Buffer.byteLength(JSON.stringify(retained)),
      completedToolOutputBytes, ...stores.historyBudget.snapshot(),
      latestPageBytes: Buffer.byteLength(JSON.stringify(latestPage)),
      latestPageWithoutOutputBytes: Buffer.byteLength(JSON.stringify(pageWithoutOutputs)),
      hydrationMedianMs: Number(durations[Math.floor(durations.length / 2)].toFixed(3)),
      hydrationP95Ms: Number(durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.95))].toFixed(3)) }
    return result
  } finally {
    history.dispose()
    loader.dispose()
    stores.disposeAll()
    assert.equal(stores.historyBudget.snapshot().estimatedBytes, 0)
    if (original) Object.defineProperty(opencodeClient, "getScopedSdkClient", original)
  }
}

const originalFastLoad = useFeatureFlagsStore.getState().sessionFastLoadEnabled
useFeatureFlagsStore.getState().setSessionFastLoadEnabled(true)
try {
  const results = []
  for (const bytes of [0, 8_192]) for (const turns of [10, 100]) results.push(await probe(turns, 20, 5, bytes))
  results.push(await probe(1, 1, 100, 8_192))
  console.log(JSON.stringify({ measurement: "Synthetic retained JSON and production byte estimates; no browser heap/RSS or frame-rate claim", results }, null, 2))
} finally {
  useFeatureFlagsStore.getState().setSessionFastLoadEnabled(originalFastLoad)
}
// Imported UI singletons own background timers; this CLI has disposed its owners.
process.exit(0)
