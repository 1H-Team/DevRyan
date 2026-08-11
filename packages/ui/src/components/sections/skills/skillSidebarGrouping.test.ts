import { describe, expect, test } from "bun:test";
import type { DiscoveredSkill } from "@/stores/useSkillsStore";
import { filterSkillsForSidebar, groupSkillsForSidebar, sortSkillsForSidebar } from "./skillSidebarGrouping";

const skill = (
  name: string,
  path: string,
  options: Partial<Pick<DiscoveredSkill, "scope" | "source" | "group">> = {},
): DiscoveredSkill => ({
  name,
  path,
  scope: options.scope ?? "user",
  source: options.source ?? "opencode",
  group: options.group,
});

describe("groupSkillsForSidebar", () => {
  test("keeps flat skills directly under their location and nests parent-folder skills", () => {
    const grouped = groupSkillsForSidebar(
      [
        skill("theme-system", "/tmp/.config/opencode/skills/theme-system/SKILL.md"),
        skill("writing-plans", "/tmp/.config/opencode/skills/superpowers/writing-plans/SKILL.md", {
          group: "superpowers",
        }),
        skill("brainstorming", "/tmp/.config/opencode/skills/superpowers/brainstorming/SKILL.md", {
          group: "superpowers",
        }),
      ],
      (location) => `Location ${location}`,
    );

    expect(grouped).toEqual([
      {
        key: "user-opencode",
        label: "Location user-opencode",
        directSkills: [
          skill("theme-system", "/tmp/.config/opencode/skills/theme-system/SKILL.md"),
        ],
        folderGroups: [
          {
            key: "superpowers",
            label: "Superpowers",
            skills: [
              skill("brainstorming", "/tmp/.config/opencode/skills/superpowers/brainstorming/SKILL.md", {
                group: "superpowers",
              }),
              skill("writing-plans", "/tmp/.config/opencode/skills/superpowers/writing-plans/SKILL.md", {
                group: "superpowers",
              }),
            ],
          },
        ],
        count: 3,
      },
    ]);
  });

  test("keeps same folder names isolated by location and sorts groups deterministically", () => {
    const grouped = groupSkillsForSidebar(
      [
        skill("zeta", "/project/.opencode/skills/superpowers/zeta/SKILL.md", {
          scope: "project",
          group: "superpowers",
        }),
        skill("alpha", "/user/.agents/skills/superpowers/alpha/SKILL.md", {
          source: "agents",
          group: "superpowers",
        }),
      ],
      (location) => `Location ${location}`,
    );

    expect(grouped.map((group) => ({
      key: group.key,
      folderKeys: group.folderGroups.map((folder) => folder.key),
      skillNames: group.folderGroups.flatMap((folder) => folder.skills.map((item) => item.name)),
    }))).toEqual([
      {
        key: "project-opencode",
        folderKeys: ["superpowers"],
        skillNames: ["zeta"],
      },
      {
        key: "user-agents",
        folderKeys: ["superpowers"],
        skillNames: ["alpha"],
      },
    ]);
  });
});

describe("filterSkillsForSidebar", () => {
  const skills: DiscoveredSkill[] = [
    { ...skill("cloudflare-workers", "/user/skills/cloudflare/cloudflare-workers/SKILL.md", { group: "cloudflare" }), description: "Deploy edge functions" },
    { ...skill("supabase", "/user/skills/supabase/supabase/SKILL.md", { group: "supabase" }), description: "Postgres backend" },
    skill("agent-browser", "/user/skills/agent-browser/SKILL.md"),
  ];

  test("returns every skill for a blank query", () => {
    expect(filterSkillsForSidebar(skills, "   ")).toEqual(skills);
  });

  test("matches on name, description and folder group, case-insensitively", () => {
    expect(filterSkillsForSidebar(skills, "WORKERS").map((s) => s.name)).toEqual(["cloudflare-workers"]);
    expect(filterSkillsForSidebar(skills, "postgres").map((s) => s.name)).toEqual(["supabase"]);
    expect(filterSkillsForSidebar(skills, "cloudflare").map((s) => s.name)).toEqual(["cloudflare-workers"]);
  });

  test("requires every whitespace-separated term to match", () => {
    expect(filterSkillsForSidebar(skills, "cloudflare edge").map((s) => s.name)).toEqual(["cloudflare-workers"]);
    expect(filterSkillsForSidebar(skills, "cloudflare postgres")).toEqual([]);
  });
});

describe("sortSkillsForSidebar", () => {
  test("sorts by name without mutating the input", () => {
    const input = [skill("zeta", "/z/SKILL.md"), skill("alpha", "/a/SKILL.md")];
    expect(sortSkillsForSidebar(input).map((s) => s.name)).toEqual(["alpha", "zeta"]);
    expect(input.map((s) => s.name)).toEqual(["zeta", "alpha"]);
  });
});
