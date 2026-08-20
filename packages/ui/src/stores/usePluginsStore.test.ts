import { beforeEach, describe, expect, test } from "bun:test";
import { opencodeClient } from "@/lib/opencode/client";
import { usePluginsStore } from "./usePluginsStore";

const originalFetch = globalThis.fetch;

const pluginsResponse = () => Response.json({
  defaults: [
    {
      id: "devryan-default:opencode-antigravity-auth",
      pluginId: "opencode-antigravity-auth",
      displayName: "OpenCode Antigravity Auth",
      shippedSpec: "./node_modules/opencode-antigravity-auth/dist/index.js",
      effectiveSpec: "./node_modules/opencode-antigravity-auth/dist/index.js",
      version: "1.6.0",
      delivery: "installed-local",
      sourcePath: "default-config/user-profile/package.json",
      kind: "default",
    },
    {
      id: "devryan-default:@rama_nigg/open-cursor",
      pluginId: "@rama_nigg/open-cursor",
      displayName: "Open Cursor",
      shippedSpec: "./node_modules/@rama_nigg/open-cursor/dist/plugin-entry.js",
      effectiveSpec: "./node_modules/@rama_nigg/open-cursor/dist/plugin-entry.js",
      version: "2.5.4",
      delivery: "installed-local",
      sourcePath: "default-config/user-profile/package.json",
      kind: "default",
    },
    {
      id: "devryan-default:opencode-with-claude",
      pluginId: "opencode-with-claude",
      displayName: "OpenCode with Claude",
      shippedSpec: "./node_modules/opencode-with-claude/dist/index.js",
      effectiveSpec: "./node_modules/opencode-with-claude/dist/index.js",
      version: "1.8.0",
      delivery: "installed-local",
      sourcePath: "default-config/user-profile/package.json",
      kind: "default",
    },
    {
      id: "devryan-default:context-mode",
      pluginId: "context-mode",
      displayName: "Context Mode",
      shippedSpec: "./node_modules/context-mode/build/adapters/opencode/plugin.js",
      effectiveSpec: "./node_modules/context-mode/build/adapters/opencode/plugin.js",
      version: "1.0.169",
      delivery: "installed-local",
      sourcePath: "default-config/user-profile/package.json",
      kind: "default",
    },
    {
      id: "devryan-default:oh-my-opencode-slim",
      pluginId: "oh-my-opencode-slim",
      displayName: "Oh My OpenCode Slim",
      shippedSpec: "./plugins/devryan-oh-my-opencode-slim.mjs",
      effectiveSpec: "./plugins/devryan-oh-my-opencode-slim.mjs",
      version: "2.0.5",
      delivery: "installed-local",
      sourcePath: "default-config/user-profile/package.json",
      kind: "default",
    },
    {
      id: "devryan-default:superpowers",
      pluginId: "superpowers",
      displayName: "Superpowers",
      shippedSpec: "./plugins/devryan-superpowers.mjs",
      effectiveSpec: "./plugins/devryan-superpowers.mjs",
      version: null,
      delivery: "bundled-file",
      sourcePath: "default-config/plugins/devryan-superpowers.mjs",
      kind: "default",
    },
    {
      id: "devryan-default:openai-tool-schema-sanitizer",
      pluginId: "openai-tool-schema-sanitizer",
      displayName: "OpenAI Tool Schema Sanitizer",
      shippedSpec: "./plugins/openai-tool-schema-sanitizer.mjs",
      effectiveSpec: "./plugins/openai-tool-schema-sanitizer.mjs",
      version: null,
      delivery: "bundled-file",
      sourcePath: "default-config/plugins/openai-tool-schema-sanitizer.mjs",
      kind: "default",
    },
  ],
  entries: [
    {
      id: "config-user-plugin-one",
      spec: "plugin-one@1.0.0",
      scope: "user",
      kind: "config",
      parsedKind: "npm",
      sourcePath: "/tmp/home/.config/opencode/opencode.json",
    },
  ],
  files: [
    {
      id: "file-project-local-js",
      fileName: "local.js",
      scope: "project",
      kind: "file",
      absolutePath: "/tmp/project/.opencode/plugins/local.js",
    },
  ],
  errors: [],
});

describe("usePluginsStore", () => {
  beforeEach(() => {
    globalThis.fetch = originalFetch;
    opencodeClient.setDirectory(`/tmp/devryan-plugins-store-${Date.now()}-${Math.random()}`);
    usePluginsStore.setState({
      defaults: [],
      entries: [],
      files: [],
      errors: [],
      selectedId: null,
      isLoading: false,
      lastError: null,
      slimStatus: null,
      slimStatusLoading: false,
      slimActionInFlight: null,
      slimLastError: null,
    });
  });

  test("loadPlugins requests plugins for the current directory and preserves references when unchanged", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input) => {
      calls.push(String(input));
      return pluginsResponse();
    }) as typeof fetch;

    await usePluginsStore.getState().loadPlugins({ refresh: true });
    const firstEntries = usePluginsStore.getState().entries;
    const firstFiles = usePluginsStore.getState().files;
    const firstDefaults = usePluginsStore.getState().defaults;

    await usePluginsStore.getState().loadPlugins({ refresh: true });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("/api/config/plugins?");
    expect(decodeURIComponent(calls[0])).toContain("directory=/tmp/devryan-plugins-store-");
    expect(usePluginsStore.getState().entries).toBe(firstEntries);
    expect(usePluginsStore.getState().files).toBe(firstFiles);
    expect(usePluginsStore.getState().defaults).toBe(firstDefaults);
    expect(firstDefaults.map((plugin) => plugin.pluginId)).toEqual([
      "opencode-antigravity-auth",
      "@rama_nigg/open-cursor",
      "opencode-with-claude",
      "context-mode",
      "oh-my-opencode-slim",
      "superpowers",
      "openai-tool-schema-sanitizer",
    ]);
    expect(usePluginsStore.getState().getById("devryan-default:opencode-with-claude")?.kind).toBe("default");
  });

  test("loads Slim status and installs the managed runtime through explicit actions", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input, init) => {
      calls.push(`${init?.method ?? "GET"} ${String(input)}`);
      if (String(input).includes("/api/config/slim/status")) {
        return Response.json({
          installedVersion: null,
          runtimeEnabled: false,
          wrapperConfigured: false,
          packageDependencyInstalled: false,
          issues: [{ code: "slim-package-missing", message: "missing" }],
        });
      }
      if (String(input).includes("/api/config/slim/install")) {
        return Response.json({
          installedVersion: "2.0.5",
          runtimeEnabled: true,
          wrapperConfigured: true,
          packageDependencyInstalled: true,
          changedFiles: ["/tmp/home/.config/opencode/opencode.json"],
          backupPaths: ["/tmp/home/.config/opencode/opencode.json.devryan-slim-backup"],
          issues: [],
        });
      }
      return pluginsResponse();
    }) as typeof fetch;

    await usePluginsStore.getState().loadSlimStatus();
    expect(usePluginsStore.getState().slimStatus?.runtimeEnabled).toBe(false);
    expect(usePluginsStore.getState().slimStatus?.wrapperConfigured).toBe(false);

    const installed = await usePluginsStore.getState().installSlimRuntime();

    expect(installed).toBe(true);
    expect(calls).toContain("GET /api/config/slim/status");
    expect(calls).toContain("POST /api/config/slim/install");
    expect(usePluginsStore.getState().slimStatus?.installedVersion).toBe("2.0.5");
    expect(usePluginsStore.getState().slimStatus?.runtimeEnabled).toBe(true);
    expect(usePluginsStore.getState().slimStatus?.wrapperConfigured).toBe(true);
    expect(usePluginsStore.getState().slimActionInFlight).toBeNull();
  });

  test("store API keeps plugin config read-only while exposing Slim setup actions", () => {
    const keys = Object.keys(usePluginsStore.getState()).sort();

    expect(keys).toEqual([
      "defaults",
      "entries",
      "errors",
      "files",
      "getById",
      "installSlimRuntime",
      "isLoading",
      "lastError",
      "loadPlugins",
      "loadSlimStatus",
      "repairSlimRuntime",
      "selectedId",
      "setSelected",
      "slimActionInFlight",
      "slimLastError",
      "slimStatus",
      "slimStatusLoading",
    ]);
  });
});
