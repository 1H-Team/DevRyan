import { expect, test } from "bun:test"
import { ChildStoreManager } from "./child-store"

function load(manager: ChildStoreManager, directory: string, id: string, length = 1000) {
  const store = manager.ensureChild(directory, { bootstrap: false })
  const state = store.getState()
  store.setState({
    message: { ...state.message, [id]: [{ id: `msg-${id}`, sessionID: id, role: "user", time: { created: 1 }, agent: "test", model: { providerID: "test", modelID: "test" } }] },
    part: { ...state.part, [`msg-${id}`]: [{ id: `part-${id}`, sessionID: id, messageID: `msg-${id}`, type: "text", text: "x".repeat(length) }] },
  })
  manager.historyBudget.touch(directory, id)
  return store
}

test("one byte budget evicts the oldest large history across directories and invalidates coverage", () => {
  const manager = new ChildStoreManager({ historyByteLimit: 8000 })
  const evicted: string[] = []
  manager.configure({ onHistoryEvict: (directory, id) => evicted.push(`${directory}:${id}`) })
  const first = load(manager, "/a", "large", 2000)
  const second = load(manager, "/b", "small", 200)
  manager.historyBudget.flush()
  expect(first.getState().message.large).toBeDefined()
  load(manager, "/b", "new", 1000)
  manager.historyBudget.flush()
  expect(first.getState().message.large).toBeUndefined()
  expect(second.getState().message.small).toBeDefined()
  expect(evicted).toEqual(["/a:large"])
  expect(manager.historyBudget.snapshot().overBudgetBytes).toBe(0)
  // A fresh materialization is counted and can be used normally after eviction.
  load(manager, "/a", "large", 100)
  manager.historyBudget.flush()
  expect(first.getState().part["msg-large"]).toHaveLength(1)
  manager.disposeAll()
  expect(manager.historyBudget.snapshot().estimatedBytes).toBe(0)
})

test("protects working, blocking and externally pinned histories even over the soft budget", () => {
  const manager = new ChildStoreManager({ historyByteLimit: 0 })
  let pinned = true
  manager.configure({ isHistoryProtected: (_directory, id) => pinned && ["active", "loading", "optimistic"].includes(id) })
  for (const id of ["active", "loading", "optimistic", "busy", "question", "permission"]) load(manager, "/a", id)
  const store = manager.getChild("/a")!
  store.setState({
    session_status: { busy: { type: "busy" } },
    question: { question: [{ id: "q", sessionID: "question", questions: [] }] },
    permission: { permission: [{ id: "p", sessionID: "permission", permission: "edit", patterns: [], always: [], metadata: {} }] },
  })
  manager.historyBudget.flush()
  expect(Object.keys(store.getState().message)).toHaveLength(6)
  expect(manager.historyBudget.snapshot().overBudgetBytes).toBeGreaterThan(0)
  pinned = false
  store.setState({ session_status: {}, permission: {}, question: {} })
  manager.historyBudget.flush()
  expect(Object.keys(store.getState().message)).toHaveLength(0)
  expect(manager.historyBudget.snapshot().estimatedBytes).toBe(0)
  manager.disposeAll()
})

test("retained estimates plateau through repeated navigation and release directory ownership", () => {
  const manager = new ChildStoreManager({ historyByteLimit: 10_000 })
  for (let index = 0; index < 100; index++) {
    load(manager, `/dir-${index % 3}`, `s-${index}`, 1000 + index)
    manager.historyBudget.flush()
    expect(manager.historyBudget.snapshot().estimatedBytes <= 10_000).toBe(true)
  }
  manager.disposeAll()
  manager.historyBudget.flush()
  expect(manager.historyBudget.snapshot().estimatedBytes).toBe(0)
})

test("counts streaming replacements once and retains unchanged record identity", () => {
  const manager = new ChildStoreManager({ historyByteLimit: 100_000 })
  const store = load(manager, "/a", "s", 100)
  manager.historyBudget.flush()
  const before = manager.historyBudget.snapshot().estimatedBytes
  const messages = store.getState().message
  const part = store.getState().part["msg-s"]![0]
  if (part.type !== "text") throw new Error("Expected text fixture")
  store.setState({ part: { "msg-s": [{ ...part, type: "text", text: "x".repeat(200) }] } })
  manager.historyBudget.flush()
  expect(manager.historyBudget.snapshot().estimatedBytes - before).toBe(200)
  expect(store.getState().message).toBe(messages)
  manager.disposeAll()
})
