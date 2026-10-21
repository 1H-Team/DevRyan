import {test,expect} from 'vitest';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {importVerifiedModuleBytes} from './verified-module-import.js';

// Well past Bun's ~4 KiB module-name limit, so a data: URL would fail there.
const source=`import {isBuiltin} from 'node:module';export const builtin=isBuiltin('node:fs');export const size=${64*1024};//${'x'.repeat(64*1024)}`;
const helper=fileURLToPath(new URL('./verified-module-import.js',import.meta.url));

test('imports large verified bytes in this runtime',async()=>{
 const loaded=await importVerifiedModuleBytes(Buffer.from(source));
 expect(loaded).toMatchObject({builtin:true,size:64*1024});
});

test('imports large verified bytes under Bun',async()=>{
 const script=`const {importVerifiedModuleBytes}=await import(${JSON.stringify(helper)});
const loaded=await importVerifiedModuleBytes(Buffer.from(${JSON.stringify(source)}));
console.log(JSON.stringify({builtin:loaded.builtin,size:loaded.size}));`;
 const {stdout}=await promisify(execFile)('bun',['--eval',script],{maxBuffer:1024*1024});
 expect(JSON.parse(stdout.trim())).toEqual({builtin:true,size:64*1024});
});
