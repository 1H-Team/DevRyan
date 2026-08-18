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
export function normalizeSkillPath(value: unknown): string;
export function filterVisibleSkills<T extends SkillPolicyEntry>(
  skills?: T[],
  hiddenSkills?: SkillPolicyEntry[],
): T[];

export function buildVisibleSkillPolicy(input?: {
  skills?: SkillPolicyEntry[];
  hiddenSkills?: SkillPolicyEntry[];
  runtimeExternalDirectories?: string[];
}): VisibleSkillPolicy;

export function resolveApprovedSkills<T extends SkillPolicyEntry>(input?: {
  discoveredSkills?: T[];
  runtimeSkills?: T[];
  hiddenSkills?: SkillPolicyEntry[];
}): T[];

export function sanitizeAgentSkillPolicy<T extends Record<string, unknown>>(
  frontmatter: T,
  policy?: VisibleSkillPolicy | null,
): T;
