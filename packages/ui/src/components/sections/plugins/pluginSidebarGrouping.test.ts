import { describe, expect, test } from "bun:test";
import type { DevRyanDefaultPlugin, PluginEntry, PluginFile } from "@/lib/api/types";
import { groupPluginsForSidebar } from "./pluginSidebarGrouping";

const entry = (spec: string, scope: "user" | "project"): PluginEntry => ({
  id: `entry-${scope}-${spec}`,
  spec,
  scope,
  kind: "config",
  parsedKind: spec.startsWith(".") ? "path" : "npm",
  sourcePath: `/tmp/${scope}/opencode.json`,
});

const file = (fileName: string, scope: "user" | "project"): PluginFile => ({
  id: `file-${scope}-${fileName}`,
  fileName,
  scope,
  kind: "file",
  absolutePath: `/tmp/${scope}/plugins/${fileName}`,
});

const defaults: DevRyanDefaultPlugin[] = [
  {
    id: "devryan-default:oh-my-opencode-slim",
    pluginId: "oh-my-opencode-slim",
    displayName: "Oh My OpenCode Slim",
    shippedSpec: "oh-my-opencode-slim@2.0.5",
    effectiveSpec: "./plugins/devryan-oh-my-opencode-slim.mjs",
    version: "2.0.5",
    delivery: "npm",
    sourcePath: "default-config/user-profile/package.json",
    kind: "default",
  },
];

describe("groupPluginsForSidebar", () => {
  test("groups entries and files by scope and type in deterministic order", () => {
    const grouped = groupPluginsForSidebar({
      defaults,
      entries: [
        entry("zeta-plugin", "user"),
        entry("@scope/alpha@1.0.0", "project"),
      ],
      files: [
        file("local.ts", "project"),
        file("global.js", "user"),
      ],
    });

    expect(grouped.map((group) => ({
      key: group.key,
      items: group.items.map((item) => item.label),
    }))).toEqual([
      {
        key: "devryan-defaults",
        items: ["Oh My OpenCode Slim"],
      },
      {
        key: "project-entries",
        items: ["@scope/alpha@1.0.0"],
      },
      {
        key: "project-files",
        items: ["local.ts"],
      },
      {
        key: "user-entries",
        items: ["zeta-plugin"],
      },
      {
        key: "user-files",
        items: ["global.js"],
      },
    ]);
  });

  test("folds annotated config entries and files into the default group", () => {
    expect(groupPluginsForSidebar({
      defaults,
      entries: [{ ...entry("opencode-with-claude@1.6.17", "user"), defaultPluginId: "opencode-with-claude" }],
      files: [{ ...file("devryan-oh-my-opencode-slim.mjs", "user"), defaultPluginId: "oh-my-opencode-slim" }],
    }).map((group) => group.key)).toEqual(["devryan-defaults"]);
  });

  test("returns no groups for empty plugin data", () => {
    expect(groupPluginsForSidebar({ defaults: [], entries: [], files: [] })).toEqual([]);
  });
});
