import {relocateNativeSetupProfiles} from './native-setup-profiles.js';
import {projectNativeSetupCredentials} from './native-setup-credential-data.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {saveBundleJSON} from './bundle-migration-inventory.js';

const fail=code=>Object.assign(new Error(code),{code,status:503,statusCode:503});
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export const NATIVE_SETUP_CREDENTIAL_FILE='native-setup-credentials.json';
// Saved preference fields owned by settings-helpers and desktop-settings. Runtime
// selections, drafts and session/task references are intentionally not setup.
const settingsKeys=new Set(["activeProjectId", "activityRenderMode", "agentBrowserControlEnabled", "approvedDirectories", "autoCreateWorktree", "autoDeleteAfterDays", "autoDeleteEnabled", "chatRenderMode", "chatWidth", "cornerRadius", "darkThemeId", "defaultAgent", "defaultFileViewerPreview", "defaultGitIdentityId", "defaultModel", "defaultPlanMode", "defaultVariant", "desktopKeepAwakeEnabled", "desktopLanAccessEnabled", "diffLayoutPreference", "diffViewMode", "directoryShowHidden", "favoriteModels", "favoriteModelsUpdatedAt", "filesViewShowGitignored", "fontSize", "gitChangesViewMode", "gitModelId", "gitProviderId", "githubClientId", "githubScopes", "gitmojiEnabled", "globalBehaviorPrompt", "hiddenModels", "hiddenModelsUpdatedAt", "hiddenSkills", "homeDirectory", "inputBarOffset", "inputSpellcheckEnabled", "lastDirectory", "lightThemeId", "managedLocalTunnelConfigPath", "managedRemoteTunnelHostname", "managedRemoteTunnelPresetTokens", "managedRemoteTunnelPresets", "managedRemoteTunnelSelectedPresetId", "managedRemoteTunnelToken", "markdownDisplayMode", "maxLastMessageLength", "mermaidRenderingMode", "messageLimit", "messageStreamTransport", "mobileKeyboardMode", "monoFont", "nativeNotificationsEnabled", "notificationMode", "notificationTemplates", "notifyOnCompletion", "notifyOnError", "notifyOnPermission", "notifyOnPlanReady", "notifyOnQuestion", "notifyOnSubtasks", "openInAppId", "padding", "pinnedDirectories", "projects", "pwaAppName", "pwaOrientation", "queueModeEnabled", "recentModels", "reportUsage", "responseStyleCustomInstructions", "responseStyleEnabled", "responseStylePreset", "securityScopedBookmarks", "sessionRetentionAction", "sessionRetentionArchivedOnly", "showDeletionDialog", "showExpandedBashTools", "showExpandedEditTools", "showReasoningTraces", "showSplitAssistantMessageActions", "showTextJustificationActivity", "showToolFileIcons", "skillCatalogs", "splashBgDark", "splashBgLight", "splashFgDark", "splashFgLight", "stickyUserHeader", "sttLanguage", "sttModel", "sttProvider", "sttServerUrl", "sttSilenceHoldMs", "sttSilenceThresholdDb", "summarizeLastMessage", "summaryLength", "summaryThreshold", "terminalFontSize", "themeCatalogVersion", "themeId", "themeVariant", "timeFormatPreference", "toolCallExpansion", "tunnelBootstrapTtlMs", "tunnelMode", "tunnelProvider", "tunnelSessionTtlMs", "typographySizes", "uiFont", "usageAutoRefresh", "usageCollapsedFamilies", "usageDisplayMode", "usageDropdownProviders", "usageExpandedFamilies", "usageModelGroups", "usageRefreshIntervalMs", "usageSelectedModels", "usageShowPredValues", "useSystemTheme", "userMessageRenderingMode", "wasmSttModel", "weekStartPreference", "zenModel", "desktopHosts", "desktopDefaultHostId", "desktopInitialHostChoiceCompleted", "desktopWindowState", "desktopSshInstances"]);
const stateKeys=new Set(['sessions','sessionID','sessionId','sessionIDs','sessionIds','selectedSessionId','selectedSessionID',
 'activeSessionId','activeSessionID','lastSessionId','lastSessionID','openSessionIds','openSessionIDs','sessionPointers','rootSessionId','rootSessionID','drafts','sessionDrafts',
 'tasks','taskGroups','orchestration','receipts','permits','journal','runtimeSelection','opencodeBinary']);
export const projectNativeSetupState=input=>Array.isArray(input)?input.map(projectNativeSetupState):record(input)?Object.fromEntries(Object.entries(input)
 .filter(([key])=>!stateKeys.has(key)).map(([key,item])=>[key,projectNativeSetupState(item)])):input;
export function projectNativeSetupSettings(value){
 if(!record(value))throw fail('native_setup_settings_invalid');
 return projectNativeSetupState(Object.fromEntries(Object.entries(value).filter(([key])=>settingsKeys.has(key))));
}


/** Capture setup into the existing privately owned empty source. Never traverse
 * conversation databases or copy the old web-data tree, HOME, caches or journals. */
export async function seedNativeSetup({source,target,environment={},captureLogicalSetup}){
 const marker=path.join(target.webDataDirectory,'native-setup-seed.json');
 let total=0,visited=0;const files=[];
 const read=async(file,root)=>{
  const relative=path.relative(root,file);if((relative==='..'||relative.startsWith('..'+path.sep))||path.isAbsolute(relative))throw fail('native_setup_source_invalid');
  let current=root;
  for(const part of ['',...relative.split(path.sep).filter(Boolean)]){current=part?path.join(current,part):current;
   let stat;try{stat=await fs.lstat(current);}catch(error){if(error.code==='ENOENT')return undefined;throw error;}
   if(stat.isSymbolicLink()||await fs.realpath(current)!==current)throw fail('native_setup_source_invalid');
  }
  const handle=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const stat=await handle.stat();if(!stat.isFile()||stat.size>1024*1024||files.length>=4096||(total+=stat.size)>16*1024*1024)throw fail('native_setup_source_too_large');
   const bytes=await handle.readFile(),after=await fs.stat(file);if(bytes.length!==stat.size||after.ino!==stat.ino||after.dev!==stat.dev||after.mtimeMs!==stat.mtimeMs||after.ctimeMs!==stat.ctimeMs)throw fail('native_setup_source_changed');return bytes;
  }finally{await handle.close();}
 };
 const roots=[target.webDataDirectory,target.webConfigDirectory,target.opencodeConfigDirectory,target.global.home].map(value=>path.resolve(value));
 for(const root of roots){await fs.mkdir(root,{recursive:true,mode:0o700});const stat=await fs.lstat(root);
  if(!stat.isDirectory()||stat.isSymbolicLink()||await fs.realpath(root)!==root||typeof process.getuid==='function'&&stat.uid!==process.getuid())throw fail('native_setup_target_invalid');
  await fs.chmod(root,0o700);
 }
 const markerBytes=await read(marker,target.webDataDirectory);
 if(markerBytes!==undefined){
  let saved;try{saved=JSON.parse(markerBytes.toString('utf8'));}catch{throw fail('native_setup_seed_invalid');}
  if(!record(saved)||saved.schema!==1||!Array.isArray(saved.files)||saved.files.length>4096)throw fail('native_setup_seed_invalid');
  const seen=new Set();
  for(const row of saved.files){
   if(!record(row)||typeof row.path!=='string'||path.resolve(row.path)!==row.path||seen.has(row.path)||typeof row.sha256!=='string'||!/^[a-f0-9]{64}$/.test(row.sha256))throw fail('native_setup_seed_invalid');
   const root=roots.find(value=>row.path.startsWith(value+path.sep));if(!root)throw fail('native_setup_seed_invalid');
   const bytes=await read(row.path,root);if(bytes===undefined||hash(bytes)!==row.sha256)throw fail('native_setup_seed_changed');seen.add(row.path);
  }
  return saved;
 }
 const save=async(file,bytes)=>{
  if(files.some(row=>row.path===file))throw fail('native_setup_destination_conflict');
  await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});
  const root=roots.find(value=>file.startsWith(value+path.sep));if(!root)throw fail('native_setup_target_invalid');
  const existing=await read(file,root);
  if(existing!==undefined){if(hash(existing)!==hash(bytes))throw fail('native_setup_seed_changed');}
  else await fs.writeFile(file,bytes,{flag:'wx',mode:0o600});
  await fs.chmod(file,0o600);files.push({path:file,sha256:hash(bytes)});
 };
 const copy=async(root,relative,destination,transform)=>{
  if(++visited>8192)throw fail('native_setup_source_too_large');
  const file=path.join(root,relative);let stat;try{stat=await fs.lstat(file);}catch(error){if(error.code==='ENOENT')return;throw error;}
  if(stat.isSymbolicLink())throw fail('native_setup_source_invalid');
  if(stat.isDirectory()){
   if(await fs.realpath(file)!==file)throw fail('native_setup_source_invalid');
   for(const name of (await fs.readdir(file)).sort()){if(name.includes('\0'))throw fail('native_setup_source_invalid');await copy(root,path.join(relative,name),path.join(destination,name),transform);}return;
  }
  const bytes=await read(file,root);if(bytes===undefined)return;
  let result=bytes;
  if(transform){let parsed;try{parsed=JSON.parse(bytes.toString('utf8'));}catch{throw fail('native_setup_json_invalid');}result=Buffer.from(JSON.stringify(transform(parsed))+'\n');}
  await save(destination,result);
 };
 await copy(source.webDataDirectory,'settings.json',path.join(target.webDataDirectory,'settings.json'),projectNativeSetupSettings);
 for(const name of ['supabase.json','supabase-connection.json','git-identities.json'])await copy(source.webDataDirectory,name,path.join(target.webDataDirectory,name),value=>{if(!record(value))throw fail('native_setup_json_invalid');return value;});
 await copy(source.webDataDirectory,'magic-prompts.json',path.join(target.webDataDirectory,'magic-prompts.json'),value=>{
  if(!record(value)||value.version!==1||!record(value.overrides)||Object.entries(value.overrides).some(([key,text])=>!/^[a-z0-9._-]{1,160}$/.test(key)||typeof text!=='string'||text.length>200000))throw fail('native_setup_json_invalid');
  return {version:1,overrides:value.overrides};
 });
 for(const name of ['cloudflare-managed-remote-tunnels.json','cloudflare-named-tunnels.json'])await copy(source.webDataDirectory,name,path.join(target.webDataDirectory,name),value=>{
  if(!record(value)||!Array.isArray(value.tunnels)||value.tunnels.length>128)throw fail('native_setup_json_invalid');
  return {version:value.version,tunnels:value.tunnels.map(row=>{
   if(!record(row)||typeof row.id!=='string'||typeof row.name!=='string'||typeof row.hostname!=='string'||typeof row.token!=='string'
    ||row.originPort!==undefined&&(!Number.isInteger(row.originPort)||row.originPort<1||row.originPort>65535))throw fail('native_setup_json_invalid');
   return {id:row.id,name:row.name,hostname:row.hostname,token:row.token,...row.originPort!==undefined?{originPort:row.originPort}:{},...Number.isFinite(row.updatedAt)?{updatedAt:row.updatedAt}:{}};
  })};
 });
 // Exact managed connection files; cached quota responses/flows are not setup.
 for(const name of ['opencode','opencode-go','ollama-cloud','cursor-acp'])await copy(source.webDataDirectory,'quota/'+name+'.json',path.join(target.webDataDirectory,'quota',name+'.json'));
 await copy(source.webDataDirectory,'project-icons',path.join(target.webDataDirectory,'project-icons'));
 await copy(source.webConfigDirectory,'projects',path.join(target.webConfigDirectory,'projects'),value=>projectNativeSetupState(value));
 await copy(source.webConfigDirectory,'themes',path.join(target.webConfigDirectory,'themes'));
 for(const name of ['config.json','opencode.json','opencode.jsonc','oh-my-opencode-slim.json','oh-my-opencode-slim.jsonc','AGENTS.md','.openchamber/config.json','ponytail/config.json'])await copy(source.opencodeConfigDirectory,name,path.join(target.opencodeConfigDirectory,name));
 for(const folder of ['agent','agents','command','commands','prompts','skills','skill'])await copy(source.opencodeConfigDirectory,folder,path.join(target.opencodeConfigDirectory,folder));
 for(const relative of ['.agents/skills','.opencode/skill','.opencode/skills','.config/meridian/settings.json','.claude/.credentials.json'])await copy(source.home,relative,path.join(target.global.home,relative));
 if(source.opencodeConfigFile){
  // The selected custom layer follows ordinary user/project layers. It must
  // neither replace config.json nor create two hashes for one destination.
  const custom=path.join(target.opencodeConfigDirectory,'native-custom-config.json');
  await copy(path.dirname(source.opencodeConfigFile),path.basename(source.opencodeConfigFile),custom);
 }
 if(environment.MERIDIAN_PROFILES!==undefined&&typeof environment.MERIDIAN_PROFILES!=='string')throw fail('native_setup_profiles_invalid');
 const profileBytes=environment.MERIDIAN_PROFILES!==undefined?Buffer.from(environment.MERIDIAN_PROFILES):await read(path.join(source.home,'.config','meridian','profiles.json'),source.home);
 if(profileBytes!==undefined&&profileBytes.length>1024*1024)throw fail('native_setup_profiles_invalid');
 if(profileBytes!==undefined){
  let profiles;try{profiles=JSON.parse(profileBytes.toString('utf8'));}catch{throw fail('native_setup_profiles_invalid');}
  const relocated=await relocateNativeSetupProfiles({profiles,sourceHome:source.home,targetHome:target.global.home,
   copyAccount:async(account,destination)=>{await fs.mkdir(destination,{recursive:true,mode:0o700});await copy(account,'.credentials.json',path.join(destination,'.credentials.json'));}});
  await save(path.join(target.global.home,'.config','meridian','profiles.json'),Buffer.from(JSON.stringify(relocated)+'\n'));
 }
 if(environment.MERIDIAN_DEFAULT_PROFILE){if(typeof environment.MERIDIAN_DEFAULT_PROFILE!=='string'||environment.MERIDIAN_DEFAULT_PROFILE.length>256)throw fail('native_setup_profiles_invalid');
  await save(path.join(target.global.home,'.config','meridian','settings.json'),Buffer.from(JSON.stringify({activeProfile:environment.MERIDIAN_DEFAULT_PROFILE})+'\n'));}
 const auth=await read(path.join(source.opencodeDataDirectory,'auth.json'),source.opencodeDataDirectory);
 if(auth!==undefined){let parsed;try{parsed=JSON.parse(auth.toString('utf8'));}catch{throw fail('native_setup_credentials_invalid');}
  await save(path.join(target.opencodeConfigDirectory,NATIVE_SETUP_CREDENTIAL_FILE),Buffer.from(JSON.stringify(projectNativeSetupCredentials(parsed))+'\n'));}
 if(captureLogicalSetup){
  const logical=await captureLogicalSetup();
  if(!record(logical)||Object.keys(logical).some(key=>!['localOwners'].includes(key))||!record(logical.localOwners))throw fail('native_setup_logical_invalid');
  const {validateSetupOwners}=await import('../../multi-user/vault.js');
  const owners=validateSetupOwners(logical.localOwners);
  await save(path.join(target.webDataDirectory,'native-setup-local-owners.json'),Buffer.from(JSON.stringify({schema:1,owners})+'\n'));
 }
 const saved={schema:1,files};await saveBundleJSON(marker,saved);return saved;
}
