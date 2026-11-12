import { describe, expect, test } from "bun:test"
import type { Message, Session } from "@opencode-ai/sdk/v2/client"
import { stripMessageDiffSnapshots, stripSessionDiffSnapshots } from "./sanitize"

// Summaries here carry the fields OpenCode sends (and malformed ones the
// sanitizer tolerates); neither the session nor the message SDK type declares
// all of them.
function session(summary?: unknown, extra: Record<string, unknown> = {}): Session {
  return {
    id: "ses_1",
    title: "Session",
    time: { created: 1, updated: 2 },
    ...(summary === undefined ? {} : { summary }),
    ...extra,
  } as unknown as Session
}

function message(summary?: unknown): Message {
  return {
    id: "msg_1",
    sessionID: "ses_1",
    role: "user",
    time: { created: 1 },
    ...(summary === undefined ? {} : { summary }),
  } as unknown as Message
}

// The UI's bun:test typings (src/types/bun-test.d.ts) have no toStrictEqual,
// and toEqual ignores keys whose value is undefined, so the own-key paths are
// compared as well: a key set to undefined, or added, then shows up.
function keyPaths(value: unknown, path = ""): string[] {
  if (value === null || typeof value !== "object") return []
  return Object.entries(value).flatMap(([key, child]) => [`${path}/${key}`, ...keyPaths(child, `${path}/${key}`)])
}

function expectSameShape(actual: unknown, expected: unknown) {
  expect(actual).toEqual(expected)
  expect(keyPaths(actual)).toEqual(keyPaths(expected))
}

type SummaryView = { diffs?: Array<Record<string, unknown> | null>; [key: string]: unknown }

function summaryOf(value: Session | Message): SummaryView {
  return (value as unknown as { summary: SummaryView }).summary
}

describe("stripSessionDiffSnapshots", () => {
  test("returns the same session when there is no summary or no diff list", () => {
    for (const summary of [undefined, null, {}, { title: "t" }, { diffs: undefined }, { diffs: null }, "text", 4]) {
      const input = session(summary)
      expect(stripSessionDiffSnapshots(input)).toBe(input)
    }
  })

  test("returns the same session when diffs is not an array", () => {
    const objectDiffs = session({ diffs: { 0: { file: "a", patch: "x" } } })
    expect(stripSessionDiffSnapshots(objectDiffs)).toBe(objectDiffs)
    const stringDiffs = session({ diffs: "patch" })
    expect(stripSessionDiffSnapshots(stringDiffs)).toBe(stringDiffs)
  })

  test("returns the same session when no entry carries a string content field", () => {
    const empty = session({ diffs: [] })
    expect(stripSessionDiffSnapshots(empty)).toBe(empty)

    const metadataOnly = session({
      diffs: [
        { file: "a.ts", status: "modified", additions: 1, deletions: 2 },
        null,
        undefined,
        { file: "b.ts", patch: null, before: 5, after: { text: "x" }, from: undefined, to: false },
      ],
    })
    expect(stripSessionDiffSnapshots(metadataOnly)).toBe(metadataOnly)
  })

  test("drops every string content field and keeps entry metadata", () => {
    const input = session({
      diffs: [{
        file: "src/a.ts",
        status: "modified",
        additions: 3,
        deletions: 1,
        patch: "@@ -1 +1 @@",
        before: "old",
        after: "new",
        from: "a",
        to: "b",
        extra: "kept",
      }],
    })

    const result = stripSessionDiffSnapshots(input)
    expect(result).not.toBe(input)
    // The fields are deleted, not set to undefined.
    expectSameShape(summaryOf(result).diffs, [{
      file: "src/a.ts",
      status: "modified",
      additions: 3,
      deletions: 1,
      extra: "kept",
    }])
  })

  test("strips empty and very long strings alike, and only string-valued content fields", () => {
    const input = session({
      diffs: [
        { file: "a", patch: "" },
        { file: "b", before: "x".repeat(200_000), after: 7 },
      ],
    })
    expectSameShape(summaryOf(stripSessionDiffSnapshots(input)).diffs, [
      { file: "a" },
      { file: "b", after: 7 },
    ])
  })

  test("copies the session, summary and diff list, keeps unchanged entries and other fields by reference", () => {
    const untouched = { file: "keep.ts", additions: 1 }
    const changed = { file: "drop.ts", patch: "body" }
    const time = { created: 1, updated: 2 }
    const diffs = [untouched, changed, null]
    const summary = { title: "Summary", additions: 9, diffs }
    const input = session(summary, { time, share: { url: "u" } })

    const result = stripSessionDiffSnapshots(input)
    const resultSummary = summaryOf(result)

    expect(result).not.toBe(input)
    expect(resultSummary).not.toBe(summary)
    expect(resultSummary.diffs).not.toBe(diffs)
    expect(resultSummary.diffs?.[0]).toBe(untouched)
    expect(resultSummary.diffs?.[1]).not.toBe(changed)
    expect(resultSummary.diffs?.[2]).toBeNull()
    expect(resultSummary.title).toBe("Summary")
    expect(resultSummary.additions).toBe(9)
    expect(result.time).toBe(time)
    expect((result as unknown as { share: unknown }).share).toBe((input as unknown as { share: unknown }).share)
    expect(result.id).toBe("ses_1")
  })

  test("does not mutate the input", () => {
    const entry = { file: "a", patch: "p", before: "b" }
    const input = session({ diffs: [entry] })
    stripSessionDiffSnapshots(input)
    expect(entry).toEqual({ file: "a", patch: "p", before: "b" })
    expect(summaryOf(input).diffs?.[0]).toBe(entry)
  })

  test("keeps the order, duplicates and non-ASCII metadata of entries", () => {
    const shared = { file: "\u00e9\ud83d\ude00\ud800.ts", patch: "p" }
    const input = session({ diffs: [shared, { file: "z" }, shared] })
    const result = summaryOf(stripSessionDiffSnapshots(input)).diffs
    expect(result).toEqual([
      { file: "\u00e9\ud83d\ude00\ud800.ts" },
      { file: "z" },
      { file: "\u00e9\ud83d\ude00\ud800.ts" },
    ])
    // Each occurrence of a shared entry is copied on its own.
    expect(result?.[0]).not.toBe(result?.[2])
  })

  test("copies a stripped entry shallowly, keeping its nested values by reference", () => {
    const hunks = [{ start: 1, lines: 2 }]
    const input = session({ diffs: [{ file: "a", patch: "p", hunks }] })
    const entry = summaryOf(stripSessionDiffSnapshots(input)).diffs?.[0]
    expectSameShape(entry, { file: "a", hunks })
    expect(entry?.hunks).toBe(hunks)
  })

  test("a session that is already stripped is returned unchanged", () => {
    const once = stripSessionDiffSnapshots(session({ diffs: [{ file: "a", patch: "p" }] }))
    expect(stripSessionDiffSnapshots(once)).toBe(once)
  })
})

describe("stripMessageDiffSnapshots", () => {
  test("returns the same message when nothing needs stripping", () => {
    const bare = message()
    expect(stripMessageDiffSnapshots(bare)).toBe(bare)
    const clean = message({ diffs: [{ file: "a", additions: 1 }] })
    expect(stripMessageDiffSnapshots(clean)).toBe(clean)
  })

  test("strips patch bodies from a message summary the same way", () => {
    const keep = { file: "k" }
    const input = message({ title: "t", diffs: [{ file: "a", deletions: 2, patch: "p", to: "x" }, keep] })
    const result = stripMessageDiffSnapshots(input)
    expect(result).not.toBe(input)
    expectSameShape(summaryOf(result), { title: "t", diffs: [{ file: "a", deletions: 2 }, { file: "k" }] })
    const stripped = summaryOf(result).diffs?.[0] ?? {}
    expect(Object.hasOwn(stripped, "patch")).toBe(false)
    expect(Object.hasOwn(stripped, "to")).toBe(false)
    expect(summaryOf(result).diffs?.[1]).toBe(keep)
    expect(result.role).toBe("user")
  })
})
