import { describe, expect, test } from "bun:test";
import type { DiscoveredSkill } from "@/stores/useSkillsStore";
import { getSkillRowBadgeKeys } from "./skillBadges";

const skill = (source: DiscoveredSkill["source"]): DiscoveredSkill => ({
  name: "brainstorming",
  path: "/tmp/.config/opencode/skills/toolkit/brainstorming/SKILL.md",
  scope: "user",
  source,
});

describe("getSkillRowBadgeKeys", () => {
  test("returns only source badges and omits scope badges", () => {
    expect(getSkillRowBadgeKeys(skill("opencode"))).toEqual(["settings.skills.sidebar.badge.opencode"]);
    expect(getSkillRowBadgeKeys(skill("agents"))).toEqual(["settings.skills.sidebar.badge.agents"]);
  });
});
