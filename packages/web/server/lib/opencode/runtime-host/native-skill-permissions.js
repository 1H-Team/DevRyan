import {Wildcard} from '@opencode/core/util/wildcard';
import {reviewedSkillAliases,resolveReviewedSkillAlias,buildReviewedSkillAliasIndex} from './reviewed-skills.js';
const fail=code=>Object.assign(new Error(code),{code,status:503});
/** Rewrite only the frozen skill namespace; use the exact native permission matcher. */
export function translateNativeSkillPermissionRules(rules,directory,skills){
 const snapshot={locations:[{directory,skills}]},aliases=reviewedSkillAliases(skills),ids=new Set(skills.map(skill=>skill.id));
 return rules.flatMap(rule=>{
  if(!Wildcard.match('skill',rule.action)||rule.resource==='*'||ids.has(rule.resource))return [rule];
  let targets;
  if(!/[?*]/.test(rule.resource)){
   const target=resolveReviewedSkillAlias(snapshot,directory,rule.resource);
   if(target===null){
    // A known ambiguous name cannot become an allow/deny for an arbitrary
    // duplicate. Unknown dormant names remain inert exact rules.
    const normalized=value=>value.toLowerCase().replace(/[^a-z0-9]/g,'');
    if(skills.some(skill=>skill.name.trim()===rule.resource||normalized(skill.name)===normalized(rule.resource)||normalized(skill.path.split(/[\\/]/).at(-2))===normalized(rule.resource)))throw fail('native_skill_permission_ambiguous');
    return [rule];
   }
   targets=[target];
  }else{
   const index=buildReviewedSkillAliasIndex(skills);
   for(const [name,id] of [...index.canonical,...index.normalized])if(id===null && Wildcard.match(name,rule.resource))throw fail('native_skill_permission_pattern_ambiguous');
   targets=[...new Set(aliases.filter(alias=>Wildcard.match(alias.name,rule.resource)).map(alias=>alias.targetID))];
   // A generated-ID pattern mixed with a legacy alias pattern has no single
   // legacy meaning. Refuse rather than broaden an old rule accidentally.
   if(skills.some(skill=>Wildcard.match(skill.id,rule.resource)) && !targets.length)throw fail('native_skill_permission_pattern_unqualified');
  }
  const translated=targets.map(resource=>({...rule,action:'skill',resource}));
  // Preserve unrelated action semantics for wildcard action rules, provided
  // their original resource does not independently match a stable skill ID.
  if(rule.action!=='skill'){
   if(skills.some(skill=>Wildcard.match(skill.id,rule.resource)))throw fail('native_skill_permission_action_unqualified');
   return [rule,...translated];
  }
  return translated;
 });
}
export function translateNativeSkillPermissions(configuration,directory,skills){
 const rulesFor=rules=>translateNativeSkillPermissionRules(rules,directory,skills);
 if(configuration.permissions!==undefined)configuration.permissions=rulesFor(configuration.permissions);
 for(const agent of Object.values(configuration.agents??{}))if(agent.permissions!==undefined)agent.permissions=rulesFor(agent.permissions);
 return configuration;
}
