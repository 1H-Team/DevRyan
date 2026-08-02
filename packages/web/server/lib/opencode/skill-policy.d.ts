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

export const RETIRED_DEVRYAN_SKILL_NAMES: readonly [
  'test-driven-development',
  'subagent-driven-development',
];
export function isRetiredDevRyanSkillName(value: unknown): boolean;

export function buildVisibleSkillPolicy(input?: {
  skills?: SkillPolicyEntry[];
  hiddenSkills?: SkillPolicyEntry[];
  runtimeExternalDirectories?: string[];
}): VisibleSkillPolicy;

export function sanitizeAgentSkillPolicy<T extends Record<string, unknown>>(
  frontmatter: T,
  policy?: VisibleSkillPolicy | null,
): T;
