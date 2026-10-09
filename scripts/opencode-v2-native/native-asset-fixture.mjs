import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {rewriteNativeAsset,rewriteNativeAgentDefaults} from '../native-runtime-assets.mjs';

// Test bundles use the same guarded native asset resolvers as production.
export async function createNativeAssetFixturePlugin(repository){
 const core=await fs.realpath(path.join(repository,'node_modules/@opencode/core'));
 const require=createRequire(path.join(core,'package.json'));
 const ptyBinding=path.join(core,'dist/chunks/location-services-dajrwvna.js');
 const ptyBinary=path.join(path.dirname(require.resolve('@opencode-ai/pty-darwin-arm64/package.json')),'bin/opencode-pty');
 const photon=require.resolve('@silvia-odwyer/photon-node'),agentDefaults=await fs.realpath(path.join(path.dirname(core),'schema/dist/agent.js'));
 const sha256=createHash('sha256').update(await fs.readFile(ptyBinary)).digest('hex');
 const rewrites=new Map([
  [ptyBinding,rewriteNativeAsset('pty',await fs.readFile(ptyBinding),{assetPath:ptyBinary,assetSha256:sha256})],
  [photon,rewriteNativeAsset('photon',await fs.readFile(photon))],
  [agentDefaults,rewriteNativeAgentDefaults(await fs.readFile(agentDefaults))],
 ]);
 return {name:'production-pinned-native-assets',setup(builder){
  builder.onLoad({filter:/(location-services-dajrwvna|photon_rs|@opencode[\\/]schema[\\/]dist[\\/]agent)\.js$/},event=>{
   const contents=rewrites.get(path.resolve(event.path));
   if(contents===undefined)throw Error('Unexpected native asset resolver');
   return {contents,loader:'js'};
  });
 }};
}

export async function writeNativeFixtureOutputs(outputs){
 for(const output of outputs){
  await fs.writeFile(output.path,new Uint8Array(await output.arrayBuffer()));
  if(output.kind==='asset')await fs.chmod(output.path,0o755);
 }
}
