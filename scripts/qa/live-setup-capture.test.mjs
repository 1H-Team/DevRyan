import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {captureLiveSetup,deriveCapturedGraph} from './live-setup-capture.mjs';
import {qaCache,readQaPinnedFile} from './live-setup-mirror.mjs';
import {verifyQaNativeInput} from './native-profile-preparation.mjs';

const graph={agentSelections:{orchestrator:{model:'openai/gpt-6-astra',variant:'medium',promptSha256:'a'.repeat(64)}},
  nativeBackupSelections:{slim:{runtimeChains:{},modelArrays:{},fallback:{},effectiveExecutionVariant:'default'},devryan:{}},nativeCompactionSettings:{},councilMembers:[]};
const fixture=async run=>{
  await fs.mkdir(path.join(qaCache,'test-fixtures'),{recursive:true,mode:0o700});
  const root=await fs.mkdtemp(path.join(qaCache,'test-fixtures/live-capture-'));
  try{
    const opencodeDirectory=path.join(root,'opencode'),webConfigDirectory=path.join(root,'web'),artifactRoot=path.join(root,'artifacts');
    for(const directory of [opencodeDirectory,webConfigDirectory,artifactRoot])await fs.mkdir(directory,{mode:0o700});
    await fs.writeFile(path.join(opencodeDirectory,'opencode.json'),'{}',{mode:0o600});
    await fs.writeFile(path.join(artifactRoot,'native-bundle.json'),'{}',{mode:0o600});
    const options={opencodeDirectory,webConfigDirectory,artifactRoot,outputRoot:path.join(root,'capture'),
      verifyArtifacts:async({manifestSha256})=>({manifestSha256,manifest:{buildId:'b'.repeat(64),inputs:{reviewedPlugins:[]}}}),deriveGraph:async()=>structuredClone(graph)};
    await run({root,options});
  }finally{await fs.rm(root,{recursive:true,force:true});}
};

test('capture sanitizes only eligible setup before graph derivation and seals exact graph',async()=>fixture(async({root,options})=>{
  const write=async(relative,value)=>{const file=path.join(options.opencodeDirectory,relative);await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});await fs.writeFile(file,value,{mode:0o600});};
  await write('opencode.jsonc','{"agent":{"orchestrator":{"model":"openai/gpt-6-astra","variant":"medium"}},"provider":{"openai":{"options":{"apiKey":"fixture-secret","headers":{"Authorization":"fixture-secret"}}}},"mcp":{"fixture":{"enabled":true}}}');
  await write('agents/custom.md','# Custom agent\n');await write('skills/fixture/SKILL.md','# Fixture skill\n');await write('skills/fixture/helper.sh','echo fixture\n');
  // Excluded roots are never traversed, even when an entry points outside scope.
  await fs.symlink('/never-read-credential-store',path.join(options.opencodeDirectory,'auth.json'));
  await fs.symlink('/never-read-installed-accounts',path.join(options.opencodeDirectory,'accounts'));
  await fs.writeFile(path.join(options.webConfigDirectory,'settings.json'),JSON.stringify({theme:'dark',projects:[{path:'/never-read'}],sessionToken:'fixture-secret'}),{mode:0o600});
  let derived=0;
  options.deriveGraph=async({preparedInput,mirror})=>{
    derived++;await verifyQaNativeInput(preparedInput);
    const config=JSON.parse(await fs.readFile(path.join(preparedInput.sourceHome,'opencode/opencode.jsonc'),'utf8'));
    assert.deepEqual(config.provider.openai.options,{});assert.equal(config.mcp.fixture.enabled,false);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(preparedInput.sourceHome,'web-config/settings.json'),'utf8')),{theme:'dark'});
    assert.equal(mirror.homeDirectory,'home');assert.deepEqual(await fs.readdir(path.join(preparedInput.sourceHome,'home')),[]);
    return structuredClone(graph);
  };
  const result=await captureLiveSetup(options),preparation=JSON.parse(await readQaPinnedFile(result.preparationFile,result.sha256));
  assert.equal(derived,1);assert.deepEqual(preparation.savedGraph,graph);
  assert.equal(await verifyQaNativeInput(preparation.preparedInput),preparation.inputDigest);
  const paths=preparation.preparedInput.files.map(row=>row.path);
  assert.ok(paths.includes('opencode/skills/fixture/helper.sh'));assert.ok(!paths.some(file=>file.includes('auth.json')||file.includes('accounts')));
  assert.ok(!(await fs.readFile(path.join(root,'capture/input.json'),'utf8')).includes('fixture-secret'));
  assert.equal((await fs.stat(result.preparationFile)).mode&0o777,0o400);
  await assert.rejects(captureLiveSetup(options),{code:'EEXIST'});
}));

test('capture refuses symlinks, hardlinks, writable or oversized input before deriving',async()=>{
  for(const kind of ['root-link','file-link','tree-link','hardlink','writable','large','credential'])await fixture(async({root,options})=>{
    let derived=false;options.deriveGraph=async()=>{derived=true;return graph;};
    const config=path.join(options.opencodeDirectory,'opencode.json');
    if(kind==='root-link'){const link=path.join(root,'linked');await fs.symlink(options.opencodeDirectory,link);options.opencodeDirectory=link;}
    if(kind==='file-link'){await fs.unlink(config);await fs.symlink('/never-read-credential-store',config);}
    if(kind==='tree-link'){await fs.mkdir(path.join(options.opencodeDirectory,'skills'));await fs.symlink(options.webConfigDirectory,path.join(options.opencodeDirectory,'skills/linked'));}
    if(kind==='hardlink')await fs.link(config,path.join(root,'linked.json'));
    if(kind==='writable')await fs.chmod(config,0o666);
    if(kind==='large')await fs.writeFile(config,Buffer.alloc(1024*1024+1));
    if(kind==='credential'){await fs.mkdir(path.join(options.opencodeDirectory,'skills'));await fs.symlink('/never-read-credential-store',path.join(options.opencodeDirectory,'skills/auth.json'));}
    await assert.rejects(captureLiveSetup(options));assert.equal(derived,false);
    await assert.rejects(fs.lstat(path.join(options.outputRoot,'approved')),{code:'ENOENT'});
  });
});

test('skill JSON data may contain arrays and scalars while configs and syntax remain strict',async()=>fixture(async({options})=>{
  const folder=path.join(options.opencodeDirectory,'skills/fixture/scripts/tests/fixtures');await fs.mkdir(folder,{recursive:true,mode:0o700});
  for(const [name,value] of Object.entries({'catalog.json':[{name:'Fixture',apiKey:'fixture-secret',nested:{token:'fixture-secret',enabled:true}}],'scalar.json':42,'nullable.json':null})){
    await fs.writeFile(path.join(folder,name),JSON.stringify(value),{mode:0o600});
  }
  const result=await captureLiveSetup(options),preparation=JSON.parse(await readQaPinnedFile(result.preparationFile,result.sha256));
  const captured=name=>fs.readFile(path.join(preparation.preparedInput.sourceHome,'opencode/skills/fixture/scripts/tests/fixtures',name),'utf8').then(JSON.parse);
  assert.deepEqual(await captured('catalog.json'),[{name:'Fixture',nested:{enabled:true}}]);assert.equal(await captured('scalar.json'),42);assert.equal(await captured('nullable.json'),null);
  for(const [relative,source] of [['opencode.json','[]'],['skills/fixture/scripts/tests/fixtures/broken.json','[}']]){
    await fs.writeFile(path.join(options.opencodeDirectory,relative),source,{mode:0o600});
    await assert.rejects(captureLiveSetup({...options,outputRoot:options.outputRoot+'-'+(relative==='opencode.json'?'config':'syntax')}),{code:'INVALID_JSONC'});
    if(relative==='opencode.json')await fs.writeFile(path.join(options.opencodeDirectory,relative),'{}',{mode:0o600});
  }
}));

test('derivation refusal produces finite failure evidence without approving a graph',async()=>fixture(async({options})=>{
  options.deriveGraph=async()=>{throw Object.assign(new Error('/private/source fixture-secret'),{code:'native_fixture_refused'});};
  await assert.rejects(captureLiveSetup(options),{code:'native_fixture_refused'});
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(options.outputRoot,'failed.json'),'utf8')),{status:'failed',code:'native_fixture_refused'});
  await assert.rejects(fs.lstat(path.join(options.outputRoot,'approved')),{code:'ENOENT'});
}));

test('offline graph reader gets the isolation ownership marker and provisional state is always removed',async()=>fixture(async({options})=>{
  for(const refuse of [false,true]){
    const outputRoot=options.outputRoot+'-'+refuse;await fs.mkdir(outputRoot,{mode:0o700});
    const dependencies={createFactory:async({bootstrapCredentials})=>{
      await assert.rejects(bootstrapCredentials(),{code:'qa_capture_credentials_forbidden'});
      return {prepareSource:async()=>({})};
    },prepareBundle:async({runtimeRoot})=>{
      const global={};for(const name of ['home','config','data','state','cache','tmp']){
        global[name]=path.join(runtimeRoot,name);await fs.mkdir(global[name],{mode:0o700});
      }
      return {binding:{controlRoot:path.join(runtimeRoot,'native-bundles'),descriptor:{launch:{global,webDataDirectory:path.join(runtimeRoot,'web-data')}}}};
    },readSelection:async(binding,environment)=>{
      assert.equal((await fs.stat(path.join(binding.descriptor.launch.global.home,'.devryan-qa-home'))).mode&0o777,0o600);
      const result=spawnSync(process.execPath,['--input-type=module','--eval','import os from "node:os"; if(os.homedir()!==process.env.DEVRYAN_QA_HOME)process.exit(1)'],{env:environment,encoding:'utf8'});
      assert.equal(result.status,0,result.stderr);
      if(refuse)throw Object.assign(new Error('fixture'),{code:'native_fixture_refused'});return structuredClone(graph);
    }};
    const derive=()=>deriveCapturedGraph({preparedInput:{},mirror:{},outputRoot,...dependencies});
    if(refuse)await assert.rejects(derive(),{code:'native_fixture_refused'});else assert.deepEqual(await derive(),graph);
    await assert.rejects(fs.lstat(path.join(outputRoot,'provisional')),{code:'ENOENT'});
  }
}));

test('capture refuses account-bearing files and folders within eligible skill trees before reading',async()=>{
  for(const entry of ['.env','.env.local','private.pem','private.key','identity.p12','secrets.yaml','id_rsa','credentials','vault','account'])await fixture(async({options})=>{
    let derived=false;options.deriveGraph=async()=>{derived=true;return graph;};
    const skill=path.join(options.opencodeDirectory,'skills/fixture');await fs.mkdir(skill,{recursive:true,mode:0o700});
    if(['credentials','vault','account'].includes(entry)){
      await fs.mkdir(path.join(skill,entry),{mode:0o700});await fs.writeFile(path.join(skill,entry,'hidden.txt'),'fixture-secret',{mode:0o600});
    }else await fs.writeFile(path.join(skill,entry),'fixture-secret',{mode:0o600});
    await assert.rejects(captureLiveSetup(options),{code:'qa_capture_file_not_allowed'});assert.equal(derived,false);
    await assert.rejects(fs.lstat(path.join(options.outputRoot,'source/opencode/skills/fixture',entry)),{code:'ENOENT'});
    await assert.rejects(fs.lstat(path.join(options.outputRoot,'approved')),{code:'ENOENT'});
  });
});

test('capture CLI refuses missing, unknown and duplicate flags deterministically',()=>{
  for(const args of [[],['--source-home','/never-read'],['--artifact-root','/never-read','--artifact-root','/never-read']]){
    const result=spawnSync(process.execPath,['scripts/qa/live-setup-capture.mjs',...args],{encoding:'utf8'});
    assert.equal(result.status,1);assert.equal(result.stdout,'');assert.deepEqual(JSON.parse(result.stderr),{status:'refused',code:'qa_capture_flags_invalid'});
  }
});
