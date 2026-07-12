import { describe, expect, test } from "bun:test"

import {
  deriveSessionTitleFromUserText,
  isCursorAcpErrorTitle,
  isGeneratedNewSessionTitle,
  resolveDisplaySessionTitle,
} from "./sessionTitles"

describe("session title helpers", () => {
  test("detects stale Cursor ACP error titles", () => {
    expect(isCursorAcpErrorTitle("cursor-acp error: b: Provider Error")).toBe(true)
    expect(isCursorAcpErrorTitle("Cursor-ACP Error: provider failed")).toBe(true)
    expect(isCursorAcpErrorTitle("normal Cursor session")).toBe(false)
  })

  test("derives compact titles from user text", () => {
    expect(deriveSessionTitleFromUserText("  find   the services page  ")).toBe("Find services page")
    expect(deriveSessionTitleFromUserText("")).toBe("Untitled Session")
    expect(deriveSessionTitleFromUserText("x".repeat(100))).toBe(`${"x".repeat(77)}...`)
  })

  test("prefers the first markdown heading for long implementation prompts", () => {
    expect(deriveSessionTitleFromUserText(
      "Implement this plan, and ensure everything works end to end with a live visual check\n# Patient/Provider Relationship Hub + Booking Prescriptions\n## Context\nLong implementation details",
    )).toBe("Patient/Provider Relationship Hub + Booking Prescriptions")
  })

  test("summarizes file-route edit prompts into concise titles", () => {
    expect(deriveSessionTitleFromUserText("in /dashboard/professional/calendar, remove the button to export pdf")).toBe(
      "Remove calendar export PDF button",
    )
    expect(deriveSessionTitleFromUserText('in /dashboard/professional/reviews, remove the "Open request form" button')).toBe(
      "Remove reviews Open request form button",
    )
  })

  test("summarizes route-scoped bug reports ending in fix this", () => {
    expect(deriveSessionTitleFromUserText(
      "in /dashboard/professional/services, it shows that I have 0 services when I have a profession, primary specialty, and subspecialty selected, which means i should have at least some default services and inherited services. Fix this",
    )).toBe("Fix services")
  })

  test("detects generated new-session timestamp titles", () => {
    expect(isGeneratedNewSessionTitle("New session - 2026-05-20T13:18:22.865Z")).toBe(true)
    expect(isGeneratedNewSessionTitle("New session - 2026-05-20T13:18:22Z")).toBe(true)
    expect(isGeneratedNewSessionTitle("New session - user supplied")).toBe(false)
    expect(isGeneratedNewSessionTitle("regular title")).toBe(false)
  })

  test("hides raw Cursor error titles behind a user-prompt fallback", () => {
    expect(resolveDisplaySessionTitle({
      title: "cursor-acp error: b: Provider Error",
      latestUserText: "make the services cards shorter",
      fallback: "Untitled Session",
    })).toBe("Make services cards shorter")
    expect(resolveDisplaySessionTitle({
      title: "regular title",
      latestUserText: "ignored prompt",
      fallback: "Untitled Session",
    })).toBe("regular title")
  })

  test("hides generated new-session titles behind a user-prompt fallback", () => {
    expect(resolveDisplaySessionTitle({
      title: "New session - 2026-05-20T13:18:22.865Z",
      latestUserText: "remove the export pdf button",
      fallback: "Untitled Session",
    })).toBe("Remove export PDF button")
  })

  test("renders old raw prompt titles using the smarter title form", () => {
    expect(resolveDisplaySessionTitle({
      title: "in /dashboard/professional/calendar, remove the button to export pdf",
      fallback: "Untitled Session",
    })).toBe("Remove calendar export PDF button")
  })
})
