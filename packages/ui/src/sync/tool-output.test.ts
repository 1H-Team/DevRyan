import { describe, expect, test } from "bun:test"
import type { Message, Part, ToolPart } from "@opencode-ai/sdk/v2/client"
import { materializeSessionSnapshots } from "./materialization"
import { isToolOutputOmitted, keepFullToolOutput, mergeLoadedToolOutput, type OmittedToolOutputState } from "./tool-output"

const SESSION = "ses_tool_output"
const MESSAGE = "msg_tool_output"

const read = (id: string, output: string): ToolPart => ({
  id, sessionID: SESSION, messageID: MESSAGE, type: "tool", callID: `call_${id}`, tool: "read",
  state: { status: "completed", input: { filePath: `/repo/${id}.ts` }, output, title: id, metadata: {}, time: { start: 1, end: 2 } },
})
// The shape a `toolOutput=omit` page delivers for the same part.
const omitted = (part: ToolPart): ToolPart => {
  if (part.state.status !== "completed") throw new Error("fixture must be completed")
  const state: OmittedToolOutputState = { ...part.state, output: "", outputOmitted: true, outputBytes: part.state.output.length }
  return { ...part, state }
}
const assistant: Message = {
  id: MESSAGE, sessionID: SESSION, role: "assistant", parentID: "msg_user", modelID: "m", providerID: "p", mode: "build",
  agent: "build", path: { cwd: "/repo", root: "/repo" }, cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, completed: 2 },
} as Message

describe("omitted tool output", () => {
  test("recognises only completed tool parts carrying the marker", () => {
    expect(isToolOutputOmitted(omitted(read("a", "body")))).toBe(true)
    expect(isToolOutputOmitted(read("a", ""))).toBe(false)
    const text: Part = { id: "t", sessionID: SESSION, messageID: MESSAGE, type: "text", text: "hi" }
    expect(isToolOutputOmitted(text)).toBe(false)
    const stateless = { id: "s", sessionID: SESSION, messageID: MESSAGE, type: "tool", callID: "c", tool: "read" } as unknown as Part
    expect(isToolOutputOmitted(stateless)).toBe(false)
    expect(keepFullToolOutput(stateless, stateless)).toBe(stateless)
  })

  test("a trimmed snapshot keeps the full part it would replace", () => {
    const full = read("a", "body")
    expect(keepFullToolOutput(full, omitted(full))).toBe(full)
    // Other fields the snapshot changed still apply, with the full output.
    const snapshotState = omitted(full).state
    if (snapshotState.status !== "completed") throw new Error("fixture must be completed")
    const retitled: ToolPart = { ...omitted(full), state: { ...snapshotState, title: "renamed" } }
    const kept = keepFullToolOutput(full, retitled)
    expect(kept).not.toBe(full)
    expect(kept).toMatchObject({ state: { title: "renamed", output: "body" } })
    expect(isToolOutputOmitted(kept)).toBe(false)
    // Nothing to keep: no existing part, or an existing part that is itself trimmed.
    const snapshot = omitted(full)
    expect(keepFullToolOutput(undefined, snapshot)).toBe(snapshot)
    expect(keepFullToolOutput(omitted(full), snapshot)).toBe(snapshot)
  })

  test("an expand read restores only omitted parts and keeps every other reference", () => {
    const loadedA = read("a", "body a")
    const fullB = read("b", "body b")
    const current = [omitted(loadedA), fullB]
    const merged = mergeLoadedToolOutput(current, [loadedA, read("b", "other")])
    expect(merged).not.toBe(current)
    expect(merged[0]).toBe(loadedA)
    expect(merged[1]).toBe(fullB)
    expect(mergeLoadedToolOutput(merged, [loadedA])).toBe(merged)
    // A read that is still trimmed never counts as restored output.
    expect(mergeLoadedToolOutput(current, [omitted(loadedA)])).toBe(current)
  })

  test("a refresh page with trimmed output never overwrites live full output", () => {
    const live = read("a", "live body")
    const sibling = read("b", "sibling body")
    const state = { message: { [SESSION]: [assistant] }, part: { [MESSAGE]: [live, sibling] } }
    const result = materializeSessionSnapshots(state, SESSION, [{ info: assistant, parts: [omitted(live), omitted(sibling)] }])
    expect(result.partsChanged).toBe(false)
    expect(result.part).toBe(state.part)
    expect(result.part[MESSAGE][0]).toBe(live)

    // A cold load takes the trimmed snapshot as it is.
    const cold = materializeSessionSnapshots({ message: {}, part: {} }, SESSION, [{ info: assistant, parts: [omitted(live)] }])
    expect(isToolOutputOmitted(cold.part[MESSAGE][0])).toBe(true)
  })
})
