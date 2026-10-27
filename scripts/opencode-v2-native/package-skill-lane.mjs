import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {parseMdFile} from '../../packages/web/server/lib/opencode/shared.js';
import {readReviewedSkillResource,resolveReviewedSkillAlias} from '../../packages/web/server/lib/opencode/runtime-host/reviewed-skills.js';

const hash=value=>createHash('sha256').update(value).digest('hex');
const relative=value=>typeof value==='string'&&value.length>0&&!value.includes('\\')&&!path.isAbsolute(value)
  &&value.split('/').every(part=>part&&part!=='.'&&part!=='..'&&part!=='.git');
const targetRoot=(launch,kind)=>kind==='agents'?path.join(launch.global.home,'.agents/skills'):path.join(launch.opencodeConfigDirectory,'skills');
const checked=async(file,row)=>{
  assert.equal(await fs.realpath(file),file,'Skill data path changed');
  const handle=await fs.open(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try{const stat=await handle.stat();assert.ok(stat.isFile());assert.equal(stat.size,row.bytes);
    const bytes=await handle.readFile();assert.equal(hash(bytes),row.sha256,'Skill data bytes changed');return bytes;
  }finally{await handle.close();}
};
const readData=async root=>{
  const manifest=JSON.parse(await fs.readFile(path.join(root,'manifest.json'),'utf8'));
  assert.equal(manifest.schema,1);assert.match(manifest.inventorySha256,/^[a-f0-9]{64}$/);
  assert.ok(Array.isArray(manifest.files)&&manifest.files.length>0&&manifest.files.length<=8192);
  const seen=new Set();let total=0;
  for(const row of manifest.files){
    assert.ok(['agents','opencode'].includes(row.root)&&['skill','support'].includes(row.kind)&&relative(row.relative));
    assert.ok(Number.isSafeInteger(row.bytes)&&row.bytes>=0&&row.bytes<=4*1024*1024);assert.match(row.sha256,/^[a-f0-9]{64}$/);
    const key=row.root+'/'+row.relative;assert.ok(!seen.has(key));seen.add(key);total+=row.bytes;
  }
  assert.ok(total<=64*1024*1024);return manifest;
};

/** Explicit authorized inventory only. This copies data; it never imports or runs a skill. */
export async function capturePackageSkillData({inventoryPath,outputRoot}){
  const bytes=await fs.readFile(inventoryPath),inventory=JSON.parse(bytes.toString('utf8'));
  assert.ok(Array.isArray(inventory.skills));const files=[];
  for(const row of inventory.skills){
    assert.ok(relative(row.relative));
    const root=row.root.endsWith('/.agents/skills')?'agents':row.root.endsWith('/.config/opencode/skills')?'opencode':null;
    assert.ok(root,'Unreviewed personal skill source');assert.equal(row.path,path.join(row.root,row.relative));
    files.push({root,relative:row.relative,kind:row.kind,bytes:row.bytes,sha256:row.sha256});
  }
  await fs.mkdir(outputRoot,{recursive:false,mode:0o700});
  // Validate the entire captured inventory before writing any skill data.
  await fs.writeFile(path.join(outputRoot,'manifest.json'),JSON.stringify({schema:1,inventorySha256:hash(bytes),files})+'\n',{flag:'wx',mode:0o600});
  await readData(outputRoot);
  for(let index=0;index<files.length;index++){
    const data=await checked(inventory.skills[index].path,files[index]);
    const file=path.join(outputRoot,files[index].root,files[index].relative);
    await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});await fs.writeFile(file,data,{flag:'wx',mode:0o600});
  }
  return {files:files.length,skills:files.filter(row=>row.kind==='skill').length,inventorySha256:hash(bytes)};
}

/** Seed source data before the real baseline/candidate checkpoint copy. */
export async function preparePackageSkillData({dataRoot,sourceLaunch}){
  const data=await readData(dataRoot);
  for(const row of data.files){
    const bytes=await checked(path.join(dataRoot,row.root,row.relative),row);
    const target=path.join(targetRoot(sourceLaunch,row.root),row.relative);
    await fs.mkdir(path.dirname(target),{recursive:true,mode:0o700});await fs.writeFile(target,bytes,{flag:'wx',mode:0o600});
  }
  return data;
}

export function packageSkillsForLaunch(data,launch){
  return data.files.filter(row=>row.kind==='skill').map(row=>{
    const file=path.join(targetRoot(launch,row.root),row.relative),parsed=parseMdFile(file);
    assert.equal(typeof parsed.frontmatter.name,'string');assert.ok(parsed.frontmatter.name.trim());
    return {name:parsed.frontmatter.name.trim(),description:parsed.frontmatter.description??'',path:file,source:row.root,scope:'user'};
  });
}

export async function runCompiledSkillChecks({data,runtimeOwner,launch,invoke,directory,onCase}){
  const snapshot=runtimeOwner.getConfigurationSnapshot();assert.ok(snapshot);
  const configRoot=await fs.realpath(launch.global.config);
  assert.equal(configRoot,launch.global.config,'Selected native config root changed');
  const expected=data.files.filter(row=>row.kind==='skill');let resourceChecks=0;
  for(const location of snapshot.locations){
    assert.equal(location.skills.length,expected.length,'Copied personal skill was omitted or duplicated');
    for(const row of data.files){
      const file=path.join(targetRoot(launch,row.root),row.relative);await checked(file,row);
      const owners=location.skills.filter(skill=>skill.path===file||skill.resources.some(resource=>resource.canonicalPath===file));
      // Files outside any SKILL.md directory are inventory data, not skill grants.
      for(const skill of owners){
        const relativePath=path.relative(path.dirname(skill.path),file).split(path.sep).join('/');
        const bytes=await readReviewedSkillResource(snapshot,{snapshotDigest:snapshot.digest,directory:location.directory,skillID:skill.id,relativePath});
        assert.equal(hash(bytes),row.sha256);resourceChecks++;
      }
      if(row.kind==='skill')assert.ok(owners.some(skill=>skill.path===file),'Missing original skill entrypoint');
    }
  }
  const selected=snapshot.locations.find(location=>location.directory===directory);assert.ok(selected);
  let invoked=0,supportReads=0;
  for(const skill of selected.skills){
    assert.equal(resolveReviewedSkillAlias(snapshot,directory,skill.id),skill.id);
    const call=await invoke({id:`personal-skill-${invoked++}`,tool:'skill',input:{id:skill.id},direct:true});
    assert.ok(call.state.output.includes(skill.content),'Native skill output changed original body');
    const support=skill.resources.find(row=>/\.(?:md|txt|json|csv|py|sh)$/.test(row.relativePath)&&row.size>0&&row.size<24*1024);
    if(support){
      const configRelative=path.relative(configRoot,support.canonicalPath);
      const approveExternal=path.isAbsolute(configRelative)||configRelative==='..'||configRelative.startsWith('..'+path.sep);
      const read=await invoke({id:`personal-support-${supportReads++}`,tool:'read',input:{path:support.canonicalPath},direct:true,approveExternal});
      assert.equal(read.state.status,'completed');
      const original=await checked(support.canonicalPath,{bytes:support.size,sha256:support.sha256});
      const first=original.toString('utf8').split(/\r?\n/).find(line=>line.trim().length>8);
      if(first)assert.ok(read.state.output.includes(first),'Native resource output omitted original bytes');
    }
  }
  const result={id:'compiled-personal-skill-bodies-and-resources',status:'passed',inventorySha256:data.inventorySha256,
    skills:invoked,supportReads,resourceChecks,locations:snapshot.locations.length,
    source:'real-bundle-copy-snapshot-hash-guards-and-compiled-native-skill-read-tools'};
  onCase(result);return result;
}
