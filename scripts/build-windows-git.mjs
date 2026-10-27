import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {assertWindowsBinaryArchitecture} from './build-windows-reviewed-libsql.mjs';

const root=path.resolve(fileURLToPath(new URL('../',import.meta.url)));
const AdmZip=createRequire(path.join(root,'packages/web/package.json'))('adm-zip');
const fail=code=>Object.assign(new Error(code),{code});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export const WINDOWS_GIT_PINS=Object.freeze({
 x64:Object.freeze({protocol:'devryan.windows-mingit/1',version:'2.56.0.windows.2',arch:'x64',directory:'git',executable:'git/cmd/git.exe',
  archiveUrl:'https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.2/MinGit-2.56.0.2-64-bit.zip',
  archiveSha256:'da35e72aa21c005a5a0d298cfbae110bc1609a815730ea0dde84b01a1b3cd3be',archiveBytes:39806486,files:373,backend:'ucrt64/bin/git.exe',inventorySha256:'c84c6a023e2d2cc362c6ae7159dcd517a524cd39593ad0a72051cc5945b3ce41'}),
 arm64:Object.freeze({protocol:'devryan.windows-mingit/1',version:'2.56.0.windows.2',arch:'arm64',directory:'git',executable:'git/cmd/git.exe',
  archiveUrl:'https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.2/MinGit-2.56.0.2-arm64.zip',
  archiveSha256:'38b33dc6024026e3315cf88ab2cfea65205bbd7bb3a8e824bd21c8ad4fe609a7',archiveBytes:37936336,files:499,backend:'clangarm64/bin/git.exe',inventorySha256:'496c2ee6a614be4581a1d9532389b10b9e40f67597cda6cde4499c3eda8fa571'}),
});
export function windowsGitMetadata(arch){
 if(!Object.hasOwn(WINDOWS_GIT_PINS,arch))throw fail('windows_git_architecture_invalid');const pin=WINDOWS_GIT_PINS[arch];
 const {protocol,version,directory,executable,archiveUrl,archiveSha256}=pin;
 return {protocol,version,arch,directory,executable,archiveUrl,archiveSha256};
}
const safeName=name=>{
 if(!name||name.length>1024||/[\\:\u0000-\u001f]/.test(name)||name.startsWith('/'))throw fail('windows_git_archive_path_invalid');
 const parts=name.replace(/\/$/,'').split('/');
 if(parts.some(part=>!part||part==='.'||part==='..'||/[. ]$/.test(part)||/^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(part)))throw fail('windows_git_archive_path_invalid');
 return name;
};
/** Bounded ZIP decoder only; it confers no trust. Hydration additionally
 * requires the exact published whole-archive digest before decoding anything. */
export function readWindowsGitZip(bytes){
 if(!Buffer.isBuffer(bytes)||bytes.length<22||bytes.length>64*1024*1024)throw fail('windows_git_archive_bound');
 let entries;try{entries=new AdmZip(bytes).getEntries();}catch{throw fail('windows_git_archive_structure_invalid');}
 if(entries.length<1||entries.length>4096)throw fail('windows_git_archive_structure_invalid');
 const rows=[],names=new Set();let total=0;
 for(const entry of entries){
  const name=safeName(entry.entryName),directory=entry.isDirectory,header=entry.header,kind=(entry.attr>>>16)&0o170000;
  if(names.has(name.toLowerCase()))throw fail('windows_git_archive_path_invalid');names.add(name.toLowerCase());
  if(![0,0x800].includes(header.flags)||![0,8].includes(header.method)||header.diskNumStart
   ||!Number.isSafeInteger(header.size)||header.size<0||header.size>16*1024*1024||header.compressedSize>64*1024*1024
   ||kind!==0&&kind!==(directory?0o040000:0o100000)||directory&&header.size!==0)throw fail('windows_git_archive_type_invalid');
  total+=header.size;if(total>128*1024*1024)throw fail('windows_git_archive_bound');
  let contents;try{contents=entry.getData();}catch{throw fail('windows_git_archive_data_invalid');}
  if(contents.length!==header.size)throw fail('windows_git_archive_data_invalid');
  rows.push({name,directory,contents});
 }
 return rows;
}

async function inventory(directory){
 const files=[],directories=new Set();
 const walk=async(relative='')=>{
  for(const entry of(await fs.readdir(path.join(directory,relative),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
   const name=relative?`${relative}/${entry.name}`:entry.name,file=path.join(directory,name);safeName(name);
   const stat=await fs.lstat(file);if(stat.isSymbolicLink()||await fs.realpath(file)!==file)throw fail('windows_git_payload_invalid');
   if(stat.isDirectory()){directories.add(name);await walk(name);}
   else{if(!stat.isFile()||stat.nlink!==1||stat.size>16*1024*1024||files.length>=4096)throw fail('windows_git_payload_invalid');
    const bytes=await fs.readFile(file);files.push({path:`git/${name}`,size:bytes.length,sha256:hash(bytes),mode:0o644});}
  }
 };await walk();const inferred=new Set();for(const row of files){const parts=row.path.slice(4).split('/');parts.pop();while(parts.length){inferred.add(parts.join('/'));parts.pop();}}
 if(directories.size!==inferred.size||[...directories].some(name=>!inferred.has(name)))throw fail('windows_git_payload_invalid');
 return files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
}
async function verify(directory,pin,expected){
 const rows=await inventory(directory);
 if(rows.length!==pin.files||hash(JSON.stringify(rows))!==pin.inventorySha256||JSON.stringify(rows)!==JSON.stringify(expected))throw fail('windows_git_payload_invalid');
 for(const file of ['cmd/git.exe',pin.backend])assertWindowsBinaryArchitecture(await fs.readFile(path.join(directory,file)),pin.arch);
 if(!rows.some(row=>row.path==='git/LICENSE.txt'&&row.size>0))throw fail('windows_git_license_missing');
 return rows;
}
export async function hydrateWindowsGit({repository=root,arch,fetchImpl=fetch}={}){
 if(!Object.hasOwn(WINDOWS_GIT_PINS,arch))throw fail('windows_git_architecture_invalid');const pin=WINDOWS_GIT_PINS[arch];
 if(await fs.realpath(repository)!==repository)throw fail('windows_git_root_invalid');
 const parent=path.join(repository,'.cache/windows-native',arch,'git-resource'),payload=path.join(parent,'payload'),directory=path.join(payload,'git'),evidencePath=path.join(payload,'inventory.json');
 await fs.mkdir(parent,{recursive:true});if(await fs.realpath(parent)!==parent)throw fail('windows_git_root_invalid');
 try{
  const evidence=JSON.parse(await fs.readFile(evidencePath,'utf8'));
  if(JSON.stringify(evidence.windowsGit)!==JSON.stringify(windowsGitMetadata(arch))||!Array.isArray(evidence.files))throw fail('windows_git_payload_invalid');
  const files=await verify(directory,pin,evidence.files);return {directory,windowsGit:evidence.windowsGit,files};
 }catch(error){if(error.code!=='ENOENT')throw error;}
 const scratch=await fs.mkdtemp(path.join(parent,'.download-'));
 try{
  const response=await fetchImpl(pin.archiveUrl,{redirect:'follow',signal:AbortSignal.timeout(120000)});
  if(!response.ok||!response.body)throw fail('windows_git_download_failed');
  const chunks=[];let length=0;for await(const chunk of response.body){const bytes=Buffer.from(chunk);length+=bytes.length;if(length>pin.archiveBytes)throw fail('windows_git_download_bound');chunks.push(bytes);}
  const archive=Buffer.concat(chunks);if(archive.length!==pin.archiveBytes||hash(archive)!==pin.archiveSha256)throw fail('windows_git_archive_digest_invalid');
  const rows=readWindowsGitZip(archive);if(rows.filter(row=>!row.directory).length!==pin.files)throw fail('windows_git_archive_inventory_invalid');
  const stagedPayload=path.join(scratch,'payload');await fs.mkdir(stagedPayload);
  const extracted=path.join(stagedPayload,'git');await fs.mkdir(extracted);
  for(const row of rows){const destination=path.join(extracted,row.name);if(row.directory)await fs.mkdir(destination,{recursive:true});
   else{await fs.mkdir(path.dirname(destination),{recursive:true});await fs.writeFile(destination,row.contents,{flag:'wx',mode:0o644});}}
  const files=await inventory(extracted);await verify(extracted,pin,files);
  const windowsGit=windowsGitMetadata(arch);
  await fs.writeFile(path.join(stagedPayload,'inventory.json'),JSON.stringify({windowsGit,files},null,2)+'\n',{flag:'wx',mode:0o600});
  // Inventory and complete payload become visible together. A crash before
  // this rename leaves only an unpublished scratch directory, never a half cache.
  await fs.rename(stagedPayload,payload);
  return {directory,windowsGit,files};
 }finally{await fs.rm(scratch,{recursive:true,force:true});}
}
async function qualify(){
 if(process.argv.length!==2||process.platform!=='win32'||!WINDOWS_GIT_PINS[process.arch])throw fail('windows_git_native_host_required');
 const result=await hydrateWindowsGit({arch:process.arch}),parent=path.dirname(result.directory),home=path.join(parent,`.version-${randomUUID()}`);
 await fs.mkdir(home);try{
  const windows=process.env.SystemRoot||process.env.SYSTEMROOT;if(typeof windows!=='string'||!path.win32.isAbsolute(windows))throw fail('windows_git_loader_root_invalid');
  const env={SystemRoot:windows,WINDIR:windows,HOME:home,USERPROFILE:home,TMP:home,TEMP:home,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'NUL',GIT_CONFIG_SYSTEM:'NUL',GIT_TERMINAL_PROMPT:'0'};
  const version=await promisify(execFile)(path.join(result.directory,'cmd/git.exe'),['--version'],{cwd:result.directory,env,windowsHide:true,timeout:30000,maxBuffer:4096});
  if(version.stdout.trim()!=='git version 2.56.0.windows.2'||version.stderr.trim())throw fail('windows_git_version_invalid');
  await verify(result.directory,WINDOWS_GIT_PINS[process.arch],result.files);
  const report=JSON.stringify({protocol:'devryan.windows-mingit-qualification/1',arch:process.arch,windowsGit:result.windowsGit,status:'passed',versionOutputSha256:hash(version.stdout),admission:false})+'\n',reportPath=path.join(parent,'qualification.json');
  try{await fs.writeFile(reportPath,report,{flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;const stat=await fs.lstat(reportPath);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4096||await fs.readFile(reportPath,'utf8')!==report)throw fail('windows_git_qualification_conflict');}
 }finally{await fs.rm(home,{recursive:true,force:true});}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))qualify().catch(error=>{console.error(/^windows_git_[a-z_]+$/.test(error.code??'')?error.code:'windows_git_qualification_failed');process.exitCode=1;});
