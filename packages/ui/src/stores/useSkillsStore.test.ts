import { beforeEach, describe, expect, test } from "bun:test";
import { opencodeClient } from "@/lib/opencode/client";
import { getSkillIdentity, useSkillsStore } from "./useSkillsStore";

const originalFetch = globalThis.fetch;
const originalCheckHealth = opencodeClient.checkHealth.bind(opencodeClient);

const skillResponse = (name: string) => Response.json({
  skills: [
    {
      name,
      path: `/tmp/${name}/SKILL.md`,
      scope: "user",
      source: "opencode",
      sources: {
        md: {
          description: `${name} description`,
        },
      },
    },
  ],
});

const multiScopeSkillResponse = Response.json({
  skills: [
    {
      name: "lint-helper",
      path: "/tmp/user/.agents/skills/lint-helper/SKILL.md",
      scope: "user",
      source: "agents",
      sources: {
        md: {
          description: "User agents helper",
        },
      },
    },
    {
      name: "lint-helper",
      path: "/tmp/project/.opencode/skills/lint-helper/SKILL.md",
      scope: "project",
      source: "opencode",
      sources: {
        md: {
          description: "Project OpenCode helper",
        },
      },
    },
  ],
});

describe("useSkillsStore", () => {
  beforeEach(() => {
    globalThis.fetch = originalFetch;
    opencodeClient.checkHealth = originalCheckHealth;
    opencodeClient.setDirectory(`/tmp/devryan-skills-store-${Date.now()}-${Math.random()}`);
    useSkillsStore.setState({
      selectedSkillName: null,
      selectedSkillIdentity: null,
      skills: [],
      isLoading: false,
      skillDraft: null,
    });
  });

  test("loadSkills refresh bypasses the short cache", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async () => {
      const nextName = calls.length === 0 ? "first-skill" : "second-skill";
      calls.push(nextName);
      return skillResponse(nextName);
    }) as typeof fetch;

    await useSkillsStore.getState().loadSkills();
    expect(useSkillsStore.getState().skills.map((skill) => skill.name)).toEqual(["first-skill"]);

    await useSkillsStore.getState().loadSkills();
    expect(calls).toEqual(["first-skill"]);
    expect(useSkillsStore.getState().skills.map((skill) => skill.name)).toEqual(["first-skill"]);

    await useSkillsStore.getState().loadSkills({ refresh: true });
    expect(calls).toEqual(["first-skill", "second-skill"]);
    expect(useSkillsStore.getState().skills.map((skill) => skill.name)).toEqual(["second-skill"]);
  });

  test("loadSkills refresh preserves skill references when data is unchanged", async () => {
    globalThis.fetch = (async () => skillResponse("same-skill")) as typeof fetch;

    await useSkillsStore.getState().loadSkills({ refresh: true });
    const firstSkills = useSkillsStore.getState().skills;
    let skillReferenceChanges = 0;
    const unsubscribe = useSkillsStore.subscribe((state, previousState) => {
      if (state.skills !== previousState.skills) {
        skillReferenceChanges += 1;
      }
    });

    await useSkillsStore.getState().loadSkills({ refresh: true });
    unsubscribe();

    expect(useSkillsStore.getState().skills).toBe(firstSkills);
    expect(skillReferenceChanges).toBe(0);
  });

  test("loadSkills requests all active skills without forcing user scope", async () => {
    const fetchCalls: string[] = [];
    globalThis.fetch = (async (input) => {
      fetchCalls.push(String(input));
      return multiScopeSkillResponse.clone();
    }) as typeof fetch;

    await useSkillsStore.getState().loadSkills({ refresh: true });

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]).not.toContain("scope=user");
    expect(useSkillsStore.getState().skills.map((skill) => `${skill.scope}/${skill.source}/${skill.path}`)).toEqual([
      "user/agents//tmp/user/.agents/skills/lint-helper/SKILL.md",
      "project/opencode//tmp/project/.opencode/skills/lint-helper/SKILL.md",
    ]);
  });

  test("loadSkills derives parent folder groups from nested skill paths", async () => {
    globalThis.fetch = (async () => Response.json({
      skills: [
        {
          name: "brainstorming",
          path: "/Users/test/.config/opencode/skills/superpowers/brainstorming/SKILL.md",
          scope: "user",
          source: "opencode",
          description: "Brainstorming",
        },
        {
          name: "theme-system",
          path: "/Users/test/.config/opencode/skills/theme-system/SKILL.md",
          scope: "user",
          source: "opencode",
          description: "Theme system",
        },
      ],
    })) as typeof fetch;

    await useSkillsStore.getState().loadSkills({ refresh: true });

    expect(useSkillsStore.getState().skills.map((item) => `${item.name}:${item.group ?? "flat"}`)).toEqual([
      "brainstorming:superpowers",
      "theme-system:flat",
    ]);
  });

  test("loadSkills removes duplicate entries with the same path", async () => {
    globalThis.fetch = (async () => Response.json({
      skills: [
        {
          name: "lint-helper",
          path: "/tmp/user/.agents/skills/lint-helper/SKILL.md",
          scope: "user",
          source: "agents",
          description: "First copy",
        },
        {
          name: "lint-helper",
          path: "/tmp/user/.agents/skills/lint-helper/SKILL.md",
          scope: "user",
          source: "agents",
          description: "Duplicate copy",
        },
        {
          name: "lint-helper",
          path: "/tmp/project/.opencode/skills/lint-helper/SKILL.md",
          scope: "project",
          source: "opencode",
          description: "Project copy",
        },
      ],
    })) as typeof fetch;

    await useSkillsStore.getState().loadSkills({ refresh: true });

    expect(useSkillsStore.getState().skills.map((skill) => `${skill.description}:${skill.path}`)).toEqual([
      "First copy:/tmp/user/.agents/skills/lint-helper/SKILL.md",
      "Project copy:/tmp/project/.opencode/skills/lint-helper/SKILL.md",
    ]);
  });

  test("loadSkills hides package cache skills", async () => {
    globalThis.fetch = (async () => Response.json({
      skills: [
        {
          name: "dispatching-parallel-agents",
          path: "/Users/test/.config/opencode/skills/superpowers/dispatching-parallel-agents/SKILL.md",
          scope: "user",
          source: "opencode",
          description: "Installed copy",
        },
        {
          name: "dispatching-parallel-agents",
          path: "/Users/test/.cache/opencode/packages/superpowers/node_modules/superpowers/skills/dispatching-parallel-agents/SKILL.md",
          scope: "user",
          source: "opencode",
          description: "Package cache copy",
        },
        {
          name: "cache-only",
          path: "/Users/test/.cache/opencode/packages/example/skills/cache-only/SKILL.md",
          scope: "user",
          source: "opencode",
          description: "Cache-only copy",
        },
      ],
    })) as typeof fetch;

    await useSkillsStore.getState().loadSkills({ refresh: true });

    expect(useSkillsStore.getState().skills.map((skill) => `${skill.name}:${skill.description}`)).toEqual([
      "dispatching-parallel-agents:Installed copy",
    ]);
  });

  test("selected same-name skills use path identity for detail and supporting file requests", async () => {
    const fetchCalls: string[] = [];
    globalThis.fetch = (async (input) => {
      fetchCalls.push(String(input));
      return Response.json({
        name: "lint-helper",
        sources: {
          md: {
            exists: true,
            path: "/tmp/project/.opencode/skills/lint-helper/SKILL.md",
            dir: "/tmp/project/.opencode/skills/lint-helper",
            fields: [],
            supportingFiles: [],
          },
        },
      });
    }) as typeof fetch;

    const projectSkill = {
      name: "lint-helper",
      path: "/tmp/project/.opencode/skills/lint-helper/SKILL.md",
      scope: "project" as const,
      source: "opencode" as const,
    };
    useSkillsStore.setState({
      selectedSkillName: "lint-helper",
      selectedSkillIdentity: "stale",
      skills: [
        {
          name: "lint-helper",
          path: "/tmp/user/.agents/skills/lint-helper/SKILL.md",
          scope: "user",
          source: "agents",
        },
        projectSkill,
      ],
    });

    useSkillsStore.getState().setSelectedSkill(projectSkill);
    await useSkillsStore.getState().getSkillDetail("lint-helper");
    await useSkillsStore.getState().writeSupportingFile("lint-helper", "notes.md", "content");

    expect(fetchCalls[0]).toContain("scope=project");
    expect(fetchCalls[0]).toContain(`path=${encodeURIComponent(projectSkill.path)}`);
    expect(fetchCalls[1]).toContain("scope=project");
    expect(fetchCalls[1]).toContain(`path=${encodeURIComponent(projectSkill.path)}`);
  });

  test("deleteSkill removes the exact selected identity without waiting for runtime health or reconciliation", async () => {
    const fetchCalls: string[] = [];
    const reconciliation = new Promise<Response>(() => {});
    globalThis.fetch = (async (input, init) => {
      fetchCalls.push(`${init?.method || "GET"} ${String(input)}`);
      if (init?.method === "DELETE") {
        return Response.json({
          success: true,
          requiresReload: false,
          runtimeRefreshPending: true,
          runtimeApplied: false,
        });
      }
      return reconciliation;
    }) as typeof fetch;
    let healthChecks = 0;
    opencodeClient.checkHealth = (async () => {
      healthChecks += 1;
      return true;
    }) as typeof opencodeClient.checkHealth;

    const selectedSkill = {
      name: "lint-helper",
      path: "/tmp/project/.opencode/skills/lint-helper/SKILL.md",
      scope: "project" as const,
      source: "opencode" as const,
    };
    const sameNameUserSkill = {
      name: "lint-helper",
      path: "/tmp/user/.agents/skills/lint-helper/SKILL.md",
      scope: "user" as const,
      source: "agents" as const,
    };
    useSkillsStore.setState({
      selectedSkillName: "lint-helper",
      selectedSkillIdentity: getSkillIdentity(selectedSkill),
      skills: [sameNameUserSkill, selectedSkill],
    });

    const removed = await useSkillsStore.getState().deleteSkill(selectedSkill);

    expect(removed).toBe(true);
    expect(useSkillsStore.getState().selectedSkillName).toBe(null);
    expect(useSkillsStore.getState().skills).toEqual([sameNameUserSkill]);
    expect(healthChecks).toBe(0);
    const deleteCall = fetchCalls.find((call) => call.startsWith("DELETE /api/config/skills/lint-helper"));
    expect(deleteCall).toContain("scope=project");
    expect(deleteCall).toContain(`path=${encodeURIComponent(selectedSkill.path)}`);
  });

  test("hideSkill posts the exact selected skill identity and clears it after reload", async () => {
    const fetchCalls: string[] = [];
    globalThis.fetch = (async (input, init) => {
      fetchCalls.push(`${init?.method || "GET"} ${String(input)}`);
      if (init?.method === "POST") {
        return Response.json({ success: true, requiresReload: true, reloadDelayMs: 0 });
      }
      return Response.json({ skills: [] });
    }) as typeof fetch;
    opencodeClient.checkHealth = (async () => true) as typeof opencodeClient.checkHealth;

    const selectedSkill = {
      name: "lint-helper",
      path: "/tmp/user/.agents/skills/lint-helper/SKILL.md",
      scope: "user" as const,
      source: "agents" as const,
    };
    useSkillsStore.setState({
      selectedSkillName: selectedSkill.name,
      selectedSkillIdentity: getSkillIdentity(selectedSkill),
      skills: [selectedSkill],
    });

    const hidden = await useSkillsStore.getState().hideSkill(selectedSkill);

    expect(hidden).toBe(true);
    expect(useSkillsStore.getState().selectedSkillName).toBe(null);
    const hideCall = fetchCalls.find((call) => call.startsWith("POST /api/config/skills/lint-helper/hide"));
    expect(hideCall).toContain("scope=user");
    expect(hideCall).toContain(`path=${encodeURIComponent(selectedSkill.path)}`);
  });

  test("failed hide and delete requests preserve the selected skill", async () => {
    globalThis.fetch = (async () => Response.json({ error: "denied" }, { status: 500 })) as typeof fetch;
    const selectedSkill = {
      name: "lint-helper",
      path: "/tmp/lint-helper/SKILL.md",
      scope: "user" as const,
      source: "opencode" as const,
    };
    useSkillsStore.setState({
      selectedSkillName: selectedSkill.name,
      selectedSkillIdentity: getSkillIdentity(selectedSkill),
      skills: [selectedSkill],
    });

    expect(await useSkillsStore.getState().hideSkill(selectedSkill)).toBe(false);
    expect(await useSkillsStore.getState().deleteSkill(selectedSkill)).toBe(false);
    expect(useSkillsStore.getState().selectedSkillName).toBe(selectedSkill.name);
    expect(useSkillsStore.getState().selectedSkillIdentity).not.toBe(null);
  });
});
