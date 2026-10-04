import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {claudeKeychainService} from '../claude-credential-projection.js';
import {isNativeKeychainService,isVerifiedNativeClaudeEnrollmentProfile} from './native-setup-profiles.js';
import {BUNDLE_DOCUMENT_MAX_BYTES} from './bundle-document-limits.js';
import {fingerprintSessionVaultCredentials} from '../../multi-user/vault.js';

export const BUNDLE_CREDENTIAL_OWNER_PROTOCOL='devryan.bundle.credential-owners/2';
const fail=()=>Object.assign(new Error('bundle_credential_owner_unsupported'),{code:'bundle_credential_owner_unsupported',status:503});
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const canonical=value=>Array.isArray(value)?value.map(canonical):record(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const hash=value=>createHash('sha256').update(value).digest('hex');
const digest=value=>hash(JSON.stringify(canonical(value)));
export const isBundleCredentialOwnerEvidence=value=>record(value)&&Object.keys(value).length===3
 &&value.protocol===BUNDLE_CREDENTIAL_OWNER_PROTOCOL&&/^[a-f0-9]{64}$/.test(value.sha256??'')&&record(value.accountDirectories)
 &&Object.entries(value.accountDirectories).length<=64&&Object.entries(value.accountDirectories).every(([id,sha])=>/^[a-f0-9]{64}$/.test(id)&&/^[a-f0-9]{64}$/.test(sha));

/** Read only existing bundle-owned sources. Evidence contains no values or paths;
 * original vault credential semantics and exact keys refuse changed grants; no merge. */
export async function captureBundleCredentialOwners({descriptor,assertHeld,relocationBaseline,controlRoot,claudeLifecycle}){
 await assertHeld();
 const home=descriptor.launch.global.home,web=descriptor.launch.webDataDirectory;
 for(const root of [home,web])if(!path.isAbsolute(root)||path.normalize(root)!==root||await fs.realpath(root)!==root||!(await fs.lstat(root)).isDirectory())throw fail();
 const read=async(root,relative,max=BUNDLE_DOCUMENT_MAX_BYTES)=>{
  let file=root;
  for(const segment of relative.split('/')){
   if(!segment||segment==='.'||segment==='..')throw fail();file=path.join(file,segment);
   let stat;try{stat=await fs.lstat(file);}catch(error){if(error.code==='ENOENT')return null;throw fail();}
   if(stat.isSymbolicLink()||await fs.realpath(file)!==file)throw fail();
  }
  const stat=await fs.lstat(file);if(!stat.isFile()||stat.size>max)throw fail();
  const handle=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
   const before=await handle.stat(),bytes=await handle.readFile(),after=await fs.lstat(file);
   if(bytes.length>max||before.ino!==stat.ino||before.dev!==stat.dev||after.ino!==before.ino||after.dev!==before.dev
    ||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)throw fail();
   return bytes;
  }finally{await handle.close();}
 };
 const json=bytes=>{try{return JSON.parse(bytes.toString('utf8'));}catch{throw fail();}};
 const bytesHash=bytes=>bytes===null?null:hash(bytes);
 const profileBytes=await read(home,'.config/meridian/profiles.json',1024*1024);
 let profiles=null;const accounts=Object.create(null),accountDirectories=Object.create(null),stableProfiles=[];
 if(relocationBaseline!==undefined&&!isBundleCredentialOwnerEvidence(relocationBaseline))throw fail();
 if(profileBytes!==null){
  const rows=json(profileBytes);if(!Array.isArray(rows)||rows.length>64)throw fail();const ids=new Set();profiles=[];
  for(const row of rows){
   if(!record(row)||typeof row.id!=='string'||!row.id||row.id.length>256||ids.has(row.id))throw fail();ids.add(row.id);
   const profile={...row};
   if(row.type==='claude-max'||row.claudeConfigDir!==undefined){
    const directory=row.claudeConfigDir??path.join(home,'.claude');
    if(await isVerifiedNativeClaudeEnrollmentProfile(row,{controlRoot,home,claudeLifecycle})){
     const accountID=hash(row.id),binding={profileID:row.id,configDirectory:directory,service:row.keychainService,enrollmentID:path.basename(directory)};
     accountDirectories[accountID]=hash('stable-enrollment:'+directory);
     if(relocationBaseline&&relocationBaseline.accountDirectories[accountID]!==accountDirectories[accountID])throw fail();
     accounts[row.id]=digest(binding);profiles.push(profile);stableProfiles.push(row);continue;
    }
    if(typeof directory!=='string'||!path.isAbsolute(directory)||path.normalize(directory)!==directory
     ||!(directory===home||directory.startsWith(home+path.sep)))throw fail();
    const service=row.keychainService??claudeKeychainService(directory,home);if(!isNativeKeychainService(service))throw fail();
    const accountID=hash(row.id);
    if(relocationBaseline){
     if(directory!==path.join(home,'.config','meridian','accounts',accountID)||!Object.hasOwn(relocationBaseline.accountDirectories,accountID))throw fail();
     accountDirectories[accountID]=relocationBaseline.accountDirectories[accountID];
    }else accountDirectories[accountID]=hash(path.relative(home,directory));
    // Only the typed account directory is relocated by the original clone owner.
    profile.claudeConfigDir='bundle-account:'+row.id;profile.keychainService=service;
    accounts[row.id]=bytesHash(await read(home,path.relative(home,path.join(directory,'.credentials.json')).split(path.sep).join('/'),1024*1024));
   }
   profiles.push(profile);
  }
 }
 const settings=await read(home,'.config/meridian/settings.json',1024*1024);
 const parsedSettings=settings===null?null:json(settings);if(settings!==null&&!record(parsedSettings))throw fail();
 const vaultPairs=[];
 const state={profiles,settings:parsedSettings,accounts,accountDirectories,
  defaultClaude:bytesHash(await read(home,'.claude/.credentials.json',1024*1024)),quota:{},vaults:{}};
 for(const name of ['opencode','opencode-go','ollama-cloud','cursor-acp'])state.quota[name]=bytesHash(await read(web,'quota/'+name+'.json',16*1024));
 for(const name of ['multi-user-vault','branch-preview-vault']){
  const key=await read(web,name+'.key'),vault=await read(web,name+'.json');
  // The branch-preview owner creates its empty key before its first credential.
  if(name==='multi-user-vault'&&(key===null)!==(vault===null)||key===null&&vault!==null)throw fail();
  let vaultDigest=bytesHash(vault);
  if(name==='multi-user-vault'&&vault!==null){
   try{vaultDigest=fingerprintSessionVaultCredentials({keyBytes:key,vaultBytes:vault});}catch{throw fail();}
   // The original pair must still be the same bytes after codec work.
   if(bytesHash(await read(web,name+'.key'))!==bytesHash(key)||bytesHash(await read(web,name+'.json'))!==bytesHash(vault))throw fail();
  }
  vaultPairs.push({name,key:bytesHash(key),vault:bytesHash(vault)});
  state.vaults[name]={key:bytesHash(key),vault:vaultDigest};
 }
 await assertHeld();
 for(const profile of stableProfiles)if(!await isVerifiedNativeClaudeEnrollmentProfile(profile,{controlRoot,home,claudeLifecycle}))throw fail();
 for(const pair of vaultPairs)if(bytesHash(await read(web,pair.name+'.key'))!==pair.key||bytesHash(await read(web,pair.name+'.json'))!==pair.vault)throw fail();
 return {protocol:BUNDLE_CREDENTIAL_OWNER_PROTOCOL,sha256:digest(state),accountDirectories};
}

/** A native-only projection receipt is insufficient for host credential owners. */
export async function assertBundleCredentialOwners({candidate,target,baseline,assertHeld,controlRoot,claudeLifecycle}){
 if(!isBundleCredentialOwnerEvidence(baseline))throw fail();
 const [left,right]=await Promise.all([captureBundleCredentialOwners({descriptor:candidate,assertHeld,controlRoot,claudeLifecycle,
  ...(candidate.sourceBundleID===target.bundleID?{relocationBaseline:baseline}:{})}),captureBundleCredentialOwners({descriptor:target,assertHeld,controlRoot,claudeLifecycle})]);
 if(left.sha256!==baseline.sha256||right.sha256!==baseline.sha256)throw fail();
 await assertHeld();return baseline;
}
