import {afterEach,expect,test} from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {protectNativeSetupSource,removeNativeSetupSource,sweepRemovedNativeSetupSources} from './native-setup-source.js';
const roots=[];afterEach(async()=>{for(const root of roots.splice(0))await fs.rm(root,{recursive:true,force:true});});
test('repairs private seed modes, preserves failed selection and retries cleanup only after verification',async()=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'source-protection-')));roots.push(root);
 const controlRoot=path.join(root,'runtime-bundles'),sourceRoot=path.join(root,'fresh-native-source');
 await fs.mkdir(path.join(sourceRoot,'opencode-config'),{recursive:true,mode:0o755});
 const file=path.join(sourceRoot,'opencode-config','native-setup-credentials.json');await fs.writeFile(file,'private fixture',{mode:0o644});
 await fs.mkdir(path.join(sourceRoot,'web-data'));await fs.writeFile(path.join(sourceRoot,'web-data','native-setup-seed.json'),JSON.stringify({schema:1,files:[{path:file,sha256:createHash('sha256').update('private fixture').digest('hex')}]}));
 await protectNativeSetupSource({controlRoot,sourceRoot});
 expect((await fs.stat(sourceRoot)).mode&0o777).toBe(0o700);expect((await fs.stat(file)).mode&0o777).toBe(0o600);
 await expect(removeNativeSetupSource({controlRoot,sourceRoot,verifySelected:async()=>{throw Error('candidate not verified');}})).rejects.toThrow('candidate not verified');
 expect(await fs.readFile(file,'utf8')).toBe('private fixture');
 let verified=false;await removeNativeSetupSource({controlRoot,sourceRoot,verifySelected:async()=>{verified=true;}});
 expect(verified).toBe(true);expect(await fs.stat(sourceRoot).catch(error=>error.code)).toBe('ENOENT');
});
test('committed selection cannot delete an incomplete/tampered seed, including old unstamped retry roots',async()=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'source-retry-')));roots.push(root);
 const controlRoot=path.join(root,'runtime-bundles'),sourceRoot=path.join(root,'fresh-native-source');
 await fs.mkdir(path.join(sourceRoot,'web-data'),{recursive:true});await fs.mkdir(path.join(sourceRoot,'opencode-config'));
 const file=path.join(sourceRoot,'opencode-config','native-setup-credentials.json');await fs.writeFile(file,'complete fixture');
 await fs.writeFile(path.join(sourceRoot,'web-data','native-setup-seed.json'),JSON.stringify({schema:1,files:[{path:file,sha256:createHash('sha256').update('complete fixture').digest('hex')}]}));
 await fs.writeFile(file,'changed fixture');
 await expect(removeNativeSetupSource({controlRoot,sourceRoot,verifySelected:async()=>{}})).rejects.toMatchObject({code:'native_setup_source_ownership_invalid'});
 expect(await fs.readFile(file,'utf8')).toBe('changed fixture');
 await fs.writeFile(file,'complete fixture');await removeNativeSetupSource({controlRoot,sourceRoot,verifySelected:async()=>{}});
 expect(await fs.stat(sourceRoot).catch(error=>error.code)).toBe('ENOENT');
});
test('never claims an arbitrary directory or traverses a symlink as owned seed',async()=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'source-refusal-')));roots.push(root);
 const controlRoot=path.join(root,'runtime-bundles'),sourceRoot=path.join(root,'fresh-native-source');await fs.mkdir(sourceRoot);
 await fs.writeFile(path.join(sourceRoot,'unrelated'),'retained');
 await expect(protectNativeSetupSource({controlRoot,sourceRoot})).rejects.toMatchObject({code:'native_setup_source_ownership_invalid'});
 await fs.rm(path.join(sourceRoot,'unrelated'));await fs.symlink(root,path.join(sourceRoot,'home'));
 await expect(protectNativeSetupSource({controlRoot,sourceRoot})).rejects.toMatchObject({code:'native_setup_source_ownership_invalid'});
 expect(await fs.stat(path.join(sourceRoot,'.devryan-fresh-source.json')).catch(error=>error.code)).toBe('ENOENT');
});
test('Finder metadata directly inside the fresh source is tolerated and removed with the tree',async()=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'source-metadata-')));roots.push(root);
 const controlRoot=path.join(root,'runtime-bundles'),sourceRoot=path.join(root,'fresh-native-source');await fs.mkdir(path.join(sourceRoot,'web-data'),{recursive:true});
 for(const name of ['.DS_Store','._web-data'])await fs.writeFile(path.join(sourceRoot,name),'\0\0\0\x01Bud1');
 await fs.writeFile(path.join(sourceRoot,'web-data','native-setup-seed.json'),JSON.stringify({schema:1,files:[]}));
 await protectNativeSetupSource({controlRoot,sourceRoot});expect((await fs.stat(path.join(sourceRoot,'.DS_Store'))).mode&0o777).toBe(0o600);
 await removeNativeSetupSource({controlRoot,sourceRoot,verifySelected:async()=>{}});expect(await fs.stat(sourceRoot).catch(error=>error.code)).toBe('ENOENT');
});
test('removal renames before deleting and the sweep removes only owned renamed leftovers',async()=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'source-sweep-')));roots.push(root);
 const controlRoot=path.join(root,'runtime-bundles'),sourceRoot=path.join(root,'fresh-native-source'),outside=path.join(root,'outside');
 await fs.mkdir(path.join(sourceRoot,'web-data'),{recursive:true});await fs.writeFile(path.join(sourceRoot,'web-data','native-setup-seed.json'),JSON.stringify({schema:1,files:[]}));
 const rm=fs.rm;let removed;fs.rm=async(target,...rest)=>{removed=String(target);throw Object.assign(Error('killed during removal'),{code:'EKILLED'});};
 try{await expect(removeNativeSetupSource({controlRoot,sourceRoot,verifySelected:async()=>{}})).rejects.toMatchObject({code:'EKILLED'});}finally{fs.rm=rm;}
 expect(path.dirname(removed)).toBe(root);expect(path.basename(removed)).toMatch(/^\.fresh-native-source\.removing-[a-f0-9]{16}$/);
 expect(await fs.stat(sourceRoot).catch(error=>error.code)).toBe('ENOENT');
 await fs.mkdir(path.join(root,'.fresh-native-source.removing-other'));
 await sweepRemovedNativeSetupSources({controlRoot,sourceRoot});expect((await fs.readdir(root)).sort()).toEqual(['.fresh-native-source.removing-other']);
 await fs.mkdir(outside);await fs.writeFile(path.join(outside,'kept.txt'),'kept');await fs.symlink(outside,path.join(root,'.fresh-native-source.removing-0123456789abcdef'));
 await expect(sweepRemovedNativeSetupSources({controlRoot,sourceRoot})).rejects.toMatchObject({code:'native_setup_source_ownership_invalid'});
 expect(await fs.readFile(path.join(outside,'kept.txt'),'utf8')).toBe('kept');
});
