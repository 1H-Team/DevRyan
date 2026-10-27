import path from 'node:path';
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);

/** Rebase typed path fields only; output, source code and patch text stay byte-for-byte. */
export function projectNativeMutationResult(result,publication,lease,tool){
 if(!result||!['write','edit','patch','ast_grep_replace'].includes(tool))return result;
 const logical=value=>{
  if(typeof value!=='string'||!path.isAbsolute(value))return value;
  const relative=path.relative(lease.viewDirectory,value);
  return relative===''||relative!=='..'&&!relative.startsWith(`..${path.sep}`)&&!path.isAbsolute(relative)?path.join(lease.projectDirectory,relative):value;
 };
 const metadata=record(result.metadata)?result.metadata:{};
 const files=Array.isArray(metadata.files)?metadata.files.map(file=>record(file)?{...file,
  ...(typeof file.file==='string'?{file:logical(file.file)}:{}),...(typeof file.path==='string'?{path:logical(file.path)}:{}),
  ...(typeof file.filePath==='string'?{filePath:logical(file.filePath)}:{})}:file):undefined;
 const paths=(publication?.files??[]).filter(file=>typeof file.path==='string'&&!path.isAbsolute(file.path)&&!file.path.split(/[\\/]/).includes('..')).map(file=>file.path);
 return {...result,metadata:{...metadata,...(files?{files}:{}),
  ...(typeof metadata.path==='string'?{path:logical(metadata.path)}:{}),...(typeof metadata.filePath==='string'?{filePath:logical(metadata.filePath)}:{}),
  mutationReceipt:{directory:lease.projectDirectory,paths,outcome:publication?.outcome==='partial'?'partial':'published',
   ...(Number.isSafeInteger(lease.baseSequence)&&lease.baseSequence>=0?{baseSequence:lease.baseSequence}:{}),
   ...(Number.isSafeInteger(publication?.sequence)&&publication.sequence>0?{publicationSequence:publication.sequence}:{})}}};
}
