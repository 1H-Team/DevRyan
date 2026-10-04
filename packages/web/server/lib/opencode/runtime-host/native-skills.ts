import type { Plugin } from '@opencode/plugin/effect/plugin';
import { Skill } from '@opencode/schema/skill';
import { Effect, Schema } from 'effect';
import type { NativeConfigurationSnapshot } from './native-configuration-snapshot.js';

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
