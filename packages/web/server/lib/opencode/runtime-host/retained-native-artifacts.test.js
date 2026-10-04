import {test,expect,afterEach} from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {retainNativeArtifacts} from './retained-native-artifacts.js';
const roots=[];afterEach(async()=>{for(const root of roots.splice(0))await fs.rm(root,{recursive:true,force:true});});
const hash=value=>createHash('sha256').update(value).digest('hex');
test('retains the complete manifest-owned inventory, modes and Claude asset independently of Resources',async()=>{
 const root=await fs.mkdtemp(path.resolve('../../.cache/v2-validation/artifact-retention-'));roots.push(root);
 const source=path.join(root,'resources'),controlRoot=path.join(root,'control');await fs.mkdir(source);await fs.mkdir(controlRoot);
 const names=['DevRyan-controller','DevRyan-writer','DevRyan-Claude-credentials.mjs'],files=[];
 for(const name of names){const file=path.join(source,name),bytes=name+' fixture bytes';await fs.writeFile(file,bytes,{mode:name.endsWith('.mjs')?0o644:0o755});files.push({path:name,sha256:hash(bytes),size:Buffer.byteLength(bytes),mode:name.endsWith('.mjs')?0o644:0o755});}
 const manifestPath=path.join(source,'native-bundle.json');await fs.writeFile(manifestPath,JSON.stringify({files}));const manifestSha256=hash(await fs.readFile(manifestPath));
 const verifyArtifacts=async input=>({manifestPath:input.manifestPath,launcher:path.join(path.dirname(input.manifestPath),'launcher'),controller:path.join(path.dirname(input.manifestPath),names[0]),writer:path.join(path.dirname(input.manifestPath),names[1])});
 const retained=await retainNativeArtifacts({controlRoot,manifestPath,manifestSha256,verifyArtifacts});
 expect(retained.manifestPath).toBe(path.join(controlRoot,'artifacts',manifestSha256,'native-bundle.json'));
 await fs.rm(source,{recursive:true});
 for(const row of files){const file=path.join(path.dirname(retained.manifestPath),row.path);expect(hash(await fs.readFile(file))).toBe(row.sha256);expect((await fs.stat(file)).mode&0o777).toBe(row.mode);}
});
