import { describe, expect, test } from "bun:test"
import {
  buildPlanCardRenderSegments,
  shouldStopAfterPlanCard,
  shouldSuppressPostPlanText,
} from "./planCardRender"

const structuredPlanBody = [
  "# Cursor Plan Card Fix",
  "",
  "## Context",
  "",
  "Cursor models omit the sentinel.",
  "",
  "## Implementation",
  "",
  "1. Add fallback detection.",
].join("\n")

describe("buildPlanCardRenderSegments", () => {
  test("renders a preamble-only group before the plan body starts", () => {
    const messagePlan = {
      preambleText: "intro\n",
      planText: structuredPlanBody,
      source: "structured" as const,
    }

    expect(buildPlanCardRenderSegments({
      groupText: "intro",
      groupStart: 0,
      groupEnd: 5,
      messagePlan,
      planCardRendered: false,
    })).toEqual({
      segments: [{ kind: "preserved-text", text: "intro" }],
      planCardRendered: false,
    })
  })

  test("renders the plan card once when a later group overlaps the plan body", () => {
    const messagePlan = {
      preambleText: "intro\n",
      planText: structuredPlanBody,
      source: "structured" as const,
    }

    expect(buildPlanCardRenderSegments({
      groupText: structuredPlanBody,
      groupStart: 6,
      groupEnd: 6 + structuredPlanBody.length,
      messagePlan,
      planCardRendered: false,
    })).toEqual({
      segments: [
        { kind: "plan-card" },
        { kind: "consumed-plan-text", text: structuredPlanBody },
      ],
      planCardRendered: true,
    })
  })

  test("suppresses a later group while it is still part of the rendered plan body", () => {
    const messagePlan = {
      preambleText: "",
      planText: `${structuredPlanBody}\nextra tail`,
      source: "structured" as const,
    }

    expect(buildPlanCardRenderSegments({
      groupText: "extra tail",
      groupStart: structuredPlanBody.length + 1,
      groupEnd: structuredPlanBody.length + 1 + "extra tail".length,
      messagePlan,
      planCardRendered: true,
    })).toEqual({
      segments: [{ kind: "consumed-plan-text", text: "extra tail" }],
      planCardRendered: true,
    })
  })

  test("preserves real postscript text after the detected plan body", () => {
    const messagePlan = {
      preambleText: "",
      planText: structuredPlanBody,
      source: "structured" as const,
    }

    expect(buildPlanCardRenderSegments({
      groupText: "postscript",
      groupStart: structuredPlanBody.length + 1,
      groupEnd: structuredPlanBody.length + 1 + "postscript".length,
      messagePlan,
      planCardRendered: true,
    })).toEqual({
      segments: [{ kind: "preserved-text", text: "postscript" }],
      planCardRendered: true,
    })
  })

  test("consumes post-plan text when plan-mode source suppression is enabled", () => {
    const messagePlan = {
      preambleText: "",
      planText: structuredPlanBody,
      source: "structured" as const,
    }

    expect(buildPlanCardRenderSegments({
      groupText: "tests pass.",
      groupStart: structuredPlanBody.length + 1,
      groupEnd: structuredPlanBody.length + 1 + "tests pass.".length,
      messagePlan,
      planCardRendered: true,
      suppressPostPlanText: true,
    })).toEqual({
      segments: [{ kind: "consumed-plan-text", text: "tests pass." }],
      planCardRendered: true,
    })
  })

  test("preserves text before and after a plan that starts mid-group", () => {
    const messagePlan = {
      preambleText: "intro\n",
      planText: structuredPlanBody,
      source: "structured" as const,
    }
    const groupText = `intro\n${structuredPlanBody}\npostscript`

    expect(buildPlanCardRenderSegments({
      groupText,
      groupStart: 0,
      groupEnd: groupText.length,
      messagePlan,
      planCardRendered: false,
    })).toEqual({
      segments: [
        { kind: "preserved-text", text: "intro\n" },
        { kind: "plan-card" },
        { kind: "consumed-plan-text", text: structuredPlanBody },
        { kind: "preserved-text", text: "\npostscript" },
      ],
      planCardRendered: true,
    })
  })

  test("consumes post-plan text inside the same group when suppression is enabled", () => {
    const messagePlan = {
      preambleText: "intro\n",
      planText: structuredPlanBody,
      source: "structured" as const,
    }
    const groupText = `intro\n${structuredPlanBody}\ntests pass.`

    expect(buildPlanCardRenderSegments({
      groupText,
      groupStart: 0,
      groupEnd: groupText.length,
      messagePlan,
      planCardRendered: false,
      suppressPostPlanText: true,
    })).toEqual({
      segments: [
        { kind: "preserved-text", text: "intro\n" },
        { kind: "plan-card" },
        { kind: "consumed-plan-text", text: structuredPlanBody },
        { kind: "consumed-plan-text", text: "\ntests pass." },
      ],
      planCardRendered: true,
    })
  })

  test("suppresses post-plan text for explicit sentinel-backed plans outside direct plan mode", () => {
    const messagePlan = {
      preambleText: "",
      planText: structuredPlanBody,
      source: "sentinel" as const,
    }

    expect(shouldSuppressPostPlanText(messagePlan, false)).toBe(true)
    expect(buildPlanCardRenderSegments({
      groupText: "on filename",
      groupStart: structuredPlanBody.length + 1,
      groupEnd: structuredPlanBody.length + 1 + "on filename".length,
      messagePlan,
      planCardRendered: true,
      suppressPostPlanText: shouldSuppressPostPlanText(messagePlan, false),
    })).toEqual({
      segments: [{ kind: "consumed-plan-text", text: "on filename" }],
      planCardRendered: true,
    })
  })

  test("preserves non-plan structured postscripts when suppression is not enabled", () => {
    const messagePlan = {
      preambleText: "",
      planText: structuredPlanBody,
      source: "structured" as const,
    }

    expect(shouldSuppressPostPlanText(messagePlan, false)).toBe(false)
    expect(shouldSuppressPostPlanText(messagePlan, true)).toBe(true)
  })

  test("makes a rendered plan card terminal for plan-mode and sentinel-backed responses", () => {
    const structuredPlan = {
      preambleText: "",
      planText: structuredPlanBody,
      source: "structured" as const,
    }
    const sentinelPlan = {
      ...structuredPlan,
      source: "sentinel" as const,
    }

    expect(shouldStopAfterPlanCard(structuredPlan, true, true)).toBe(true)
    expect(shouldStopAfterPlanCard(sentinelPlan, false, true)).toBe(true)
    expect(shouldStopAfterPlanCard(structuredPlan, true, false)).toBe(false)
    expect(shouldStopAfterPlanCard(structuredPlan, false, true)).toBe(false)
  })
})
