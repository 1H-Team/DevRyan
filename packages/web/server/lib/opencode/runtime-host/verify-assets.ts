import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {Effect} from 'effect';
import {ShellParse} from '@opencode/core/shell/parse';
import {make} from '@opencode/core/image/photon';
import {resolveBinary} from '@opencode/core/persistent-pty/binary.bun';
import '@opencode/core/pty/pty.bun';
import {dlopen} from 'bun:ffi';
import ffiAsset from '../../../../../../node_modules/.bun/bun-pty@0.4.8/node_modules/bun-pty/rust-pty/target/release/librust_pty_arm64.dylib' with {type:'file'};
import type {NativeAssetRequest} from './native-process-protocol.js';
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
function png() {
  const crc=(bytes:Uint8Array)=>{let value=0xffffffff;for(const byte of bytes){value^=byte;for(let i=0;i<8;i++)value=(value>>>1)^((value&1)?0xedb88320:0);}return (value^0xffffffff)>>>0;};
  const chunk=(type:string,data:Buffer)=>{const body=Buffer.concat([Buffer.from(type),data]),result=Buffer.alloc(data.length+12);result.writeUInt32BE(data.length);body.copy(result,4);result.writeUInt32BE(crc(body),result.length-4);return result;};
  const header=Buffer.alloc(13);header.writeUInt32BE(8,0);header.writeUInt32BE(8,4);header[8]=8;header[9]=6;
  const pixels=Buffer.alloc(8*(1+8*4),255);for(let y=0;y<8;y++)pixels[y*33]=0;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
}
/** Asset initialization only: no provider, database, terminal or tool execution. */
export async function verifyNativeAssets(request:NativeAssetRequest,buildId:string) {
  const bash=await Effect.runPromise(ShellParse.scan('echo native-assets','/bin/bash',request.verificationRoot));
  const powershell=await Effect.runPromise(ShellParse.scan("Write-Output 'native-assets'",'pwsh',request.verificationRoot));
  if(!bash.commands.length||!powershell.commands.length) throw new Error('native_parser_asset_invalid');
  const normalize=await Effect.runPromise(make);
  const image=await Effect.runPromise(normalize('native-assets',{uri:'asset:owned',content:png().toString('base64'),encoding:'base64',mime:'image/png'},
    {autoResize:true,maxWidth:1,maxHeight:1,maxBase64Bytes:4096}));
  const output=Buffer.from(image.content,'base64');
  if(image.mime!=='image/png'||output.length<24||output.readUInt32BE(12)!==0x49484452) throw new Error('native_photon_asset_invalid');
  const width=output.readUInt32BE(16),height=output.readUInt32BE(20);
  if(width!==1||height!==1) throw new Error('native_photon_asset_invalid');
  const pty=await resolveBinary(request.globals.bin),bytes=await fs.readFile(pty),stat=await fs.stat(pty);
  const digest=hash(bytes);if(digest!=='d333339292bb9f9a739dbce9e2ababbce81b3040ea3d064b8a9b359a1c05ab61'||(stat.mode&0o111)===0) throw new Error('native_pty_asset_invalid');
  const ffiBytes=new Uint8Array(await Bun.file(ffiAsset).arrayBuffer());
  if(hash(ffiBytes)!=='d61d60ed8348eadfb396418f85ff8dcee7428fe94feb1395c0ae9f68eba3868f') throw new Error('native_ffi_asset_invalid');
  const library=dlopen(ffiAsset,{bun_pty_get_pid:{args:['i32'],returns:'i32'}});
  try{if(typeof library.symbols.bun_pty_get_pid!=='function') throw new Error('native_ffi_asset_invalid');}finally{library.close();}
  return {protocol:1,type:'assets-verified',buildId,parser:{bash:true,powershell:true},photon:{width,height,mime:image.mime},pty:{sha256:digest,size:bytes.length,executable:true},ffi:{loaded:true}};
}
