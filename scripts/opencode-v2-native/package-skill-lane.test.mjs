import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {capturePackageSkillData,preparePackageSkillData,packageSkillsForLaunch,runCompiledSkillChecks} from './package-skill-lane.mjs';
import {captureReviewedSkill} from '../../packages/web/server/lib/opencode/runtime-host/reviewed-skills.js';

test('captured personal skills preserve nested original data and refuse changed bytes or path escapes',async()=>{
  const base=path.resolve('.cache/v2-validation');await fs.mkdir(base,{recursive:true});
  const root=await fs.mkdtemp(path.join(base,'package-skills-'));
  try{
    const source=path.join(root,'original/.agents/skills'),outputRoot=path.join(root,'captured');
    const rows=[['Group/Exact/SKILL.md','skill','---\nname: Exact original\n---\nOriginal body\n'],['Group/Exact/references/data.txt','support','Original supporting bytes\n']];
    const skills=[];
    for(const [relative,kind,content]of rows){
      const file=path.join(source,relative);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,content);
      skills.push({root:source,path:file,relative,kind,bytes:Buffer.byteLength(content),sha256:createHash('sha256').update(content).digest('hex')});
    }
    const inventoryPath=path.join(root,'inventory.json');await fs.writeFile(inventoryPath,JSON.stringify({skills}));
    assert.equal((await capturePackageSkillData({inventoryPath,outputRoot})).skills,1);
    const sourceLaunch={global:{home:path.join(root,'fixture/home'),config:path.join(root,'fixture/config')},opencodeConfigDirectory:path.join(root,'fixture/config')};
    await fs.mkdir(sourceLaunch.global.config,{recursive:true});
    const data=await preparePackageSkillData({dataRoot:outputRoot,sourceLaunch});
    assert.equal(packageSkillsForLaunch(data,sourceLaunch)[0].name,'Exact original');
    assert.equal(await fs.readFile(path.join(sourceLaunch.global.home,'.agents/skills/Group/Exact/references/data.txt'),'utf8'),rows[1][2]);
    const directory=path.join(root,'project');await fs.mkdir(directory);
    const skill=await captureReviewedSkill({directory,skill:packageSkillsForLaunch(data,sourceLaunch)[0],allowedRoots:[sourceLaunch.global.home],
      parseMarkdown:()=>({body:'Original body\n',frontmatter:{name:'Exact original'}})});
    const snapshot={digest:'a'.repeat(64),locations:[{directory,skills:[skill]}]},calls=[],cases=[];
    await runCompiledSkillChecks({data,runtimeOwner:{getConfigurationSnapshot:()=>snapshot},launch:sourceLaunch,directory,onCase:row=>cases.push(row),
      invoke:async scenario=>{calls.push(scenario);return {state:{status:'completed',output:scenario.tool==='skill'?skill.content:rows[1][2]}};}});
    assert.equal(calls.length,2);assert.deepEqual(calls[1],{id:'personal-support-0',tool:'read',input:{path:skill.resources[0].canonicalPath},direct:true,approveExternal:true});
    assert.equal(cases[0].supportReads,1);assert.equal(cases[0].resourceChecks,2);
    await fs.writeFile(path.join(outputRoot,'agents',rows[1][0]),'Changed supporting bytes\n');
    await assert.rejects(preparePackageSkillData({dataRoot:outputRoot,sourceLaunch:{global:{home:path.join(root,'second/home')},opencodeConfigDirectory:path.join(root,'second/config')}}),/Skill data bytes changed|strictly equal/);
    skills[0].relative='../escape/SKILL.md';await fs.writeFile(inventoryPath,JSON.stringify({skills}));
    await assert.rejects(capturePackageSkillData({inventoryPath,outputRoot:path.join(root,'escaped')}));
    await assert.rejects(fs.stat(path.join(root,'escaped')),error=>error.code==='ENOENT');
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('support permission expectations distinguish canonical config data from home and prefix neighbors',async()=>{
  const base=path.resolve('.cache/v2-validation');await fs.mkdir(base,{recursive:true});
  const root=await fs.mkdtemp(path.join(base,'package-skill-permissions-'));
  try{
    for(const [name,kind,homeName,approveExternal]of [['config','opencode','home',false],['home','agents','home',true],['prefix-neighbor','agents','config-neighbor',true]]){
      const fixture=path.join(root,name),directory=path.join(fixture,'project');
      const launch={global:{home:path.join(fixture,homeName),config:path.join(fixture,'config')},opencodeConfigDirectory:path.join(fixture,'config')};
      await fs.mkdir(launch.global.config,{recursive:true});await fs.mkdir(directory);
      const dataRoot=kind==='opencode'?path.join(launch.opencodeConfigDirectory,'skills'):path.join(launch.global.home,'.agents/skills');
      const contents=[['Exact/SKILL.md','skill','---\nname: Exact original\n---\nOriginal body\n'],['Exact/references/data.txt','support','Original supporting bytes\n']];
      const files=[];
      for(const [relative,fileKind,bytes]of contents){
        const file=path.join(dataRoot,relative);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,bytes);
        files.push({root:kind,relative,kind:fileKind,bytes:Buffer.byteLength(bytes),sha256:createHash('sha256').update(bytes).digest('hex')});
      }
      const data={inventorySha256:'b'.repeat(64),files};
      const skill=await captureReviewedSkill({directory,skill:packageSkillsForLaunch(data,launch)[0],allowedRoots:[dataRoot],
        parseMarkdown:()=>({body:'Original body\n',frontmatter:{name:'Exact original'}})});
      const snapshot={digest:'a'.repeat(64),locations:[{directory,skills:[skill]}]},calls=[],cases=[];
      await runCompiledSkillChecks({data,runtimeOwner:{getConfigurationSnapshot:()=>snapshot},launch,directory,onCase:row=>cases.push(row),
        invoke:async scenario=>{calls.push(scenario);return {state:{status:'completed',output:scenario.tool==='skill'?skill.content:contents[1][2]}};}});
      assert.deepEqual(calls[1],{id:'personal-support-0',tool:'read',input:{path:skill.resources[0].canonicalPath},direct:true,approveExternal});
      assert.equal(cases[0].skills,1);assert.equal(cases[0].supportReads,1);assert.equal(cases[0].resourceChecks,2);
    }
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
