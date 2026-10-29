import {expect,test} from 'bun:test';
import {Database as Sqlite} from 'bun:sqlite';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Effect,Layer} from 'effect';
import {Database} from '@opencode/core/database/database';
import {Global} from '@opencode/util/global';
import {inspectNativeCloneLayout,REVIEWED_NATIVE_CLONE_RELEASES,REVIEWED_NATIVE_BLOB_STORE_FRESH_CLONE_LAYOUT,REVIEWED_NATIVE_SCHEDULE_FRESH_CLONE_LAYOUT,verifyNativeCloneCompatibility} from '../../packages/web/server/lib/opencode/runtime-host/native-bundle-compatibility.js';

test('2.2.1 migrates the retained 2.0.32 schema in place to its fresh layout, adding only its five migrations',async()=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'devryan-clone-layout-')));
 const globals={home:root,data:root,cache:root,config:root,state:root,tmp:root,bin:root,log:root,repos:root};
 const initialize=(databasePath:string)=>Effect.runPromise(Effect.scoped(Effect.gen(function*(){
  yield* Database.Service;
 })).pipe(Effect.provide(Database.layer({path:databasePath}).pipe(Layer.provide(Global.layerWith(globals))))));
 try{
  const fresh=path.join(root,'fresh.sqlite');await initialize(fresh);
  expect(inspectNativeCloneLayout(fresh)).toEqual(REVIEWED_NATIVE_SCHEDULE_FRESH_CLONE_LAYOUT);
  const previous=path.join(root,'previous.sqlite');await fs.copyFile(fresh,previous);
  const previousDB=new Sqlite(previous);try{previousDB.exec("DROP TABLE schedule; DELETE FROM migration WHERE id = '20261026223005_schedule'");}finally{previousDB.close();}
  expect(inspectNativeCloneLayout(previous)).toEqual(REVIEWED_NATIVE_BLOB_STORE_FRESH_CLONE_LAYOUT);
  const manifest=(opencodeVersion:keyof typeof REVIEWED_NATIVE_CLONE_RELEASES)=>({opencodeVersion,inputs:{coreDigest:REVIEWED_NATIVE_CLONE_RELEASES[opencodeVersion]},compiledContracts:['devryan-v2-clone/1','devryan.bundle.credentials/2','devryan.bundle.credential-owners/2']});
  expect(()=>verifyNativeCloneCompatibility({left:manifest('2.2.0'),right:manifest('2.2.1'),databasePath:previous})).not.toThrow();
  await initialize(previous);
  expect(inspectNativeCloneLayout(previous)).toEqual(REVIEWED_NATIVE_SCHEDULE_FRESH_CLONE_LAYOUT);
  expect(()=>verifyNativeCloneCompatibility({left:manifest('2.2.0'),right:manifest('2.2.1'),databasePath:previous})).toThrow('bundle_v2_upgrade_compatibility_required');
  const retained=path.join(root,'retained.sqlite'),db=new Sqlite(retained);
  try{db.exec(await fs.readFile(path.join(import.meta.dirname,'../../packages/web/server/lib/opencode/runtime-host/test-fixtures/native-clone-layouts/2.0.32-fresh.sql'),'utf8'));
   const ids: string[]=JSON.parse(await fs.readFile(path.join(import.meta.dirname,'../../packages/web/server/lib/opencode/runtime-host/test-fixtures/native-clone-layouts/2.0.32-migrations.json'),'utf8'));
   expect(ids).toHaveLength(50);
   for(const id of ids)db.query('INSERT INTO migration (id,time_completed) VALUES (?,?)').run(id,1);
  }finally{db.close();}
  const migrations=(file:string)=>{const db=new Sqlite(file,{readonly:true});try{return db.query<{id:string;time_completed:number},[]>('SELECT * FROM migration ORDER BY id').all();}finally{db.close();}};
  const before=migrations(retained);expect(before.length).toBeGreaterThan(0);
  await initialize(retained);
  expect(inspectNativeCloneLayout(retained)).toEqual(REVIEWED_NATIVE_SCHEDULE_FRESH_CLONE_LAYOUT);
  const after=migrations(retained);
  expect(after.slice(0,before.length)).toEqual(before);
  expect(after.slice(before.length).map(row=>row.id)).toEqual(['20261024002554_session_allowance','20261024175301_drop_session_allowance','20261025123711_blob','20261025154125_drop_session_pending','20261026223005_schedule']);
  await initialize(retained);
  expect(migrations(retained)).toEqual(after);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
