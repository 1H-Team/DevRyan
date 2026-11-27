import { describe, expect, test } from "bun:test"
import { normalizeAssistantPartText } from "./part-delta"

// 40 characters: above the 32-character floor for a repeat to collapse.
const LINE = "The assistant wrote this sentence once. "
const LONG_LINE = "Indexed the workspace and found three files."
const WORKAROUND = "The edit tool is blocked, so I'll use Write and StrReplace to finish the change."
const BLOCKED = 'Tool "bash" has been temporarily blocked after 3 repeated validation failures. Do not retry this tool. Use a different approach to complete the task.'
const LOOP_GUARD = 'Tool loop guard stopped repeated schema-invalid calls to "edit" after 4 attempts (limit 3). Adjust tool arguments and retry.'

describe("normalizeAssistantPartText", () => {
  test("returns short and empty text unchanged for every part type", () => {
    for (const partType of [undefined, "text", "reasoning", "tool", ""]) {
      expect(normalizeAssistantPartText("", partType)).toBe("")
      expect(normalizeAssistantPartText("haha haha", partType)).toBe("haha haha")
      expect(normalizeAssistantPartText("  padded  ", partType)).toBe("  padded  ")
    }
  })

  test("collapses an adjacent repeated long line, keeping the second copy's line break, or the first's when the second has none", () => {
    const repeated = `${LONG_LINE}\n${LONG_LINE}`
    // The second copy has no line break, so the first copy's is used.
    expect(normalizeAssistantPartText(repeated, "text")).toBe(`${LONG_LINE}\n`)
    expect(normalizeAssistantPartText(repeated, "reasoning")).toBe(`${LONG_LINE}\n`)
    expect(normalizeAssistantPartText(repeated, undefined)).toBe(`${LONG_LINE}\n`)
    expect(normalizeAssistantPartText(`${repeated}\n`, "text")).toBe(`${LONG_LINE}\n`)
    // The second copy's line break wins over the first copy's.
    expect(normalizeAssistantPartText(`${LONG_LINE}\r\n${LONG_LINE}\n`, "text")).toBe(`${LONG_LINE}\n`)
    expect(normalizeAssistantPartText(`${LONG_LINE}\n${LONG_LINE}\r\nTail`, "text")).toBe(`${LONG_LINE}\r\nTail`)
    // With no second line break, a CRLF first copy keeps its CRLF.
    expect(normalizeAssistantPartText(`${LONG_LINE}\r\n${LONG_LINE}`, "text")).toBe(`${LONG_LINE}\r\n`)
  })

  test("compares lines after trimming them, and keeps the first copy's content", () => {
    expect(normalizeAssistantPartText(` ${LONG_LINE}\n${LONG_LINE}  \nTail`, "text")).toBe(` ${LONG_LINE}\nTail`)
  })

  test("measures the 32-unit floor after trimming, so a padded short line does not collapse", () => {
    // 35 units with padding, 15 without: below the floor once trimmed.
    const padded = "          abc def ghi jkl          "
    expect(normalizeAssistantPartText(`${padded}\n${padded}\n`, "text")).toBe(`${padded}\n${padded}\n`)
  })

  test("starts collapsing at exactly 64 UTF-16 units", () => {
    const block = "abcdefghijklmnopqrstuvwxyz012345"
    expect(block.length).toBe(32)
    expect(normalizeAssistantPartText(`${block}${block}`, "text")).toBe(block)
    const sixtyThree = `${block}${block.slice(0, 31)}`
    expect(normalizeAssistantPartText(sixtyThree, "text")).toBe(sixtyThree)
  })

  test("scans for jammed repeats up to exactly 2048 UTF-16 units", () => {
    // Distinct CJK characters (one unit each) hold no repeat of their own.
    const distinct = (count: number) => Array.from({ length: count }, (_, index) => String.fromCharCode(0x4e00 + index)).join("")
    const suffix = `\n${LINE}${LINE}`
    const atLimit = `${distinct(2048 - suffix.length)}${suffix}`
    expect(atLimit.length).toBe(2048)
    expect(normalizeAssistantPartText(atLimit, "text")).toBe(atLimit.slice(0, atLimit.length - LINE.length))
    const overLimit = `${distinct(2049 - suffix.length)}${suffix}`
    expect(overLimit.length).toBe(2049)
    expect(normalizeAssistantPartText(overLimit, "text")).toBe(overLimit)
  })

  test("measures the scan limit in UTF-16 units, not UTF-8 bytes", () => {
    // 1081 units, 2081 UTF-8 bytes: a byte count would be past the limit.
    const twoByte = Array.from({ length: 1000 }, (_, index) => String.fromCharCode(0x100 + index)).join("")
    const text = `${twoByte}\n${LINE}${LINE}`
    expect(text.length).toBe(1081)
    expect(normalizeAssistantPartText(text, "text")).toBe(`${twoByte}\n${LINE}`)
  })

  test("measures the floor in UTF-16 units, so surrogate pairs count twice", () => {
    // 17 emoji: 34 units but 17 code points, below 32 if code points were counted.
    const emoji = "\ud83d\ude00".repeat(17)
    expect(normalizeAssistantPartText(`${emoji}\n${emoji}`, "text")).toBe(`${emoji}\n`)
    // A lone surrogate and 16 pairs: 33 units, 17 code points.
    const lone = `\ud800${"\ud83d\ude00".repeat(16)}`
    expect(lone.length).toBe(33)
    expect(normalizeAssistantPartText(`${lone}\n${lone}`, "reasoning")).toBe(`${lone}\n`)
  })

  test("halves long runs of a single repeated character", () => {
    expect(normalizeAssistantPartText("-".repeat(63), "text")).toBe("-".repeat(63))
    expect(normalizeAssistantPartText("-".repeat(64), "text")).toBe("-".repeat(32))
    expect(normalizeAssistantPartText("-".repeat(65), "text")).toBe("-".repeat(33))
    expect(normalizeAssistantPartText("-".repeat(100), "text")).toBe("-".repeat(50))
    expect(normalizeAssistantPartText("-".repeat(128), "reasoning")).toBe("-".repeat(32))
    expect(normalizeAssistantPartText("-".repeat(200), "text")).toBe("-".repeat(50))
    const rule = `|${"-".repeat(70)}|`
    expect(normalizeAssistantPartText(`| a | b |\n${rule}\n| 1 | 2 |`, "text")).toBe(`| a | b |\n|${"-".repeat(35)}|\n| 1 | 2 |`)
  })

  test("collapses a jammed repeat without a line break", () => {
    expect(normalizeAssistantPartText(`${LINE}${LINE}`, "text")).toBe(LINE)
    expect(normalizeAssistantPartText(`${LINE}${LINE}`, "reasoning")).toBe(LINE)
  })

  test("keeps repeats in text shorter than twice the floor", () => {
    const short = "Short line here.\nShort line here.\n"
    expect(normalizeAssistantPartText(short, "text")).toBe(short)
  })

  test("collapses short repeated lines once a jammed block of them reaches the floor", () => {
    const short = "Short line here.\nShort line here.\nShort line here.\nShort line here.\n"
    expect(normalizeAssistantPartText(short, "text")).toBe("Short line here.\nShort line here.\n")
  })

  test("strips the edit-tool workaround line only from non-reasoning parts", () => {
    const text = `${WORKAROUND}\n\nAnswer here.`
    expect(normalizeAssistantPartText(text, "text")).toBe("Answer here.")
    expect(normalizeAssistantPartText(text, undefined)).toBe("Answer here.")
    expect(normalizeAssistantPartText(text, "tool")).toBe("Answer here.")
    expect(normalizeAssistantPartText(text, "reasoning")).toBe(text)
  })

  test("matches the reasoning part type case-sensitively", () => {
    const text = `${WORKAROUND}\n\nAnswer here.`
    expect(normalizeAssistantPartText(text, "Reasoning")).toBe("Answer here.")
    expect(normalizeAssistantPartText(text, " reasoning")).toBe("Answer here.")
    expect(normalizeAssistantPartText(text, "reasoning-summary")).toBe("Answer here.")
  })

  test("keeps a workaround sentence that is not a whole line", () => {
    const text = `Note: ${WORKAROUND}`
    expect(normalizeAssistantPartText(text, "text")).toBe(text)
  })

  test("strips the curly-apostrophe and continuation workaround lines", () => {
    const curly = "The `edit` tool is blocked, so I\u2019ll use `Write` and `StrReplace` to continue!"
    expect(normalizeAssistantPartText(`${curly}\nDone.`, "text")).toBe("Done.")
    expect(normalizeAssistantPartText("Continuing with Write and StrReplace since edit is blocked.", "text")).toBe("")
    expect(normalizeAssistantPartText("The edit tool is blocked, so I'll use Write and StrReplace to finish, okay?\nDone.", "text")).toBe("Done.")
  })

  test("strips diagnostics with multi-digit counts", () => {
    const blocked = BLOCKED.replace("after 3 repeated", "after 12 repeated")
    const guard = LOOP_GUARD.replace("after 4 attempts (limit 3)", "after 14 attempts (limit 10)")
    for (const partType of ["text", "reasoning"]) {
      expect(normalizeAssistantPartText(`Working on it.\n${blocked}`, partType)).toBe("Working on it.")
      expect(normalizeAssistantPartText(`Working on it.\n${guard}`, partType)).toBe("Working on it.")
    }
  })

  test("after stripping a diagnostic, folds three or more line breaks into two and drops trailing spaces and tabs", () => {
    expect(normalizeAssistantPartText(`Working on it.\n${LOOP_GUARD}\n\n\nNext.`, "text")).toBe("Working on it.\n\nNext.")
    expect(normalizeAssistantPartText(`Line one.  \nMore.\n${BLOCKED}`, "text")).toBe("Line one.\nMore.")
    expect(normalizeAssistantPartText(`Line one.\t \nMore.\n${BLOCKED}`, "reasoning")).toBe("Line one.\nMore.")
  })

  test("strips tool runner diagnostics from both part types", () => {
    for (const partType of ["text", "reasoning"]) {
      expect(normalizeAssistantPartText(`Working on it.\n${BLOCKED}`, partType)).toBe("Working on it.")
      expect(normalizeAssistantPartText(`Working on it.\n${LOOP_GUARD}\n\n\n\nNext.`, partType)).toBe("Working on it.\n\nNext.")
      expect(normalizeAssistantPartText('Start.\nSkipped malformed tool call "edit": bad args\nEnd.', partType)).toBe("Start.\nEnd.")
    }
  })

  test("collapses repeats before stripping diagnostics, so a repeat a diagnostic separated survives", () => {
    const text = `${LONG_LINE}\n${BLOCKED}\n${LONG_LINE}`
    expect(normalizeAssistantPartText(text, "text")).toBe(`${LONG_LINE}\n${LONG_LINE}`)
    expect(normalizeAssistantPartText(text, "reasoning")).toBe(`${LONG_LINE}\n${LONG_LINE}`)
  })

  test("strips diagnostics before workaround lines, so a workaround line a diagnostic followed is still removed", () => {
    expect(normalizeAssistantPartText(`${WORKAROUND} ${BLOCKED}\nDone.`, "text")).toBe("Done.")
    // The marker runs to the end of its line; once it is gone the line ends
    // with the workaround's full stop and matches the workaround pattern.
    expect(normalizeAssistantPartText(`${WORKAROUND}Skipped malformed tool call "edit": oops\n\nDone.`, "text")).toBe("Done.")
  })

  test("a malformed-call diagnostic also removes its line break, joining the next line to the text before it", () => {
    expect(normalizeAssistantPartText('Start. Skipped malformed tool call "x": bad\nEnd.', "text")).toBe("Start. End.")
    // A reasoning part keeps workaround lines, so the join itself is visible.
    expect(normalizeAssistantPartText(`${WORKAROUND}Skipped malformed tool call "edit": oops\nDone.`, "reasoning")).toBe(`${WORKAROUND}Done.`)
    // On a visible part the joined line still ends in a full stop, so the whole line, Done included, is removed.
    expect(normalizeAssistantPartText(`${WORKAROUND}Skipped malformed tool call "edit": oops\nDone.`, "text")).toBe("")
  })

  test("keeps CRLF separators of lines it keeps", () => {
    const text = `${LONG_LINE}\r\n${LONG_LINE}\r\nTail`
    expect(normalizeAssistantPartText(text, "text")).toBe(`${LONG_LINE}\r\nTail`)
  })

  test("compares repeats code unit by code unit, surrogate pairs and lone surrogates included", () => {
    const emoji = "Deployed \ud83d\ude80 to staging and checked every service once."
    expect(normalizeAssistantPartText(`${emoji}\n${emoji}`, "text")).toBe(`${emoji}\n`)
    const lone = `Broken \ud800 surrogate stays in this long enough line ok.`
    expect(normalizeAssistantPartText(`${lone}\n${lone}`, "reasoning")).toBe(`${lone}\n`)
    // A lone surrogate is not equal to a whole pair that starts with it.
    const pairLine = lone.replace("\ud800", "\ud800\udc00")
    expect(normalizeAssistantPartText(`${lone}\n${pairLine}`, "text")).toBe(`${lone}\n${pairLine}`)
  })

  test("does not collapse a jammed repeat in text longer than the scan limit, but still collapses line repeats", () => {
    const filler = "x".repeat(2_100)
    const jammed = `${filler}\n${LINE}${LINE}`
    expect(normalizeAssistantPartText(jammed, "text")).toBe(jammed)
    const lines = `${filler}\n${LONG_LINE}\n${LONG_LINE}`
    expect(normalizeAssistantPartText(lines, "text")).toBe(`${filler}\n${LONG_LINE}\n`)
  })
})
