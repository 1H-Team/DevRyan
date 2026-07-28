export type SkillPolicyEntry = {
  name?: unknown;
  path?: unknown;
};

export type VisibleSkillPolicy = {
  skillNames: string[];
  skillDirectories: string[];
  skillDirectoriesByName: Record<string, string[]>;
  runtimeExternalDirectories: string[];
};

export function buildVisibleSkillPolicy(input?: {
  skills?: SkillPolicyEntry[];
  hiddenSkills?: SkillPolicyEntry[];
  runtimeExternalDirectories?: string[];
}): VisibleSkillPolicy;

export function sanitizeAgentSkillPolicy<T extends Record<string, unknown>>(
  frontmatter: T,
  policy?: VisibleSkillPolicy | null,
): T;
