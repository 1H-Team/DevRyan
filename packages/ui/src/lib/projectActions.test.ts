import { describe, expect, test } from "bun:test";
import { DEVRYAN_AUTO_DISCOVER_ACTION_ID, type DevRyanProjectAction } from "./devryanConfig";
import { resolveProjectActionSelection } from "./projectActions";

const autoDiscoverAction: DevRyanProjectAction = {
  id: DEVRYAN_AUTO_DISCOVER_ACTION_ID,
  name: "Auto-discover",
  command: "",
};

const userAction: DevRyanProjectAction = {
  id: "run-dev",
  name: "Run Dev",
  command: "bun run dev",
};

describe("resolveProjectActionSelection", () => {
  test("defaults to the first user-created action when no primary action is saved", () => {
    expect(resolveProjectActionSelection({
      actions: [userAction],
      autoDiscoverAction,
      canUseAutoDiscover: true,
      selectedActionId: null,
    })).toBe(userAction);
  });

  test("defaults to Auto-discover when no user-created actions exist", () => {
    expect(resolveProjectActionSelection({
      actions: [],
      autoDiscoverAction,
      canUseAutoDiscover: true,
      selectedActionId: null,
    })).toBe(autoDiscoverAction);
  });

  test("preserves an explicit Auto-discover selection when user actions exist", () => {
    expect(resolveProjectActionSelection({
      actions: [userAction],
      autoDiscoverAction,
      canUseAutoDiscover: true,
      selectedActionId: DEVRYAN_AUTO_DISCOVER_ACTION_ID,
    })).toBe(autoDiscoverAction);
  });

  test("falls back to the first user-created action after a saved action is deleted", () => {
    expect(resolveProjectActionSelection({
      actions: [userAction],
      autoDiscoverAction,
      canUseAutoDiscover: true,
      selectedActionId: "deleted-action",
    })).toBe(userAction);
  });
});
