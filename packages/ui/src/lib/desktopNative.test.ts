import { describe, expect, mock, test } from "bun:test";

let webviewWindowImportCount = 0;

mock.module("@tauri-apps/api/webviewWindow", () => {
  webviewWindowImportCount += 1;
  throw new Error("Tauri webviewWindow should not be imported for Electron");
});

const originalWindow = globalThis.window;

const setWindow = (value: unknown) => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value,
  });
};

describe("listenDesktopNativeDragDrop", () => {
  test("does not import Tauri webview APIs when Electron exposes the Tauri compatibility shim", async () => {
    const { listenDesktopNativeDragDrop } = await import("./desktopNative");
    setWindow({
      __DEVRYAN_ELECTRON__: { runtime: "electron" },
      __TAURI__: {
        core: {
          invoke: async () => null,
        },
      },
    });

    try {
      const unlisten = await listenDesktopNativeDragDrop(() => {});

      expect(unlisten).toBeNull();
      expect(webviewWindowImportCount).toBe(0);
    } finally {
      webviewWindowImportCount = 0;
      setWindow(originalWindow);
    }
  });
});
