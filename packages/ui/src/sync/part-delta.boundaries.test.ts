import { describe, expect, test } from "bun:test"
import {
  appendNonOverlappingDelta,
  appendStreamingTextDelta,
  collapseExactAdjacentTextRepeats,
} from "./part-delta"

// 40 UTF-16 units: above the 32-unit floor for a repeat to collapse.
const LINE = "The assistant wrote this sentence once. "
// `count` distinct CJK characters (one UTF-16 unit each): no repeat of their own.
const distinct = (count: number) => Array.from({ length: count }, (_, index) => String.fromCharCode(0x4e00 + index)).join("")
// `count` distinct astral characters (two UTF-16 units each, one code point).
const distinctAstral = (count: number) => Array.from({ length: count }, (_, index) => String.fromCodePoint(0x1f300 + index)).join("")

describe("appendNonOverlappingDelta: the 5-unit partial-overlap floor", () => {
  test("keeps a 4-unit overlap between the value's tail and the delta's head, repeating it", () => {
    expect(appendNonOverlappingDelta("plan: word", "word count")).toBe("plan: wordword count")
  })

  test("swallows a 5-unit overlap, exactly at the floor", () => {
    expect(appendNonOverlappingDelta("plan: words", "words count")).toBe("plan: words count")
  })

  test("swallows a 6-unit overlap, above the floor", () => {
    expect(appendNonOverlappingDelta("abc 123456", "123456 tail")).toBe("abc 123456 tail")
  })

  test("tries the longest overlap first", () => {
    // Overlaps 5 to 7 all match; the longest (7) wins and only "b" is appended.
    expect(appendNonOverlappingDelta("xaaaaaaa", "aaaaaaab")).toBe("xaaaaaaab")
  })

  test("tries overlaps up to one unit short of the whole delta", () => {
    // Overlap 5 is the whole delta less its last unit.
    expect(appendNonOverlappingDelta("xxhello", "hello!")).toBe("xxhello!")
  })

  test("measures the overlap in UTF-16 units, so two surrogate pairs and a letter reach the floor", () => {
    // 5 units, 3 code points: a code point count would be below the floor.
    const emoji = "\ud83d\ude00\ud83d\ude00a"
    expect(emoji.length).toBe(5)
    expect(appendNonOverlappingDelta(`x ${emoji}`, `${emoji}!`)).toBe(`x ${emoji}!`)
    // One surrogate pair and two letters: 4 units, kept.
    expect(appendNonOverlappingDelta("x \ud83d\ude00ab", "\ud83d\ude00ab!")).toBe("x \ud83d\ude00ab\ud83d\ude00ab!")
  })
})

describe("appendStreamingTextDelta: the 2,048-unit jammed-scan limit on the combined value", () => {
  const delta = `${LINE}${LINE}`

  // Each "collapses" case below drops the delta's second copy of LINE: a provider replay
  // and a model that really wrote the sentence twice look the same, and both lose a copy.
  test("drops the second of two jammed copies when the combined value is one unit under the limit", () => {
    const existing = distinct(2047 - delta.length)
    expect(existing.length + delta.length).toBe(2047)
    expect(appendStreamingTextDelta(existing, delta)).toBe(`${existing}${LINE}`)
  })

  test("drops the second of two jammed copies when the combined value is exactly at the limit", () => {
    const existing = distinct(2048 - delta.length)
    expect(existing.length + delta.length).toBe(2048)
    expect(appendStreamingTextDelta(existing, delta)).toBe(`${existing}${LINE}`)
  })

  test("keeps a jammed repeat when the combined value is one unit over the limit, since only line repeats collapse there", () => {
    const existing = distinct(2049 - delta.length)
    expect(existing.length + delta.length).toBe(2049)
    expect(appendStreamingTextDelta(existing, delta)).toBe(`${existing}${delta}`)
  })

  test("rescans the whole value at the limit, but one unit past it keeps a repeated line that sits before the value's last two lines", () => {
    // The existing value was not built by streaming, so it still holds a line repeat.
    const head = `${LINE}\n${LINE}\n`
    const atLimit = `${head}${distinct(2048 - head.length - 1)}`
    expect(appendStreamingTextDelta(atLimit, "!")).toBe(`${LINE}\n${distinct(2048 - head.length - 1)}!`)
    const overLimit = `${head}${distinct(2049 - head.length - 1)}`
    expect(overLimit.length + 1).toBe(2049)
    expect(appendStreamingTextDelta(overLimit, "!")).toBe(`${overLimit}!`)
  })

  test("counts the limit in UTF-16 units, so astral text past it keeps a jammed repeat although it has fewer code points", () => {
    const atLimit = distinctAstral((2048 - delta.length) / 2)
    expect(atLimit.length + delta.length).toBe(2048)
    expect(appendStreamingTextDelta(atLimit, delta)).toBe(`${atLimit}${LINE}`)
    // 2,050 units but 1,065 code points.
    const overLimit = distinctAstral((2050 - delta.length) / 2)
    expect(overLimit.length + delta.length).toBe(2050)
    expect(Array.from(overLimit + delta).length).toBe(1065)
    expect(appendStreamingTextDelta(overLimit, delta)).toBe(`${overLimit}${delta}`)
  })
})

describe("appendStreamingTextDelta: the line window past the scan limit", () => {
  // Characterizes a branch with an equivalent alternative: starting the window at 0 or at 1
  // gives the same result, because the only extra record is an empty line, never a candidate.
  test("collapses a repeated line when the value's only line break is its first unit", () => {
    const existing = `\n${distinct(2100)}`
    const result = appendStreamingTextDelta(existing, `\n${LINE}\n${LINE}`)
    expect(result).toBe(`\n${distinct(2100)}\n${LINE}\n`)
  })

  test("collapses a repeated line that lies wholly inside the delta when the value has no line break, and the unterminated kept copy gains a line break", () => {
    const existing = distinct(2100)
    expect(appendStreamingTextDelta(existing, `\n${LINE}\n${LINE}`)).toBe(`${existing}\n${LINE}\n`)
  })

  test("with no line break in the value the window starts at its first unit, so a delta repeating the whole value as a new line collapses into one copy plus a line break", () => {
    const existing = distinct(2100)
    expect(appendStreamingTextDelta(existing, `\n${existing}`)).toBe(`${existing}\n`)
  })
})

describe("appendStreamingTextDelta: a line that begins with a copy of the line above", () => {
  // A model that restates a line and then extends it, for example a status line it repeats
  // before adding the result. 36 UTF-16 units: above the 32-unit floor.
  const status = "Checking the build output once more."
  const rest = " It passed, so the change is ready."

  test("loses the copy while streaming when a delta ends exactly where the copy ends: the user sees only the extension on the second line", () => {
    let streamed = ""
    for (const delta of [`${status}\n`, status, rest]) streamed = appendStreamingTextDelta(streamed, delta)
    expect(streamed).toBe(`${status}\n${rest}`)
  })

  test("keeps the copy when the same text arrives in one delta or is normalized as a whole, as a fetched part is", () => {
    const whole = `${status}\n${status}${rest}`
    expect(appendStreamingTextDelta("", whole)).toBe(whole)
    expect(collapseExactAdjacentTextRepeats(whole)).toBe(whole)
  })

  test("keeps the copy while streaming when the delta boundary falls inside the copy", () => {
    let streamed = ""
    for (const delta of [`${status}\n`, status.slice(0, 20), `${status.slice(20)}${rest}`]) streamed = appendStreamingTextDelta(streamed, delta)
    expect(streamed).toBe(`${status}\n${status}${rest}`)
  })
})

describe("collapseExactAdjacentTextRepeats: the 32-unit floor is measured after a Unicode trim", () => {
  const core = (length: number) => "abcdefghijklmnopqrstuvwxyz0123456789".slice(0, length)

  test("does not collapse a repeated line whose length reaches the floor only with no-break spaces", () => {
    // 33 units, 19 once no-break spaces are trimmed.
    const padded = `${core(19)}${"\u00a0".repeat(14)}`
    expect(padded.length).toBe(33)
    const value = `${padded}\n${padded}\n`
    expect(collapseExactAdjacentTextRepeats(value)).toBe(value)
  })

  test("does not collapse a repeated line whose length reaches the floor only with byte-order marks", () => {
    const padded = `${"\ufeff".repeat(14)}${core(19)}`
    const value = `${padded}\n${padded}\n`
    expect(collapseExactAdjacentTextRepeats(value)).toBe(value)
  })

  test("does not collapse a repeated line of 31 units between no-break spaces", () => {
    const padded = `\u00a0\u00a0${core(31)}\u00a0\u00a0`
    const value = `${padded}\n${padded}\n`
    expect(collapseExactAdjacentTextRepeats(value)).toBe(value)
  })

  test("collapses a repeated line of exactly 32 units between no-break spaces", () => {
    const padded = `\u00a0\u00a0${core(32)}\u00a0\u00a0`
    expect(collapseExactAdjacentTextRepeats(`${padded}\n${padded}\n`)).toBe(`${padded}\n`)
  })

  test("does not collapse a jammed repeat whose copies reach the floor only with ideographic spaces", () => {
    const unit = `${core(20)}${"\u3000".repeat(16)}`
    expect(unit.length).toBe(36)
    expect(collapseExactAdjacentTextRepeats(`${unit}${unit}`)).toBe(`${unit}${unit}`)
  })
})
