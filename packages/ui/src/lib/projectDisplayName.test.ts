import { describe, expect, test } from "bun:test"
import { getExactProjectBasename, resolveProjectDisplayName } from "./projectDisplayName"

describe("exact project display names", () => {
  for (const name of [".ssh", "my_API-v2", "iOSClient", "foo__bar"]) {
    test(`preserves ${name}`, () => {
      expect(getExactProjectBasename(`/workspace/${name}`)).toBe(name)
      expect(resolveProjectDisplayName({ path: `/workspace/${name}` })).toBe(name)
    })
  }

  test("preserves manual labels and the filesystem root fallback", () => {
    expect(resolveProjectDisplayName({ path: "/workspace/foo__bar", label: "Manual_NAME-v2" })).toBe("Manual_NAME-v2")
    expect(resolveProjectDisplayName({ path: "/" })).toBe("Root")
  })
})
