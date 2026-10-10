import {it,expect} from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
it.each(['ready','held-A','pending-B'])('actual thin entry awaits bootstrap and selects %s before composition',async state=>{
 const held=state!=='ready';
 const root=await fs.realpath(await fs.mkdtemp(path.resolve('../../.cache/v2-validation/native-entry-')));
 try{
  const entry=await fs.readFile(new URL('../../../index.js',import.meta.url),'utf8');
  await fs.writeFile(path.join(root,'entry.mjs'),entry
   .replace("'./lib/opencode/startup-timing.js'","'./startup-timing.mjs'")
   .replace("'./lib/opencode/runtime-host/runtime-entry-bootstrap.js'","'./bootstrap.mjs'")
   .replace("'./lib/opencode/runtime-host/runtime-bundle-binding.js'","'./binding.mjs'")
   .replace("'./lib/opencode/runtime-host/runtime-bundle-recovery.js'","'./recovery.mjs'")
   .replace("'./application.js'","'./application.mjs'"));
  await fs.copyFile(new URL('../startup-timing.js',import.meta.url),path.join(root,'startup-timing.mjs'));
  await fs.writeFile(path.join(root,'bootstrap.mjs'),"await new Promise(resolve=>setTimeout(resolve,10));globalThis.__fixtureEntryBound=true;\n");
  await fs.writeFile(path.join(root,'binding.mjs'),`export const selectedRuntimeBundle={admission:${JSON.stringify(held?'held':'pending')},selection:{reconciliationRequired:${state==='held-A'}}};\n`);
  const composition="if(!globalThis.__fixtureEntryBound)throw Error('composition_preceded_binding');export const gracefulShutdown=1,setupProxy=2,restartOpenCode=3,startWebUiServer=4,parseArgs=5;export const runWebCliEntry=filename=>{globalThis.__fixtureEntryFilename=filename;};\n";
  await fs.writeFile(path.join(root,held?'recovery.mjs':'application.mjs'),composition);
  await fs.writeFile(path.join(root,held?'application.mjs':'recovery.mjs'),"throw Error('unexpected_composition_import');\n");
  const imported=await import(pathToFileURL(path.join(root,'entry.mjs')).href);expect(imported).toMatchObject({gracefulShutdown:1,setupProxy:2,restartOpenCode:3,startWebUiServer:4,parseArgs:5});expect(globalThis.__fixtureEntryFilename).toBe(path.join(root,'entry.mjs'));
 }finally{delete globalThis.__fixtureEntryBound;delete globalThis.__fixtureEntryFilename;await fs.rm(root,{recursive:true,force:true});}
});
