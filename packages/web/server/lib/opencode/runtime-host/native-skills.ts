import type { Plugin } from '@opencode/plugin/effect/plugin';
import { Skill } from '@opencode/schema/skill';
import { Effect, Schema } from 'effect';
import {buildReviewedSkillAliasIndex,type ReviewedSkill} from './reviewed-skills.js';
import type { NativeConfigurationSnapshot } from './native-configuration-snapshot.js';

/** Names avoid copying opaque hashes; exact IDs remain accepted for compatibility. */
export function reviewedSkillToolInput(skills:readonly ReviewedSkill[]) {
  const names=[...buildReviewedSkillAliasIndex(skills).canonical].filter(([,id])=>id!==null).map(([name])=>name);
  return Schema.Struct({id:Schema.Literals([...names,...skills.map(skill=>skill.id)]),name:Schema.optional(Schema.String)});
}

/** Exact snapshot bytes replace filesystem and URL skill discovery. */
export function nativeSkillsPlugin(snapshot: NativeConfigurationSnapshot): Plugin {
  return { id: 'devryan.reviewed-skills', effect: context => Effect.gen(function* () {
    const location = snapshot.locations.find(value => value.directory === context.location.directory);
    if (!location) return yield* Effect.die(new Error('native_skill_location_unreviewed'));
    const skills = location.skills.map(skill => Schema.decodeUnknownSync(Skill.Info)({ id: skill.id, name: skill.name,
      path: skill.path, content: skill.content, description: skill.description }));
    yield* context.skill.transform(editor => { for (const skill of skills) editor.add(skill); });
  }) };
}
