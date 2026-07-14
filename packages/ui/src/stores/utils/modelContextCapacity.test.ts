import { describe, expect, test } from "bun:test"
import { resolveModelContextCapacity } from "./modelContextCapacity"

describe("resolveModelContextCapacity", () => {
  test("prefers a positive input limit over context without reserving output", () => {
    expect(resolveModelContextCapacity({
      limit: { input: 272_000, context: 400_000, output: 128_000 },
    })).toEqual({
      capacityLimit: 272_000,
      capacityBasis: "input",
      inputLimit: 272_000,
      contextLimit: 400_000,
      outputLimit: 128_000,
    })
  })

  test("falls back to context when no valid input limit is present", () => {
    expect(resolveModelContextCapacity({ limit: { context: 1_000_000 } })).toEqual({
      capacityLimit: 1_000_000,
      capacityBasis: "context",
      inputLimit: null,
      contextLimit: 1_000_000,
      outputLimit: null,
    })
  })

  test("keeps invalid and absent limits explicitly unavailable", () => {
    expect(resolveModelContextCapacity({
      limit: { input: Number.NaN, context: -1, output: Number.POSITIVE_INFINITY },
    })).toEqual({
      capacityLimit: null,
      capacityBasis: "unavailable",
      inputLimit: null,
      contextLimit: null,
      outputLimit: null,
    })
    expect(resolveModelContextCapacity(undefined)).toEqual({
      capacityLimit: null,
      capacityBasis: "unavailable",
      inputLimit: null,
      contextLimit: null,
      outputLimit: null,
    })
  })

  test("uses selected variant limits while falling back to model fields", () => {
    expect(resolveModelContextCapacity({
      limit: { context: 1_000_000, output: 128_000 },
      variants: {
        fast: { limit: { context: 272_000 } },
      },
    }, "fast")).toEqual({
      capacityLimit: 272_000,
      capacityBasis: "context",
      inputLimit: null,
      contextLimit: 272_000,
      outputLimit: 128_000,
    })
  })
})
