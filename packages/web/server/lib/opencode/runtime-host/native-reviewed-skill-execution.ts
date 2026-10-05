import path from 'node:path';
import {Skill as NativeSkill} from '@opencode/core/skill';
import {Skill as SkillSchema} from '@opencode/schema/skill';
import {Tool} from '@opencode/core/tool';
import {Effect,Schema} from 'effect';
import type {ExecuteOwned,OwnedToolInvocation} from './native-admission-contract.js';
import type {NativeConfigurationSnapshot} from './native-configuration-snapshot.js';
import {readReviewedSkillResource,resolveReviewedSkillAlias} from './reviewed-skills.js';

export interface ReviewedSkillExecutionOptions {
  readonly snapshot:NativeConfigurationSnapshot;
  /** Existing direct-admit/direct-finish owner, including actual failure settlement. */
  readonly withDirectRead:(invocation:OwnedToolInvocation,execute:ReturnType<ExecuteOwned>)=>ReturnType<ExecuteOwned>;
}
const Input=Schema.Struct({id:Schema.String});
const failure=(message:string)=>Effect.fail(new Tool.Error({message}));

/** Actual native formatting over exact reviewed bytes, with no filesystem discovery. */
export function createReviewedSkillExecution(options:ReviewedSkillExecutionOptions):ExecuteOwned {
  if(typeof options.withDirectRead!=='function')throw new Error('native_skill_direct_owner_required');
  return invocation=>{
    if(invocation.toolID!=='skill'||invocation.provenance.kind!=='native'||invocation.provenance.id!=='opencode.tool.skill')return failure('native_skill_registration_required');
    const execute=Effect.gen(function*(){
      yield* invocation.recheckPermit();
      const input=yield* Effect.try({try:()=>Schema.decodeUnknownSync(Input)(invocation.input,{onExcessProperty:'error'}),catch:()=>new Tool.Error({message:'native_skill_input_invalid'})});
      const directory=invocation.location.directory;
      const id=resolveReviewedSkillAlias(options.snapshot,directory,input.id);
      const location=options.snapshot.locations.find(value=>value.directory===directory),skill=location?.skills.find(value=>value.id===id);
      if(!skill)return yield* failure('native_skill_unreviewed');
      // The hashed id stays the permission resource; the human name is display-only.
      yield* invocation.nativeContext.progress({name:skill.name});
      yield* invocation.nativePermissionAssert({action:'skill',resources:[skill.id],save:[skill.id],metadata:{name:skill.name},sessionID:invocation.nativeContext.sessionID,
        agent:invocation.nativeContext.agent,source:{type:'tool',messageID:invocation.nativeContext.messageID,id:invocation.nativeContext.id}})
        .pipe(Effect.mapError(()=>new Tool.Error({message:'native_skill_permission_refused'})));
      // Body read is an exact manifest grant. It cannot grant access to its
      // protected parent directory or a changed/symlink-replaced resource.
      yield* Effect.tryPromise({try:()=>readReviewedSkillResource(options.snapshot,{snapshotDigest:options.snapshot.digest,directory,skillID:skill.id,relativePath:path.basename(skill.path)}),
        catch:error=>new Tool.Error({message:error instanceof Error?error.message:'native_skill_resource_changed'})});
      yield* invocation.recheckPermit();
      const info=Schema.decodeUnknownSync(SkillSchema.Info)({id:skill.id,name:skill.name,path:skill.path,content:skill.content,description:skill.description});
      const files=path.basename(skill.path)==='SKILL.md'?skill.resources.map(value=>value.canonicalPath).sort().slice(0,10):[];
      const output={name:skill.name,directory:path.dirname(skill.path),output:NativeSkill.toModelOutput(info,files)};
      return {output,content:output.output,metadata:{name:skill.name,directory:output.directory}};
    });
    return options.withDirectRead(invocation,execute);
  };
}
