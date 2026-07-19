import { beforeEach, describe, expect, test } from "bun:test";
import { opencodeClient } from "@/lib/opencode/client";
import { useProjectsStore } from "./useProjectsStore";
import { useMcpConfigStore } from "./useMcpConfigStore";
import { useMcpStore } from "./useMcpStore";

const originalFetch = globalThis.fetch;

const mcpResponse = (name: string) => Response.json([
  {
    name,
    scope: "project",
    type: "local",
    command: ["echo", name],
    enabled: true,
  },
]);

describe("useMcpConfigStore", () => {
  beforeEach(() => {
    globalThis.fetch = originalFetch;
    opencodeClient.setDirectory(undefined);
    useProjectsStore.setState({ projects: [], activeProjectId: null });
    useMcpConfigStore.setState({
      mcpServers: [],
      selectedMcpName: null,
      isLoading: false,
      mcpDraft: null,
    });
    useMcpStore.setState({
      byDirectory: {},
      diagnosticsByDirectory: {},
      issueKindsByDirectory: {},
      loadingKeys: {},
      lastErrorKeys: {},
    });
  });

  test("loads MCP configs for the explicit directory instead of reusing the previous project", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input, init) => {
      calls.push(`${init?.method || "GET"} ${String(input)}`);
      return String(input).includes(encodeURIComponent("/repo/two"))
        ? mcpResponse("two-server")
        : mcpResponse("one-server");
    }) as typeof fetch;

    await useMcpConfigStore.getState().loadMcpConfigs({ force: true, directory: "/repo/one" });
    expect(useMcpConfigStore.getState().mcpServers.map((server) => server.name)).toEqual(["one-server"]);

    await useMcpConfigStore.getState().loadMcpConfigs({ force: true, directory: "/repo/two" });
    expect(useMcpConfigStore.getState().mcpServers.map((server) => server.name)).toEqual(["two-server"]);
    expect(calls).toEqual([
      `GET /api/config/mcp?directory=${encodeURIComponent("/repo/one")}`,
      `GET /api/config/mcp?directory=${encodeURIComponent("/repo/two")}`,
    ]);
  });

  test("clears the selected MCP when the loaded directory no longer contains it", async () => {
    useMcpConfigStore.setState({ selectedMcpName: "old-server" });
    globalThis.fetch = (async () => {
      return mcpResponse("new-server");
    }) as typeof fetch;

    await useMcpConfigStore.getState().loadMcpConfigs({ force: true, directory: "/repo/selection" });

    expect(useMcpConfigStore.getState().selectedMcpName).toBeNull();
  });

  test("does not run MCP recovery during forced config loads", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input, init) => {
      calls.push(`${init?.method || "GET"} ${String(input)}`);
      return mcpResponse("legacy-server");
    }) as typeof fetch;

    await useMcpConfigStore.getState().loadMcpConfigs({ force: true, directory: "/repo/recovery" });
    await useMcpConfigStore.getState().loadMcpConfigs({ force: true, directory: "/repo/recovery" });

    expect(calls).toEqual([
      `GET /api/config/mcp?directory=${encodeURIComponent("/repo/recovery")}`,
      `GET /api/config/mcp?directory=${encodeURIComponent("/repo/recovery")}`,
    ]);
  });

  test("updates MCP configs for the explicit directory", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input, init) => {
      calls.push(`${init?.method || "GET"} ${String(input)} ${String(init?.headers ? JSON.stringify(init.headers) : "")} ${String(init?.body ?? "")}`);
      return Response.json({ success: true, requiresReload: false });
    }) as typeof fetch;

    await useMcpConfigStore.getState().updateMcp(
      "linear",
      { enabled: true },
      { directory: "/repo/project" },
    );

    expect(calls).toEqual([
      `PATCH /api/config/mcp/linear?directory=${encodeURIComponent("/repo/project")} {"Content-Type":"application/json","x-opencode-directory":"/repo/project"} {"enabled":true}`,
      `GET /api/config/mcp?directory=${encodeURIComponent("/repo/project")} {"x-opencode-directory":"/repo/project"} `,
    ]);
  });

  test("clears only the deleted server's remembered issue after deletion succeeds", async () => {
    opencodeClient.setDirectory("/repo/delete");
    useMcpStore.setState({
      issueKindsByDirectory: {
        "/repo/delete": { linear: "failed", github: "needs_auth" },
        "/repo/other": { linear: "needs_client_registration" },
      },
    });
    globalThis.fetch = (async (_input, init) => {
      if (init?.method === "DELETE") {
        return Response.json({ success: true, requiresReload: false });
      }
      return Response.json([]);
    }) as typeof fetch;

    const result = await useMcpConfigStore.getState().deleteMcp("linear");

    expect(result.ok).toBe(true);
    expect(useMcpStore.getState().issueKindsByDirectory).toEqual({
      "/repo/delete": { github: "needs_auth" },
      "/repo/other": { linear: "needs_client_registration" },
    });
  });
});
