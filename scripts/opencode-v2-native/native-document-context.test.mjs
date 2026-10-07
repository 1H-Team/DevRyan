import {test,expect} from 'bun:test';
import fs from 'node:fs/promises';import path from 'node:path';import {createHash} from 'node:crypto';
import {prepareReviewedNativeInputs,reviewedNativeInputPlugin} from '../native-runtime-assets.mjs';
const repository=path.resolve(import.meta.dirname,'../..');
test('actual reviewed schema and native media/text/omitted document conversion keep unrelated context',async()=>{
 const root=await fs.mkdtemp(path.join(repository,'.cache/v2-validation/document-context-'));
 try{
  const entry=path.join(root,'entry.ts');await fs.writeFile(entry,`export {applyNativeDocumentContext} from ${JSON.stringify(path.join(repository,'packages/web/server/lib/opencode/runtime-host/native-document-plugin.ts'))};\nexport {reviewedDocumentInputSchema} from ${JSON.stringify(path.join(repository,'packages/web/server/default-config/plugins/devryan-document-reader.mjs'))};`);
  const build=await Bun.build({entrypoints:[entry],target:'bun',external:['effect','@opencode/core/*','@opencode/schema/*','@opencode/plugin/*','@opencode/util/*'],plugins:[reviewedNativeInputPlugin(await prepareReviewedNativeInputs(repository))]});
  if(!build.success)throw new AggregateError(build.logs,'document graph failed');const bundle=path.join(root,'bundle.mjs');await fs.writeFile(bundle,await build.outputs[0].text());
  const {applyNativeDocumentContext,reviewedDocumentInputSchema}=await import(bundle);
  expect(reviewedDocumentInputSchema.parse({action:'read',document_id:'doc_123',limit:12})).toEqual({action:'read',document_id:'doc_123',limit:12});
  expect(()=>reviewedDocumentInputSchema.parse({action:'read',limit:32769})).toThrow();
  const hash=text=>createHash('sha256').update(text).digest('hex');
  const original={id:'msg_user',role:'user',content:[{type:'text',text:'User prompt'},
   {type:'media',media:{source:{type:'base64',data:Buffer.from('PDF').toString('base64'),mediaType:'application/pdf'}},filename:'report.pdf'},
   {type:'text',text:'Attached file: note.txt\n\nExact text',metadata:{attachment:{name:'note.txt'}}},
   {type:'media',media:{source:{type:'base64',data:Buffer.from('PNG').toString('base64'),mediaType:'image/png'}},filename:'keep.png'}]};
  const unchanged={id:'msg_other',role:'assistant',content:[{type:'text',text:'unchanged'}]},event={messages:[original,unchanged]};
  const replacement=(name,mime,bytes,text)=>({messageID:'msg_user',partID:name,text,name,mime,sha256:hash(bytes),textLength:bytes.length,textSha256:hash(bytes)});
  applyNativeDocumentContext(event,{parentNote:false,replacements:[replacement('report.pdf','application/pdf','PDF','Rendered PDF'),replacement('note.txt','text/plain','Exact text','Rendered text'),replacement('report.docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document','DOCX','Rendered DOCX')]});
  expect(event.messages[0].content).toEqual([original.content[0],{type:'text',text:'Rendered PDF'},{type:'text',text:'Rendered text'},original.content[3],{type:'text',text:'Rendered DOCX'}]);
  expect(event.messages[1]).toBe(unchanged);
  applyNativeDocumentContext(event,{parentNote:true,replacements:[]});applyNativeDocumentContext(event,{parentNote:true,replacements:[]});
  expect(event.messages[0].content.filter(part=>part.text?.startsWith('Parent-task documents'))).toHaveLength(1);
 }finally{await fs.rm(root,{recursive:true,force:true});}
},120_000);
