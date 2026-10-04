import {isNativeKeychainService} from './native-setup-profiles.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import {isNativeClaudeEnrollmentDirectory} from './native-claude-enrollment-directory.js';

const fail=code=>Object.assign(new Error(code),{code,status:503,statusCode:503});
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const inside=(directory,root)=>directory===root||directory.startsWith(root+path.sep);
const parse=text=>{try{return JSON.parse(text);}catch{return undefined;}};
// Exact I/G/K/z/F ordering of the captured opencode-with-claude 1.8.0 loader.
// Parsing warnings contain input fragments in that loader, so this boundary
// returns only source disposition and never forwards warning text or secrets.
const profiles=value=>!Array.isArray(value)?[]:value.flatMap(row=>{
  if(!record(row)||typeof row.id!=='string'||!row.id)return [];
  if(row.keychainService!==undefined&&!isNativeKeychainService(row.keychainService))throw fail('native_provider_configuration_invalid');
  const profile={id:row.id};
  if(['claude-max','api','oauth-token'].includes(row.type))profile.type=row.type;
  if(row.credentialPolicy!==undefined){
    if(row.credentialPolicy!=='access-only'||row.type!=='oauth-token')throw fail('native_provider_configuration_invalid');
    profile.credentialPolicy=row.credentialPolicy;
  }
  for(const field of ['claudeConfigDir','keychainService','apiKey','baseUrl','oauthToken'])if(typeof row[field]==='string')profile[field]=row[field];
  return [profile];
});

/** Resolve the original saved Meridian setup within the selected private bundle.
 * Explicit environment input is required; process HOME and installed files are
 * never consulted. Secrets remain solely in the returned private worker boot. */
export async function resolveNativeProviderConfiguration({globals,environment,controlRoot}){
  for(const field of ['home','config','data']){
    const directory=globals?.[field];
    if(typeof directory!=='string'||!path.isAbsolute(directory)||await fs.realpath(directory)!==directory||!(await fs.stat(directory)).isDirectory())throw fail('native_provider_configuration_roots_invalid');
  }
  if(!record(environment))throw fail('native_provider_configuration_environment_required');
  const read=async name=>{
    const file=path.join(globals.home,'.config','meridian',name);let resolved;
    try{resolved=await fs.realpath(file);}catch(error){if(error.code==='ENOENT')return undefined;throw fail('native_provider_configuration_unreadable');}
    if(resolved!==file||!inside(resolved,globals.home))throw fail('native_provider_configuration_escape');
    const stat=await fs.stat(resolved);if(!stat.isFile()||stat.size>1024*1024)throw fail('native_provider_configuration_invalid');
    return parse(await fs.readFile(resolved,'utf8'));
  };
  let configured=[],source='none',defaultProfile,defaultSource='none',originalProfiles;
  const input=environment.MERIDIAN_PROFILES;
  if(input!==undefined&&(typeof input!=='string'||Buffer.byteLength(input)>1024*1024))throw fail('native_provider_configuration_invalid');
  const fromEnvironment=input?parse(input):undefined;
  if(fromEnvironment!==undefined){originalProfiles=fromEnvironment;configured=profiles(fromEnvironment);source='env';}
  else{const raw=await read('profiles.json'),saved=profiles(raw);if(saved.length){originalProfiles=raw;configured=saved;source='disk';}}
  const selected=environment.MERIDIAN_DEFAULT_PROFILE;
  if(selected!==undefined&&typeof selected!=='string')throw fail('native_provider_configuration_invalid');
  if(selected?.trim()){defaultProfile=selected.trim();defaultSource='env';}
  else{const settings=await read('settings.json');if(record(settings)&&typeof settings.activeProfile==='string'&&settings.activeProfile){defaultProfile=settings.activeProfile;defaultSource='disk';}}
  if(defaultProfile&&configured.length&&!configured.some(profile=>profile.id===defaultProfile)){defaultProfile=undefined;defaultSource='none';}
  if(configured.length>64||new Set(configured.map(profile=>profile.id)).size!==configured.length)throw fail('native_provider_configuration_invalid');
  for(const profile of configured){
    if(profile.keychainService!==undefined&&!isNativeKeychainService(profile.keychainService))throw fail('native_provider_configuration_invalid');
    if(profile.claudeConfigDir===undefined)continue;
    const directory=profile.claudeConfigDir;
    if(!path.isAbsolute(directory)||![globals.home,globals.config,globals.data].some(root=>inside(directory,root))
      &&!await isNativeClaudeEnrollmentDirectory(profile,{controlRoot,home:globals.home}))throw fail('native_provider_profile_escape');
    let resolved,stat;try{resolved=await fs.realpath(directory);stat=await fs.stat(directory);}catch{throw fail('native_provider_profile_escape');}
    if(resolved!==directory||!stat.isDirectory())throw fail('native_provider_profile_escape');
  }
  const oauthTokenExpiries={};
  for(const row of Array.isArray(originalProfiles)?originalProfiles:[]){
    if(!record(row)||row.credentialPolicy!=='access-only'||row.oauthTokenExpiresAt===undefined)continue;
    if(row.type!=='oauth-token'||!configured.some(profile=>profile.id===row.id)||!Number.isSafeInteger(row.oauthTokenExpiresAt)||row.oauthTokenExpiresAt<0)throw fail('native_provider_configuration_invalid');
    oauthTokenExpiries[row.id]=row.oauthTokenExpiresAt;
  }
  return {profiles:configured,...(defaultProfile!==undefined?{defaultProfile}:{}),...(Object.keys(oauthTokenExpiries).length?{oauthTokenExpiries}:{}),sources:{profiles:source,defaultProfile:defaultSource}};
}
