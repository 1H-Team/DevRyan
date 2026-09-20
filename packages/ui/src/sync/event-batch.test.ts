import { expect, test } from "bun:test"
import type { Event } from "@opencode-ai/sdk/v2/client"
import { ChildStoreManager } from "./child-store"
import { applyDirectoryEvent } from "./event-reducer"
import { applyStreamingEventBatch, createEventDraft } from "./event-batch"

const delta = (delta: string): Event => ({ id: `e-${delta}`, type: "message.part.delta", properties: { sessionID: "s", messageID: "m", partID: "p", field: "text", delta } })
test("stream batches copy the map once, notify once, preserve old snapshots and flush before barriers", () => {
  const manager = new ChildStoreManager()
  const store = manager.ensureChild("/a", { bootstrap: false })
  store.setState({
    message: { s: [{ id: "m", sessionID: "s", role: "user", time: { created: 1 }, agent: "test", model: { providerID: "test", modelID: "test" } }] },
    session_status: { s: { type: "busy" } },
    part: { m: [{ id: "p", messageID: "m", sessionID: "s", type: "text", text: "" }] },
  })
  const initial = store.getState()
  let commits = 0
  store.subscribe(() => commits++)
  const ownedMaps = new Set()
  const observed: string[] = []
  const events: Event[] = [delta("a"), delta("b"), delta("c"), { id: "idle", type: "session.idle", properties: { sessionID: "s" } }, delta("d")]
  applyStreamingEventBatch({ events, resolveStore: () => store, resolveSession: () => "s", apply: (event, batch) => {
    if (event.type === "session.idle") observed.push(JSON.stringify(store.getState().part.m))
    const target = batch?.staged ?? store
    const draft = batch ? batch.draft(target.getState(), event) : createEventDraft(target.getState(), event)
    if (batch) ownedMaps.add(draft.part)
    if (applyDirectoryEvent(draft, event)) target.setState(draft)
  } })
  expect(commits).toBe(3)
  expect(ownedMaps.size).toBe(1)
  expect(observed[0]).toContain('"text":"abc"')
  expect(store.getState().part.m?.[0]).toMatchObject({ text: "abcd" })
  expect(initial.part.m?.[0]).toMatchObject({ text: "" })
  expect(store.getState().message).toBe(initial.message)
  manager.disposeAll()
})
