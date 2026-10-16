import {test,expect} from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createCursorSdkRuntime} from './index.js';

test('original offline declarations are fresh and independent of mutable account discovery cache',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'devryan-cursor-declared-'));
 let reads=0,loads=0;
 const runtime=createCursorSdkRuntime({storageDir:root,env:{},ripgrepPath:'/usr/bin/true',nativeWarming:false,
  readAuth:()=>{reads++;throw Error('Unexpected credential read');},loadSdk:async()=>{loads++;throw Error('Unexpected SDK load');}});
 try{
  const first=runtime.getDeclaredVirtualProvider();
  expect(first.id).toBe('cursor-acp');expect(first.models['composer-2.5'].options.cursorSdkModel).toEqual({id:'composer-2.5',params:[{id:'fast',value:'false'}]});
  expect(first.models.composer).toBeUndefined();
  runtime.getCachedVirtualProvider().models['foreign-account-model']={id:'foreign-account-model'};
  delete first.models['composer-2.5'];
  const second=runtime.getDeclaredVirtualProvider();
  expect(second.models['composer-2.5']).toBeDefined();expect(second.models['foreign-account-model']).toBeUndefined();
  expect({reads,loads}).toEqual({reads:0,loads:0});
 }finally{await runtime.dispose();await fs.rm(root,{recursive:true,force:true});}
});
