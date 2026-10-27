import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {Credential} from '@opencode/core/credential';
import {Integration} from '@opencode/core/integration';
import {KV} from '@opencode/core/kv';
import {Database} from '@opencode/core/database/database';
import {Effect,Schema} from 'effect';

export const NATIVE_SETUP_CREDENTIAL_STAMP='devryan.setup.credentials/1';
const Seed=Schema.Struct({schema:Schema.Literal(1),credentials:Schema.Array(Schema.Struct({
 integrationID:Integration.ID,value:Credential.Value,label:Schema.optionalKey(Schema.String),
}))});
const fail=(code:string):never=>{throw new Error(code);};
const Stamp=Schema.Struct({schema:Schema.Literal(1),sha256:Schema.String,count:Schema.Number});

/** Constructor-only, original global services before caller-grant decoration.
 * A transaction couples original credential activation and its one-time stamp;
 * later account changes are never overwritten by startup seeding. */
export function bootstrapNativeSetupCredentials({seedPath,expected,platform=process.platform}:{readonly seedPath:string;readonly expected?:{readonly sha256:string;readonly count:number}|null;readonly platform?:NodeJS.Platform}){
 return Effect.gen(function*(){
  const db=yield* Database.Service,kv=yield* KV.Service,credentials=yield* Credential.Service;
  let identity:{ino:number;dev:number;mtimeMs:number;ctimeMs:number}|undefined;
  const bytes=yield* Effect.promise(async()=>{
   let stat;try{stat=await fs.lstat(seedPath);}catch(error){if(error instanceof Error&&'code'in error&&error.code==='ENOENT')return undefined;throw error;}
   if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1024*1024||await fs.realpath(seedPath)!==seedPath)return fail('native_setup_credentials_invalid');
   const handle=await fs.open(seedPath,constants.O_RDONLY|constants.O_NOFOLLOW);
   try{const current=await handle.stat();if(current.size!==stat.size||current.size>1024*1024)return fail('native_setup_credentials_changed');
    const value=await handle.readFile(),after=await fs.stat(seedPath);
    if(value.length!==current.size||current.ino!==stat.ino||current.dev!==stat.dev||after.mtimeMs!==current.mtimeMs||after.ctimeMs!==current.ctimeMs)return fail('native_setup_credentials_changed');identity=current;return value;
   }finally{await handle.close();}
  });
  let seed:typeof Seed.Type|undefined;
  if(bytes){try{seed=Schema.decodeUnknownSync(Seed)(JSON.parse(bytes.toString('utf8')),{onExcessProperty:'error'});}catch{return fail('native_setup_credentials_invalid');}
   if(seed.credentials.length>128||new Set(seed.credentials.map(item=>item.integrationID)).size!==seed.credentials.length)return fail('native_setup_credentials_invalid');}
  const digest=bytes?createHash('sha256').update(bytes).digest('hex'):undefined;
  if(platform==='win32'&&(expected===undefined||expected===null&&bytes!==undefined||expected!==null&&expected!==undefined&&(digest!==expected.sha256||seed?.credentials.length!==expected.count)))return fail('native_setup_credentials_changed');
  const captured=seed;
  const result=yield* db.db.$client.withTransaction(Effect.gen(function*(){
   const stamp=yield* kv.get(NATIVE_SETUP_CREDENTIAL_STAMP);
   if(stamp!==undefined){
    let saved:typeof Stamp.Type;try{saved=Schema.decodeUnknownSync(Stamp)(stamp);}catch{return fail('native_setup_credentials_stamp_invalid');}
    if(!/^[a-f0-9]{64}$/.test(saved.sha256)||!Number.isSafeInteger(saved.count)||saved.count<0||saved.count>128||digest!==undefined&&(saved.sha256!==digest||saved.count!==captured?.credentials.length))return fail('native_setup_credentials_stamp_invalid');
    return {status:'already-applied' as const,count:saved.count,sha256:saved.sha256};
   }
   if(!captured||!digest)return {status:'absent' as const,count:0,sha256:null};
   if((yield* credentials.all()).length)return fail('native_setup_credentials_target_not_fresh');
   for(const item of captured.credentials)yield* credentials.create({...item,activate:true});
   yield* kv.set(NATIVE_SETUP_CREDENTIAL_STAMP,{schema:1,sha256:digest,count:captured.credentials.length});
   return {status:'applied' as const,count:captured.credentials.length,sha256:digest};
  })).pipe(Effect.orDie);
  if(platform!=='win32'&&bytes&&result.status!=='absent')yield* Effect.promise(async()=>{const current=await fs.lstat(seedPath);
   if(!identity||current.isSymbolicLink()||current.ino!==identity.ino||current.dev!==identity.dev||current.mtimeMs!==identity.mtimeMs||current.ctimeMs!==identity.ctimeMs)return fail('native_setup_credentials_changed');await fs.unlink(seedPath);});
  return platform==='win32'?result:{status:result.status,count:result.count};
 });
}
