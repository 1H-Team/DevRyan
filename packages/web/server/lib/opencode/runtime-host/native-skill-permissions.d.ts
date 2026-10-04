import type {ReviewedSkill} from './reviewed-skills.js';
export function translateNativeSkillPermissions(configuration:Record<string,unknown>,directory:string,skills:readonly ReviewedSkill[]):Record<string,unknown>;
import type {Permission} from '@opencode/schema/permission';
export function translateNativeSkillPermissionRules(rules:Permission.Ruleset,directory:string,skills:readonly ReviewedSkill[]):Permission.Ruleset;
