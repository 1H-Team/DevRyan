import {relocateNativeSetupProfiles} from './native-setup-profiles.js';
import {projectNativeSetupCredentials} from './native-setup-credential-data.js';
import {NATIVE_SETUP_SEED_MAX_FILES as MAX_FILES,NATIVE_SETUP_SEED_MAX_FILE_BYTES as MAX_FILE_BYTES,NATIVE_SETUP_SEED_MAX_TOTAL_BYTES as MAX_TOTAL_BYTES,
 NATIVE_SETUP_SEED_MAX_MARKER_BYTES as MAX_MARKER_BYTES,isNativeSetupOSMetadata as osMetadata} from './native-setup-source.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {saveBundleJSON} from './bundle-migration-inventory.js';

const fail=code=>Object.assign(new Error(code),{code,status:503,statusCode:503});
// An unusable optional source entry: copy() records it and continues.
const skipped=reason=>Object.assign(fail('native_setup_source_skipped'),{reason});
// Raw platform errors (EACCES, ELOOP, errno -102 ...) never escape uncoded; owner codes pass through.
const coded=error=>typeof error?.status==='number'?error:Object.assign(fail('native_setup_io_failed'),{errno:String(typeof error?.code==='string'?error.code:error?.name).slice(0,64)});
const denied=error=>error?.code==='EACCES'||error?.code==='EPERM';
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const parseJSON=bytes=>{try{return JSON.parse(String(bytes));}catch{return undefined;}};
const inside=(root,value)=>value===root||value.startsWith(root+path.sep);
// OpenCode's configuration layer merge: objects merge deeply, a later scalar or array wins,
// and the top-level plugin and instructions lists concatenate without duplicates.
const mergeConfigLayer=(base,next,top=true)=>{
 if(!record(base)||!record(next))return next;
 const result={...base};
 for(const [key,value] of Object.entries(next))Object.defineProperty(result,key,{value:top&&['plugin','instructions'].includes(key)&&Array.isArray(base[key])&&Array.isArray(value)
  ?[...new Set([...base[key],...value])]:mergeConfigLayer(Object.hasOwn(base,key)?base[key]:undefined,value,false),enumerable:true,writable:true,configurable:true});
 return result;
};
// Never traversed in copied folders: VCS, dependency and bytecode trees are not setup.
const excluded=new Set(['.git','.hg','.svn','node_modules','.venv','__pycache__']);
// Chromium/Electron cookie, login and web storage, wherever a link or copied folder reaches it.
const browserStores=new Set(['Cookies','Cookies-journal','Login Data','Login Data-journal','Web Data','Web Data-journal','Local Storage','Session Storage','IndexedDB','Partitions']);
// DevRyan's own web-data secrets and runtime state (bot tokens, OAuth flow state, push keys,
// SDK sessions, harness/ledger/process records), never copied even when that directory protects nothing else.
const webSecrets=['multi-user-vault.key','multi-user-vault.json','branch-preview-vault.key','branch-preview-vault.json','jwt-secret','github-auth.json','ui-passkeys.json','bots','multi-user','credentials',
 'bot-integrations','runtime','push-subscriptions.json','cursor-sdk-sessions','harness','orchestration','processes'];
const MAX_VISITED=8192,MAX_REPORTED=200;
// Diagnostics name the source file relative to its read root, never its bytes or HOME.
const sanitize=relative=>String(relative).split(path.sep).join('/').replace(/[\u0000-\u001f\u007f-\u009f]/g,'').replace(/^\/+/,'').slice(0,256);
const located=async(relative,action)=>{
 try{return await action();}catch(error){
  const result=coded(error);if(result.code.startsWith?.('native_setup_')&&result.relativePath===undefined)result.relativePath=sanitize(relative);
  throw result;
 }
};
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
 * conversation databases or copy the old web-data tree, HOME, caches or journals.
 * Unusable optional entries are skipped and returned as non-persisted `skipped`
 * rows (sanitized relative path and reason); corrupt required records fail. */
export async function seedNativeSetup(input){
 try{return await seed(input);}catch(error){throw coded(error);}
}
async function seed({source,target,environment={},captureLogicalSetup}){
 const marker=path.join(target.webDataDirectory,'native-setup-seed.json');
 let total=0,visited=0,pinned=24,exhausted=false,skippedCount=0;const files=[],skippedRows=[],reasons={};
 const skip=(relative,reason,detail={})=>{skippedCount++;reasons[reason]=(reasons[reason]??0)+1;if(skippedRows.length<MAX_REPORTED)skippedRows.push({relativePath:sanitize(relative),reason,...detail});};
 const read=async(file,root,limit=MAX_FILE_BYTES)=>{
  const relative=path.relative(root,file);if((relative==='..'||relative.startsWith('..'+path.sep))||path.isAbsolute(relative))throw fail('native_setup_source_invalid');
  let current=root,real=root,checked;
  for(const part of ['',...relative.split(path.sep).filter(Boolean)]){current=part?path.join(current,part):current;
   let stat;try{stat=checked=await fs.lstat(current);}catch(error){if(error.code==='ENOENT'||error.code==='ENOTDIR')return undefined;if(denied(error))throw skipped('unreadable');throw error;}
   if(stat.isSymbolicLink())throw fail('native_setup_source_invalid');
   // Case-insensitive volumes: a component stored as agents.md/Skills is the requested
   // AGENTS.md/skills only when its realpath differs by case alone and is the same inode.
   const resolved=await fs.realpath(current),expected=part?path.join(real,part):root;
   if(resolved!==expected){
    const same=part&&path.dirname(resolved)===real&&path.basename(resolved).toLowerCase()===part.toLowerCase()&&await fs.lstat(resolved).then(item=>item.dev===stat.dev&&item.ino===stat.ino,()=>false);
    if(!same)throw fail('native_setup_source_invalid');
   }
   real=resolved;
  }
  // Non-blocking: a FIFO or socket swapped in after lstat never stalls bootstrap.
  let handle;try{handle=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}catch(error){
   if(error.code==='ENOENT')return undefined;if(denied(error))throw skipped('unreadable');if(error.code==='ELOOP')throw fail('native_setup_source_invalid');
   if(['ENXIO','EOPNOTSUPP','ENODEV'].includes(error.code))throw skipped('unsupported_type');throw error;}
  try{const stat=await handle.stat();if(!stat.isFile())throw skipped('unsupported_type');
   // The descriptor must be the entry checked above: a same-uid swap of the file or a checked
   // directory component between the checks and open (or the read) never reaches a protected store.
   if(stat.dev!==checked.dev||stat.ino!==checked.ino)throw fail('native_setup_source_changed');
   // Another name of this inode may sit in a protected store the deny-list cannot see.
   if(stat.nlink>1)throw skipped('hard_link');
   if(stat.size>limit)throw Object.assign(skipped('file_too_large'),{size:stat.size,limit});
   const bytes=await handle.readFile(),after=await fs.lstat(file);if(bytes.length!==stat.size||after.ino!==stat.ino||after.dev!==stat.dev||after.mtimeMs!==stat.mtimeMs||after.ctimeMs!==stat.ctimeMs
    ||await fs.realpath(file)!==real)throw fail('native_setup_source_changed');return bytes;
  }finally{await handle.close();}
 };
 // Destination reads: anything unreadable or oversized cannot be the pinned bytes.
 const readTarget=(file,root,code,limit)=>read(file,root,limit).catch(error=>{if(error.code==='native_setup_source_skipped')throw fail(code);throw error;});
 const roots=[target.webDataDirectory,target.webConfigDirectory,target.opencodeConfigDirectory,target.global.home].map(value=>path.resolve(value));
 for(const root of roots){await fs.mkdir(root,{recursive:true,mode:0o700});const stat=await fs.lstat(root);
  if(!stat.isDirectory()||stat.isSymbolicLink()||await fs.realpath(root)!==root||typeof process.getuid==='function'&&stat.uid!==process.getuid())throw fail('native_setup_target_invalid');
  await fs.chmod(root,0o700);
 }
 const markerBytes=await readTarget(marker,target.webDataDirectory,'native_setup_seed_invalid',MAX_MARKER_BYTES);
 if(markerBytes!==undefined){
  let saved;try{saved=JSON.parse(markerBytes.toString('utf8'));}catch{throw fail('native_setup_seed_invalid');}
  if(!record(saved)||saved.schema!==1||!Array.isArray(saved.files)||saved.files.length>MAX_FILES)throw fail('native_setup_seed_invalid');
  const seen=new Set();
  for(const row of saved.files){
   if(!record(row)||typeof row.path!=='string'||path.resolve(row.path)!==row.path||seen.has(row.path)||typeof row.sha256!=='string'||!/^[a-f0-9]{64}$/.test(row.sha256))throw fail('native_setup_seed_invalid');
   const root=roots.find(value=>row.path.startsWith(value+path.sep));if(!root)throw fail('native_setup_seed_invalid');
   const bytes=await readTarget(row.path,root,'native_setup_seed_changed');if(bytes===undefined||hash(bytes)!==row.sha256)throw fail('native_setup_seed_changed');seen.add(row.path);
  }
  return {...saved,skipped:[],skippedCount:0};
 }
 // Budgets apply to the saved bytes and rows, exactly as verifySeed re-reads them,
 // and to the marker itself; an entry that does not fit is skipped, never pinned.
 const save=async(file,bytes,relative,required=false)=>{
  if(files.some(row=>row.path===file))throw fail('native_setup_destination_conflict');
  const row={path:file,sha256:hash(bytes)},size=Buffer.byteLength(JSON.stringify(row))+1;
  const over=bytes.length>MAX_FILE_BYTES?'file_too_large':files.length>=MAX_FILES?'file_limit':total+bytes.length>MAX_TOTAL_BYTES?'total_limit':pinned+size>MAX_MARKER_BYTES?'marker_limit':undefined;
  // Generated credential, Meridian and owner rows are never budget-skipped.
  if(over&&required)throw Object.assign(fail('native_setup_source_too_large'),{reason:over});
  if(over){skip(relative,over);return;}
  await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});
  const root=roots.find(value=>file.startsWith(value+path.sep));if(!root)throw fail('native_setup_target_invalid');
  const existing=await readTarget(file,root,'native_setup_seed_changed');
  if(existing!==undefined){if(hash(existing)!==hash(bytes))throw fail('native_setup_seed_changed');}
  else await fs.writeFile(file,bytes,{flag:'wx',mode:0o600});
  await fs.chmod(file,0o600);files.push(row);total+=bytes.length;pinned+=size;
 };
 const uid=typeof process.getuid==='function'?process.getuid():undefined,owned=stat=>uid===undefined||stat.uid===uid;
 // A source root (stow-managed ~/.config/opencode, ~/.agents, ...) is canonicalized once:
 // a canonical directory is used as is; a linked one only when it resolves to a uid-owned directory.
 const canonical=new Map(),resolveRoot=root=>{
  if(!canonical.has(root))canonical.set(root,(async()=>{
   let resolved;try{resolved=await fs.realpath(root);}catch(error){if(error.code==='ENOENT'||error.code==='ENOTDIR')return undefined;if(denied(error))return null;throw error;}
   const stat=await fs.stat(resolved);return stat.isDirectory()&&(resolved===root||owned(stat))?resolved:null;
  })());
  return canonical.get(root);
 };
 const home=await resolveRoot(path.resolve(source.home));
 // Never read DevRyan state (control root, fresh seed), the seed target or the v1 web-data secrets back into itself.
 const canonicalAll=values=>Promise.all(values.map(value=>fs.realpath(value).catch(()=>value)));
 const absolute=value=>typeof value==='string'&&path.isAbsolute(value)?[path.resolve(value)]:[];
 const webRoots=await canonicalAll([source.webDataDirectory,source.webConfigDirectory].flatMap(absolute));
 const guarded=await canonicalAll([...roots,path.resolve(environment.XDG_STATE_HOME||path.join(source.home,'.local','state'),'devryan'),...webRoots.flatMap(root=>webSecrets.map(name=>path.join(root,name)))]);
 // Credential, token and browser stores are never setup, whether reached by a link or below one.
 // Account stores (raw OpenCode data, ~/.claude, Meridian accounts) are read only by the exact
 // auth.json/.credentials.json copies, never through another link or copied folder. A store that
 // canonicalizes to HOME, outside it, or onto/above a setup root protects nothing. ~/.claude and
 // ~/.codex stay protected except their top-level shared setup folders and instruction files.
 const fromHome=values=>home?values.map(relative=>path.join(home,relative)):[];
 const setupRoots=await canonicalAll([source.webDataDirectory,source.webConfigDirectory,source.opencodeConfigDirectory,source.opencodeConfigOverlayDirectory,source.opencodeConfigFile&&path.dirname(source.opencodeConfigFile)]
  .flatMap(absolute).concat(fromHome(['.agents/skills','.opencode/skill','.opencode/skills','.config/meridian'])));
 const [claudeRoot,codexRoot]=home?await canonicalAll(fromHome(['.claude','.codex'])):[];
 const otherAccountRoots=home?await canonicalAll([...absolute(source.opencodeDataDirectory),...fromHome(['.config/meridian/accounts'])]):[];
 const otherSecretRoots=await canonicalAll([...fromHome(['.ssh','.gnupg','.aws','.azure','.kube','.docker','.config/gcloud','.config/gh','.password-store','.netrc','Library/Keychains','Library/Cookies',
  '.claude.json','.git-credentials','.npmrc','.pypirc',...['Google','BraveSoftware','Firefox','Microsoft Edge','Arc'].map(name=>'Library/Application Support/'+name)]),
  // DevRyan/OpenChamber Electron userData (and its -runtime-service sibling, @openchamber, legacy Tauri data).
  ...(home?(await fs.readdir(path.join(home,'Library','Application Support')).catch(()=>[])).filter(name=>/devryan|openchamber/i.test(name)).map(name=>path.join(home,'Library','Application Support',name)):[]),
  ...absolute(environment.XDG_CONFIG_HOME).map(value=>path.join(value,'gh')),...absolute(environment.GH_CONFIG_DIR),...absolute(environment.CLOUDSDK_CONFIG)]);
 const accountRoots=[...otherAccountRoots,...claudeRoot?[claudeRoot]:[]];
 const usable=(values,protectedRoots)=>values.filter(value=>value!==home&&inside(home,value)&&!protectedRoots.some(root=>inside(value,root)));
 const secrets=usable([...otherSecretRoots,...codexRoot?[codexRoot]:[]],[...setupRoots,...accountRoots]);
 // A ~/.claude or ~/.codex that canonicalizes onto or into another store never lifts that store's protection.
 const others=[...otherSecretRoots,...otherAccountRoots].filter(store=>store!==home&&inside(home,store));
 // The v1 web data/config is read only from its own roots by the exact setup copies below; a
 // link reaching it (vaults, keys, bots, multi-user, runtime trees) is protected. One that is HOME
 // or above another setup root protects nothing beyond webSecrets.
 const web=webRoots.filter(root=>root!==home&&!setupRoots.some(other=>!webRoots.includes(other)&&inside(root,other)));
 const accounts=usable(accountRoots,setupRoots),tools=[claudeRoot,codexRoot].filter(root=>root&&root!==home&&!others.some(store=>inside(store,root)));
 const sharedDirs=new Set(['skills','commands','agents','prompts','output-styles']),sharedFiles=new Set(['CLAUDE.md','AGENTS.md']);
 // The ~/.claude or ~/.codex root that admits this canonical file as shared setup, if any.
 const shared=(file,stat)=>tools.find(root=>{if(file===root||!inside(root,file))return false;const [top,...rest]=path.relative(root,file).split(path.sep);
  return sharedDirs.has(top)&&(rest.length>0||stat.isDirectory())||sharedFiles.has(top)&&!rest.length&&stat.isFile();});
 // lstat one source entry. A symlink is followed only into the canonical HOME, to a
 // uid-owned file or directory that is neither HOME itself nor an ancestor of the copied
 // root (`tree`); reads then walk from HOME with O_NOFOLLOW. Only `account` reads enter account stores.
 // An exact web setup path (no `tree`) linked below its own web root keeps that root and is web
 // setup again; never onto/above a web root or into a web root nested in it, and webSecrets stay guarded.
 const entry=async(file,relative,readRoot,tree,account)=>{
  let stat;try{stat=await fs.lstat(file);}catch(error){if(error.code==='ENOENT'||error.code==='ENOTDIR')return undefined;if(denied(error)){skip(relative,'unreadable');return null;}throw error;}
  if(stat.isSymbolicLink()){
   let resolved;try{resolved=await fs.realpath(file);stat=await fs.lstat(resolved);}catch{skip(relative,'symlink_unresolved');return null;}
   if(!home||!inside(home,resolved)){skip(relative,'symlink_outside_home');return null;}
   if(!owned(stat)){skip(relative,'symlink_foreign_owner');return null;}
   if(resolved===home||tree&&tree.startsWith(resolved+path.sep)){skip(relative,'protected');return null;}
   if(tree||!webRoots.includes(readRoot)||!inside(readRoot,resolved)||webRoots.some(root=>inside(resolved,root)||root!==readRoot&&!inside(root,readRoot)&&inside(root,resolved)))readRoot=home;file=resolved;
  }else{
   // Its parent is canonical: on case-insensitive volumes checks and reads use the stored case (~/.SSH is ~/.ssh).
   const real=await fs.realpath(file).catch(()=>file);
   if(real!==file){if(path.dirname(real)!==path.dirname(file)||!await fs.lstat(real).then(item=>item.dev===stat.dev&&item.ino===stat.ino,()=>false))throw fail('native_setup_source_changed');file=real;}
  }
  const open=shared(file,stat),blocked=root=>inside(root,file)&&root!==open;
  if(guarded.some(root=>inside(root,file))||secrets.some(blocked)||!account&&accounts.some(blocked)||!webRoots.includes(readRoot)&&web.some(root=>inside(root,file))||browserStores.has(path.basename(file))){skip(relative,'protected');return null;}
  if(!stat.isFile()&&!stat.isDirectory()){skip(relative,'unsupported_type');return null;}
  return {file,stat,readRoot,tree};
 };
 const place=(item,relative,destination,transform,{records=false,sink,required,shadow}={},trail=new Set())=>located(relative,async()=>{
  if(exhausted)return;
  if(++visited>MAX_VISITED){exhausted=true;skip(relative,'visit_limit');return;}
  if(item.stat.isDirectory()){
   if(sink){skip(relative,'unsupported_type');return;}
   const id=item.stat.dev+':'+item.stat.ino;if(trail.has(id)){skip(relative,'symlink_cycle');return;}
   let names;try{names=(await fs.readdir(item.file)).sort();}catch(error){if(denied(error)){skip(relative,'unreadable');return;}throw error;}
   const nested=new Set(trail).add(id);
   for(const name of names){if(name.includes('\0'))throw fail('native_setup_source_invalid');if(osMetadata(name)||shadow?.has(name))continue;
    // Record folders import only their top-level *.json files; nested trees are not setup.
    if(records&&!name.endsWith('.json'))continue;
    const childRelative=path.join(relative,name);if(excluded.has(name)){skip(childRelative,'excluded');continue;}
    const child=await entry(path.join(item.file,name),childRelative,item.readRoot,item.tree);if(!child||records&&child.stat.isDirectory())continue;
    await place(child,childRelative,path.join(destination,name),transform,{},nested);}return;
  }
  let bytes;try{bytes=await read(item.file,item.readRoot);}catch(error){if(error.code!=='native_setup_source_skipped')throw error;
   // A required account input is never skipped or truncated for size: the launch refuses with its name and size.
   if(required&&error.reason==='file_too_large')throw Object.assign(fail('native_setup_source_too_large'),{reason:error.reason,size:error.size,limit:error.limit});
   skip(relative,error.reason);return;}
  if(bytes===undefined)return;
  if(sink)return sink(bytes);
  let result=bytes;
  if(transform){const parsed=parseJSON(bytes);if(parsed===undefined)throw fail('native_setup_json_invalid');result=Buffer.from(JSON.stringify(transform(parsed))+'\n');}
  await save(destination,result,relative,required);
 });
 const copy=(root,relative,destination,transform,options)=>located(relative,async()=>{
  if(exhausted||typeof root!=='string')return;
  const base=await resolveRoot(path.resolve(root));if(base===null)skip(relative,'root_unusable');if(!base)return;
  let item={file:base,readRoot:base};const parts=relative.split('/');
  for(const [index,part] of parts.entries()){
   const next=await entry(path.join(item.file,part),parts.slice(0,index+1).join('/'),item.readRoot,undefined,options?.account);if(!next)return;
   if(index<parts.length-1&&!next.stat.isDirectory())return;item=next;
  }
  await place({...item,tree:await fs.realpath(item.file)},relative,destination,transform,options);
 });
 // One source file through the same entry rules, read into memory.
 const load=async(root,relative,{account,required}={})=>{let bytes;await copy(root,relative,undefined,undefined,{sink:value=>{bytes=value;},account,required});return bytes;};
 // Generated credential, Meridian and owner rows first (fail closed if they cannot fit),
 // then exact records and single files, record folders and bulk folders last.
 await copy(source.home,'.claude/.credentials.json',path.join(target.global.home,'.claude','.credentials.json'),undefined,{account:true,required:true});
 // Meridian settings are written once; an exported default profile wins over the saved one.
 const meridianSettings='.config/meridian/settings.json',defaultProfile=typeof environment.MERIDIAN_DEFAULT_PROFILE==='string'?environment.MERIDIAN_DEFAULT_PROFILE.trim():'';
 if(defaultProfile.length>256)skip('MERIDIAN_DEFAULT_PROFILE','default_profile_invalid');
 if(!defaultProfile||defaultProfile.length>256)await copy(source.home,meridianSettings,path.join(target.global.home,meridianSettings),undefined,{required:true});
 else await located(meridianSettings,async()=>{
  const bytes=await load(source.home,meridianSettings,{required:true}),saved=bytes===undefined?{}:parseJSON(bytes);
  if(!record(saved))skip(meridianSettings,'json_invalid');
  await save(path.join(target.global.home,meridianSettings),Buffer.from(JSON.stringify({...record(saved)?saved:{},activeProfile:defaultProfile})+'\n'),meridianSettings,true);
 });
 // Loader tolerance: an empty or unparsable export falls back to disk; an unparsable file is no profiles.
 const profileFile='.config/meridian/profiles.json';
 await located(profileFile,async()=>{
  let label='MERIDIAN_PROFILES',profiles;const exported=environment.MERIDIAN_PROFILES;
  if(typeof exported==='string'&&exported.trim()){profiles=Buffer.byteLength(exported)>MAX_FILE_BYTES?undefined:parseJSON(exported);if(profiles===undefined)skip(label,'profiles_invalid');}
  if(profiles===undefined){label=profileFile;const bytes=await load(source.home,profileFile,{required:true});if(bytes===undefined)return;profiles=parseJSON(bytes);if(profiles===undefined){skip(label,'profiles_invalid');return;}}
  const relocated=await relocateNativeSetupProfiles({profiles,sourceHome:source.home,targetHome:target.global.home,onSkip:({reason,...detail})=>skip(label,reason,detail),
   copyAccount:async(account,destination)=>{await fs.mkdir(destination,{recursive:true,mode:0o700});
    await copy(source.home,path.join(path.relative(source.home,account),'.credentials.json'),path.join(destination,'.credentials.json'),undefined,{account:true,required:true});}});
  await save(path.join(target.global.home,profileFile),Buffer.from(JSON.stringify(relocated)+'\n'),profileFile,true);
 });
 await located('auth.json',async()=>{const auth=await load(source.opencodeDataDirectory,'auth.json',{account:true,required:true});
  if(auth!==undefined){const parsed=parseJSON(auth);if(parsed===undefined)throw fail('native_setup_credentials_invalid');
   const projected=projectNativeSetupCredentials(parsed,{onSkip:detail=>skip('auth.json',detail.reason,detail.integrationID?{integrationID:detail.integrationID}:{})});
   await save(path.join(target.opencodeConfigDirectory,NATIVE_SETUP_CREDENTIAL_FILE),Buffer.from(JSON.stringify(projected)+'\n'),'auth.json',true);}});
 if(captureLogicalSetup)await located('native-setup-local-owners.json',async()=>{
  const logical=await captureLogicalSetup();
  if(!record(logical)||Object.keys(logical).some(key=>!['localOwners'].includes(key))||!record(logical.localOwners))throw fail('native_setup_logical_invalid');
  const {validateSetupOwners}=await import('../../multi-user/vault.js');
  const owners=validateSetupOwners(logical.localOwners);
  await save(path.join(target.webDataDirectory,'native-setup-local-owners.json'),Buffer.from(JSON.stringify({schema:1,owners})+'\n'),'native-setup-local-owners.json',true);
 });
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
 // Project records only: projects/<id>/plans/** are v1 conversation artifacts and stay in place.
 await copy(source.webConfigDirectory,'projects',path.join(target.webConfigDirectory,'projects'),value=>{if(!record(value))throw fail('native_setup_json_invalid');return projectNativeSetupState(value);},{records:true});
 // OpenCode loads its global config directory and then OPENCODE_CONFIG_DIR over it; both seed the one
 // target directory. Layers are listed highest precedence first; an overlay equal to the global directory is one layer.
 const configTarget=target.opencodeConfigDirectory,globalConfig=source.opencodeConfigDirectory,overlayInput=source.opencodeConfigOverlayDirectory;
 const overlay=typeof overlayInput==='string'&&path.isAbsolute(overlayInput)&&path.resolve(overlayInput)!==path.resolve(globalConfig)
  &&await resolveRoot(path.resolve(overlayInput))!==undefined&&await resolveRoot(path.resolve(overlayInput))!==await resolveRoot(path.resolve(globalConfig))?path.resolve(overlayInput):undefined;
 const layers=overlay?[overlay,globalConfig]:[globalConfig],supplied=relative=>files.some(row=>row.path===path.join(configTarget,relative));
 const configNames=['config.json','opencode.json','opencode.jsonc'];
 if(!overlay)for(const name of configNames)await copy(globalConfig,name,path.join(configTarget,name));
 else{
  // One layer with configuration files keeps their bytes; two layers merge in OpenCode's order
  // (global config.json, opencode.json, opencode.jsonc, then the same names in OPENCODE_CONFIG_DIR) into opencode.json.
  const loaded=[];for(const root of [globalConfig,overlay])for(const name of configNames){const bytes=await load(root,name);if(bytes!==undefined)loaded.push({root,name,bytes});}
  if(new Set(loaded.map(row=>row.root)).size<2)for(const row of loaded)await located(row.name,()=>save(path.join(configTarget,row.name),row.bytes,row.name));
  else await located('opencode.json',async()=>{
   const {parseConfigJsonc}=await import('../jsonc-config.js');let merged={};
   for(const row of loaded){let value;try{value=parseConfigJsonc(row.bytes.toString('utf8'),row.name);}catch{throw Object.assign(fail('native_setup_json_invalid'),{relativePath:row.name});}merged=mergeConfigLayer(merged,value);}
   await save(path.join(configTarget,'opencode.json'),Buffer.from(JSON.stringify(merged,null,2)+'\n'),'opencode.json');
  });
 }
 // Other exact files: the highest layer that provides one of a group's names supplies the whole group (Slim JSON/JSONC is one setting).
 for(const group of [['oh-my-opencode-slim.json','oh-my-opencode-slim.jsonc'],['AGENTS.md'],['.openchamber/config.json'],['ponytail/config.json']])
  for(const root of layers){for(const name of group)await copy(root,name,path.join(configTarget,name));if(group.some(supplied))break;}
 if(source.opencodeConfigFile){
  // The selected custom layer follows ordinary user/project layers. It must
  // neither replace config.json nor create two hashes for one destination.
  const custom=path.join(target.opencodeConfigDirectory,'native-custom-config.json');
  await copy(path.dirname(source.opencodeConfigFile),path.basename(source.opencodeConfigFile),custom);
 }
 await copy(source.webDataDirectory,'project-icons',path.join(target.webDataDirectory,'project-icons'));
 await copy(source.webConfigDirectory,'themes',path.join(target.webConfigDirectory,'themes'));
 // Folders union their layers; a same-named top-level entry (agent file, skill folder) comes whole from the highest layer.
 for(const folder of ['agent','agents','command','commands','prompts','skills','skill']){
  const destination=path.join(configTarget,folder),shadow=new Set();
  for(const root of layers){
   await copy(root,folder,destination,undefined,{shadow});if(supplied(folder))break;
   for(const row of files)if(row.path.startsWith(destination+path.sep))shadow.add(path.relative(destination,row.path).split(path.sep)[0]);
  }
 }
 for(const relative of ['.agents/skills','.opencode/skill','.opencode/skills'])await copy(source.home,relative,path.join(target.global.home,relative));
 const saved={schema:1,files};await saveBundleJSON(marker,saved);
 if(skippedCount)console.warn(`[native-setup] seed skipped ${skippedCount} setup entries (${Object.entries(reasons).map(([reason,count])=>reason+'='+count).join(', ')}): `
  +skippedRows.slice(0,5).map(row=>row.relativePath).join(', ')+(skippedCount>5?', ...':''));
 return {...saved,skipped:skippedRows,skippedCount};
}
