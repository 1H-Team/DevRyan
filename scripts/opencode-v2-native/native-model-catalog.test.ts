import { expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Effect, Layer } from 'effect';
import { HttpClient } from 'effect/unstable/http';
import { KV } from '@opencode/core/kv';
import { ModelsDev } from '@opencode/core/models-dev';
import { FSUtil } from '@opencode/util/fs-util';
import { Global } from '@opencode/util/global';
import { LayerNode } from '@opencode/util/effect/layer-node';
import { httpClient } from '@opencode/util/effect/app-node-platform';
import catalogFile from '../../packages/web/runtime/reviewed-inputs/model-catalog/DevRyan-model-catalog.json' with { type: 'file' };
import { nativeModelCatalogOverride } from '../../packages/web/server/lib/opencode/runtime-host/native-model-catalog.js';
const catalogPath:unknown=catalogFile;
if(typeof catalogPath!=='string')throw new Error('invalid_test_asset');

async function catalogFixture(action:(fixture:{run:(cached:{updatedAt:number;body:string}|undefined,file?:string)=>Promise<readonly ModelsDev.Snapshot[]>;traffic:()=>number;cacheReads:()=>number;root:string})=>Promise<void>) {
  const root = await fs.mkdtemp(path.resolve('.cache/v2-validation/catalog-file-'));
  const globals = {home:root,data:root,cache:root,config:root,state:root,tmp:root,bin:root,log:root,repos:root};
  let traffic = 0, cacheReads = 0;
  const run = (cached:{updatedAt:number;body:string}|undefined,file?:string) => {
    const kv: KV.Interface = {get:key=>Effect.sync(()=>{if(key==='models-dev:catalog')cacheReads++;return cached;}),
      set:()=>Effect.void,remove:()=>Effect.void,scan:()=>Effect.succeed({entries:[]})};
    const layer = LayerNode.compile(ModelsDev.node, {replacements:[
      Global.node.replace(Global.layerWith(globals)), KV.node.replace(Layer.succeed(KV.Service,kv)),
      httpClient.replace(Layer.succeed(HttpClient.HttpClient,HttpClient.make(()=>Effect.sync(()=>{traffic++;throw new Error('unexpected_http');})))),
      ...(file===undefined?[]:[FSUtil.node.replace(FSUtil.node.mapLayer(inner=>Layer.effect(FSUtil.Service,Effect.gen(function*(){
        const fsUtil=yield* FSUtil.Service;
        return {...fsUtil,readJson:(requested:string)=>fsUtil.readJson(requested===catalogPath?file:requested)};
      })).pipe(Layer.provide(inner))))]),
      nativeModelCatalogOverride(),
    ]});
    return Effect.runPromise(Effect.scoped(Effect.gen(function*(){
      const catalog = yield* ModelsDev.Service;
      const refresh = yield* Effect.exit(catalog.refresh(true));
      expect(refresh._tag).toBe('Failure');
      return yield* catalog.get();
    }).pipe(Effect.provide(layer))));
  };
  try {await action({run,root,traffic:()=>traffic,cacheReads:()=>cacheReads});}
  finally {await fs.rm(root,{recursive:true,force:true});}
}

test('actual native file parser ignores fresh/divergent KV, resolves GPT6.1 efforts and cannot fetch',async()=>{
 await catalogFixture(async fixture=>{
  const rows:(readonly ModelsDev.Snapshot[])[]=[];
  for(const cached of [undefined,{updatedAt:Date.now(),body:JSON.stringify({})}]){
   const actual=await fixture.run(cached);rows.push(actual);
   const openai=actual.find(provider=>provider.info.id==='openai');
   expect(openai?.models.some(model=>model.id==='gpt-6-astra')).toBe(true);
   const sol=openai?.models.find(model=>model.id==='gpt-6.1-sol');
   expect<string|undefined>(sol?.id).toBe('gpt-6.1-sol');
   expect<readonly string[]|undefined>(sol?.variants.map(variant=>variant.id)).toEqual(['low','medium','high','xhigh','max']);
   expect(actual.find(provider=>provider.info.id==='xai')?.models.some(model=>model.id==='grok-4.6')).toBe(true);
  }
  expect(rows[0]).toEqual(rows[1]);expect(fixture.traffic()).toBe(0);expect(fixture.cacheReads()).toBe(0);
 });
});

test('missing, corrupt or empty owned catalog fails closed without cache/snapshot/network fallback',async()=>{
 await catalogFixture(async fixture=>{
  const corrupt=path.join(fixture.root,'corrupt.json'),empty=path.join(fixture.root,'empty.json');
  await fs.writeFile(corrupt,'invalid json');await fs.writeFile(empty,'{}');
  const cached={updatedAt:Date.now(),body:await fs.readFile(catalogPath,'utf8')};
  for(const file of [path.join(fixture.root,'missing.json'),corrupt,empty]){
   const result=fixture.run(cached,file);
   await expect(result).rejects.toThrow('native_catalog_file_invalid');
  }
  expect(fixture.traffic()).toBe(0);expect(fixture.cacheReads()).toBe(0);
 });
});
