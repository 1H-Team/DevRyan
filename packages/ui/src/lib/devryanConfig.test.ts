import { describe, expect, test } from "bun:test";
import {
  getProjectActionsState,
  DEVRYAN_AUTO_DISCOVER_ACTION_ID,
  saveProjectActionsState,
  type DevRyanProjectAction,
  type ProjectRef,
} from "./devryanConfig";

const project: ProjectRef = { id: "project", path: "/repo" };
const action: DevRyanProjectAction = {
  id: "run-dev",
  name: "Run Dev",
  command: "bun run dev",
};

const withMockProjectConfig = async (
  initialConfig: Record<string, unknown>,
  callback: () => Promise<void>,
) => {
  const previousFetch = globalThis.fetch;
  const previousWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  const files = new Map<string, string>();
  let configPath: string | null = null;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/fs/home")) {
      return new Response(JSON.stringify({ home: "/home/tester" }), { status: 200 });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      __DEVRYAN_RUNTIME_APIS__: {
        files: {
          createDirectory: async () => ({ success: true }),
          readFile: async (path: string) => {
            configPath ??= path;
            const content = files.get(path);
            if (content === undefined && path.includes("/.openchamber/")) {
              throw new Error("missing legacy config");
            }
            return { content: content ?? JSON.stringify(initialConfig) };
          },
          writeFile: async (path: string, content: string) => {
            configPath = path;
            files.set(path, content);
            return { success: true };
          },
        },
      },
    },
  });

  try {
    await callback();
    expect(configPath).not.toBeNull();
  } finally {
    globalThis.fetch = previousFetch;
    if (previousWindowDescriptor) {
      Object.defineProperty(globalThis, "window", previousWindowDescriptor);
    } else {
      delete (globalThis as { window?: Window }).window;
    }
  }
};

describe("project actions config", () => {
  test("keeps a valid user action primary ID", async () => {
    await withMockProjectConfig({
      projectActions: [action],
      projectActionsPrimaryId: action.id,
    }, async () => {
      const state = await getProjectActionsState(project);
      expect(state.primaryActionId).toBe(action.id);
    });
  });

  test("keeps explicit Auto-discover as the primary ID", async () => {
    await withMockProjectConfig({
      projectActions: [action],
      projectActionsPrimaryId: DEVRYAN_AUTO_DISCOVER_ACTION_ID,
    }, async () => {
      const state = await getProjectActionsState(project);
      expect(state.primaryActionId).toBe(DEVRYAN_AUTO_DISCOVER_ACTION_ID);
    });
  });

  test('reads the old Auto-discover selection as the canonical ID', async () => {
    await withMockProjectConfig({ projectActionsPrimaryId: '__openchamber_auto_discover_preview__' }, async () => {
      const state = await getProjectActionsState(project);
      expect(state.primaryActionId).toBe(DEVRYAN_AUTO_DISCOVER_ACTION_ID);
    });
  });

  test("rejects unknown primary IDs", async () => {
    await withMockProjectConfig({
      projectActions: [action],
      projectActionsPrimaryId: "deleted-action",
    }, async () => {
      const state = await getProjectActionsState(project);
      expect(state.primaryActionId).toBeNull();
    });
  });

  test("persists explicit Auto-discover selections", async () => {
    await withMockProjectConfig({}, async () => {
      await saveProjectActionsState(project, {
        actions: [action],
        primaryActionId: DEVRYAN_AUTO_DISCOVER_ACTION_ID,
      });
      const state = await getProjectActionsState(project);
      expect(state.primaryActionId).toBe(DEVRYAN_AUTO_DISCOVER_ACTION_ID);
    });
  });
});
