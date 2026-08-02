import { describe, expect, test } from "bun:test"
import {
  buildToolManifest,
  getToolPermissionAliases,
  normalizeToolIds,
  TOOL_PERMISSION_ALIAS_GROUPS,
} from "./manifest"

describe("tool permission manifest", () => {
  test("groups patch and fetch aliases used by harness diagnostics", () => {
    expect(getToolPermissionAliases("apply_patch")).toEqual(["edit", "write", "patch", "apply_patch"])
    expect(getToolPermissionAliases("webfetch")).toEqual(["webfetch"])

    const manifest = buildToolManifest({
      toolIds: ["apply_patch", "webfetch"],
      sourceRuntime: "web",
      directory: "/repo",
    })

    expect(manifest.aliases.apply_patch).toEqual(["edit", "write", "patch", "apply_patch"])
    expect(manifest.aliases.webfetch).toEqual(["webfetch"])
  })

  test("normalizes dynamic discovery without hiding unknown plugin tools", () => {
    expect(normalizeToolIds([
      "mcp__future_plugin__inspect",
      "read",
      "read",
      " read ",
      "invalid",
      "",
      "   ",
      42,
      null,
    ])).toEqual(["mcp__future_plugin__inspect", "read"])
  })

  test("keeps every supported permission family symmetric", () => {
    for (const aliases of TOOL_PERMISSION_ALIAS_GROUPS) {
      for (const alias of aliases) {
        expect(getToolPermissionAliases(alias)).toEqual(aliases)
      }
    }
    expect(getToolPermissionAliases("mcp__future_plugin__inspect")).toEqual(["mcp__future_plugin__inspect"])
  })

  test("deduplicates entries and normalizes empty directory attribution", () => {
    const manifest = buildToolManifest({
      toolIds: ["task", "task", "mcp__future_plugin__inspect"],
      sourceRuntime: "vscode",
      directory: "   ",
    })

    expect(manifest.tools.map((tool) => tool.id)).toEqual(["mcp__future_plugin__inspect", "task"])
    expect(manifest.tools.every((tool) => tool.directory === null)).toBe(true)
    expect(manifest.directory).toBeNull()
  })
})
