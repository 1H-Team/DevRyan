import {test,expect} from 'vitest';
import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {captureNativePonytailDefault} from './native-ponytail-default.js';
test('original Ponytail defaults preserve case, whitespace, BOM and invalid-review behavior inside selected roots',async()=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'ponytail-default-')));try{
  const folder=path.join(root,'ponytail');await fs.mkdir(folder);const file=path.join(folder,'config.json'),launch={global:{config:root},opencodeConfigDirectory:root};
  expect((await captureNativePonytailDefault({launch})).defaultMode).toBe('full');
  await fs.writeFile(file,'\uFEFF{"defaultMode":"LiTe"}');
  expect((await captureNativePonytailDefault({launch,environmentDefaultMode:'ULTRA'}))).toMatchObject({defaultMode:'ultra',source:'environment',references:[]});
  expect((await captureNativePonytailDefault({launch,environmentDefaultMode:' ultra '}))).toMatchObject({defaultMode:'lite',source:'configuration'});
  for(const value of ['review',' full ',4]){await fs.writeFile(file,JSON.stringify({defaultMode:value}));expect((await captureNativePonytailDefault({launch})).defaultMode).toBe('full');}
  await fs.writeFile(file,'invalid');expect((await captureNativePonytailDefault({launch}))).toMatchObject({defaultMode:'full',source:'default'});
  await fs.unlink(file);await fs.writeFile(path.join(root,'other.json'),'{}');await fs.symlink('../other.json',file);await expect(captureNativePonytailDefault({launch})).rejects.toThrow();
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
