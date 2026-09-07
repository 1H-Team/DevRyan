import { describe, expect, test } from "bun:test"

import {
  deriveSessionTitleFromUserText,
  isCursorAcpErrorTitle,
  isGeneratedNewSessionTitle,
  isPlanControlSessionTitle,
  mergeSessionPreservingMeaningfulTitle,
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

  test("detects standalone plan control titles without matching ordinary plan titles", () => {
    expect(isPlanControlSessionTitle("<!--plan-->")).toBe(true)
    expect(isPlanControlSessionTitle("<-----plan------>")).toBe(true)
    expect(isPlanControlSessionTitle("<!-- plan -->")).toBe(true)
    expect(isPlanControlSessionTitle("Review plan rendering")).toBe(false)
    expect(isPlanControlSessionTitle("<plan>")).toBe(false)
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

  test("keeps generated new-session titles neutral while the backend generates a title", () => {
    expect(resolveDisplaySessionTitle({
      title: "New session - 2026-05-20T13:18:22.865Z",
      latestUserText: "remove the export pdf button",
      fallback: "Untitled Session",
    })).toBe("Untitled Session")
  })

  test("hides plan control titles behind the requested fallback", () => {
    expect(resolveDisplaySessionTitle({
      title: "<!--plan-->",
      fallback: "Untitled Session",
    })).toBe("Untitled Session")
    expect(resolveDisplaySessionTitle({
      title: "<-----plan------>",
      fallback: "New session",
    })).toBe("New session")
  })

  test("renders old raw prompt titles using the smarter title form", () => {
    expect(resolveDisplaySessionTitle({
      title: "in /dashboard/professional/calendar, remove the button to export pdf",
      fallback: "Untitled Session",
    })).toBe("Remove calendar export PDF button")
  })

  test("collapses adjacent duplicate words in provider-created session titles", () => {
    expect(resolveDisplaySessionTitle({
      title: "Review Review Privacy",
      fallback: "Untitled Session",
    })).toBe("Review Privacy")
  })

  test("does not expose user text when the stored title is the untitled placeholder", () => {
    expect(resolveDisplaySessionTitle({
      title: "Untitled Session",
      latestUserText: "fix the login bug",
      fallback: "Untitled Session",
    })).toBe("Untitled Session")
    expect(resolveDisplaySessionTitle({
      title: "untitled session",
      latestUserText: "fix the login bug",
      fallback: "Untitled Session",
    })).toBe("Untitled Session")
  })

  test("keeps the fallback for the untitled placeholder when no user text is loaded", () => {
    expect(resolveDisplaySessionTitle({
      title: "Untitled Session",
      fallback: "Untitled Session",
    })).toBe("Untitled Session")
  })

  test("preserves a meaningful projected title across later placeholder snapshots", () => {
    const projected = { id: "ses_1", title: "Repair Parent Session Titles", updated: 1 }
    expect(mergeSessionPreservingMeaningfulTitle(projected, {
      id: "ses_1",
      title: "New session - 2026-08-23T21:14:18.802Z",
      updated: 2,
    })).toEqual({
      id: "ses_1",
      title: "Repair Parent Session Titles",
      updated: 2,
    })

    expect(mergeSessionPreservingMeaningfulTitle(projected, {
      id: "ses_1",
      title: "My Manual Session Name",
      updated: 3,
    }).title).toBe("My Manual Session Name")
  })

  test("preserves summarized managed child titles across stale events and later placeholder snapshots", () => {
    for (const agent of ['explorer', 'designer']) {
      const projected = { id: 'child', parentID: 'root', agent, title: 'Profile Reviews and Navigation', updated: 1 }
      const placeholder = { ...projected, title: `Managed ${agent} task`, updated: 2 }
      expect(mergeSessionPreservingMeaningfulTitle(projected, placeholder)).toEqual({ ...placeholder, title: projected.title })
      expect(mergeSessionPreservingMeaningfulTitle(placeholder, projected)).toBe(projected)
      const custom = { ...placeholder, title: 'My Custom Child Name' }
      expect(mergeSessionPreservingMeaningfulTitle(projected, custom)).toBe(custom)
      const root = { ...placeholder, parentID: '' }
      expect(mergeSessionPreservingMeaningfulTitle(projected, root)).toBe(root)
    }
  })
})
