import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {randomBytes,createHmac} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const cache=fileURLToPath(new URL('../../.cache/',import.meta.url)).replace(/\/$/,'');
const fail=code=>Object.assign(new Error(code),{code});

/** Constructor-private keyed windows. No credential bytes or unkeyed digests
 * survive recording; scans report counts, never matches, paths or probe keys. */
export function createCredentialLeakProbe(){
  const key=randomBytes(32),derived=createHmac('sha256',key).update('devryan.qa.windows/1').digest();
  const bases=[(derived.readUInt32LE(0)|257)>>>0,(derived.readUInt32LE(4)|257)>>>0],windows=new Map();derived.fill(0);
  const powers=length=>bases.map(base=>{let power=1;for(let i=1;i<length;i++)power=Math.imul(power,base)>>>0;return power;});
  const hash=bytes=>bases.map(base=>{let value=0;for(const byte of bytes)value=(Math.imul(value,base)+byte)>>>0;return value;});
  const encode=pair=>((pair[0]^key.readUInt32LE(8))>>>0).toString(16)+':'+((pair[1]^key.readUInt32LE(12))>>>0).toString(16);
  const record=value=>{
    if(typeof value!=='string'||!value||Buffer.byteLength(value)>60000)throw fail('qa_leak_probe_value_invalid');
    for(const form of new Set([value,Buffer.from(value).toString('base64'),encodeURIComponent(value)])){
      const bytes=Buffer.from(form),length=Math.min(16,bytes.length);
      if(!windows.has(length))windows.set(length,{probes:new Set(),powers:powers(length)});
      const probes=windows.get(length).probes;
      // ponytail: 16-byte stride detects whole values and fragments >=32 bytes;
      // use every offset only if shorter fragment coverage becomes a gate.
      // Nonoverlapping windows plus the tail detect whole values and any
      // fragment of at least 32 bytes, regardless of its evidence alignment.
      for(let i=0;i<=bytes.length-length;i+=length)probes.add(encode(hash(bytes.subarray(i,i+length))));
      probes.add(encode(hash(bytes.subarray(-length))));bytes.fill(0);
    }
  };
  const scan=async directory=>{
    if(!path.isAbsolute(directory??'')||!directory.startsWith(cache+path.sep)||await fs.realpath(directory)!==directory)throw fail('qa_leak_probe_path_invalid');
    let files=0,bytes=0,hits=0;
    const visit=async current=>{
      const directoryBefore=await fs.lstat(current);
      if(!directoryBefore.isDirectory()||directoryBefore.isSymbolicLink()||(directoryBefore.mode&0o022)||typeof process.getuid==='function'&&directoryBefore.uid!==process.getuid()
        ||await fs.realpath(current)!==current)throw fail('qa_leak_probe_path_invalid');
      for(const entry of await fs.readdir(current,{withFileTypes:true})){
        const file=path.join(current,entry.name),before=await fs.lstat(file);
        if(before.isSymbolicLink()||await fs.realpath(file)!==file)throw fail('qa_leak_probe_path_invalid');
        if(before.isDirectory()){await visit(file);continue;}
        if(!before.isFile()||before.nlink!==1||(before.mode&0o022)||typeof process.getuid==='function'&&before.uid!==process.getuid())throw fail('qa_leak_probe_path_invalid');
        if(++files>100000||before.size>32*1024*1024||(bytes+=before.size)>256*1024*1024)throw fail('qa_leak_probe_bound');
        const handle=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
        try{
          const opened=await handle.stat();
          if(!opened.isFile()||opened.dev!==before.dev||opened.ino!==before.ino||opened.size!==before.size)throw fail('qa_leak_probe_changed');
          let carry=Buffer.alloc(0),position=0;
          for await(const part of handle.readableWebStream()){
            const chunk=Buffer.from(part),data=Buffer.concat([carry,chunk]);
            for(const [length,{probes,powers:power}] of windows){
              if(data.length<length)continue;
              let pair=hash(data.subarray(0,length));
              for(let i=0;i<=data.length-length;i++){
                if(i+length>carry.length&&probes.has(encode(pair)))hits++;
                if(i<data.length-length)pair=pair.map((value,index)=>(Math.imul((value-Math.imul(data[i],power[index]))>>>0,bases[index])+data[i+length])>>>0);
              }
            }
            position+=chunk.length;carry.fill(0);carry=Buffer.from(data.subarray(-15));data.fill(0);chunk.fill(0);part.fill?.(0);
          }
          carry.fill(0);const after=await handle.stat(),linked=await fs.lstat(file);
          if(position!==opened.size||opened.size!==after.size||opened.mtimeMs!==after.mtimeMs||opened.ctimeMs!==after.ctimeMs
            ||after.dev!==linked.dev||after.ino!==linked.ino||linked.nlink!==1||!linked.isFile()||after.mtimeMs!==linked.mtimeMs||after.ctimeMs!==linked.ctimeMs)throw fail('qa_leak_probe_changed');
        }finally{await handle.close();}
      }
      const directoryAfter=await fs.lstat(current);
      if(!directoryAfter.isDirectory()||['dev','ino','mtimeMs','ctimeMs'].some(key=>directoryAfter[key]!==directoryBefore[key])||await fs.realpath(current)!==current)throw fail('qa_leak_probe_changed');
    };
    await visit(directory);return {files,bytes,hits};
  };
  return Object.freeze({record,scan});
}
