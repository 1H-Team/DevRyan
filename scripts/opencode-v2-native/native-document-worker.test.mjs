import {test,expect,afterAll} from 'bun:test';
import fs from 'node:fs/promises';import path from 'node:path';import {createRequire} from 'node:module';import {createHash} from 'node:crypto';
import {prepareReviewedNativeInputs,reviewedNativeInputPlugin} from '../native-runtime-assets.mjs';
import {createNativeAssetFixturePlugin,writeNativeFixtureOutputs} from './native-asset-fixture.mjs';
import {createNativeDocumentParser} from '../../packages/web/server/lib/opencode/runtime-host/native-document-parser.js';
import {createNativeDocumentOwner} from '../../packages/web/server/lib/opencode/runtime-host/native-document-owner.js';
const repository=path.resolve(import.meta.dirname,'../..');
const require=createRequire(path.join(repository,'packages/web/package.json'));

async function prepareGraph(){
 const root=await fs.mkdtemp(path.join(repository,'.cache/v2-validation/document-worker-'));
 const plugin=reviewedNativeInputPlugin(await prepareReviewedNativeInputs(repository));
 const built=await Bun.build({entrypoints:[path.join(repository,'packages/web/server/lib/opencode/runtime-host/writer-worker.ts')],external:['effect','@opencode/core/*','@opencode/schema/*','@opencode/plugin/*','@opencode/util/*'],target:'bun',outdir:root,naming:{entry:'worker.mjs',asset:'[name]-[hash].[ext]'},plugins:[await createNativeAssetFixturePlugin(repository),{name:'owned-sdk-source-entry',setup(builder){builder.onResolve({filter:/^@opencode\/sdk\/effect$/},async()=>({path:await fs.realpath(path.join(repository,'packages/web/node_modules/@opencode/sdk/dist/effect/index.js'))}));}},plugin]});
 if(!built.success)throw new AggregateError(built.logs,'Original document worker graph failed');
 const bundle=path.join(root,'worker.mjs');await writeNativeFixtureOutputs(built.outputs);
 const entry=path.join(root,'original.ts');await fs.writeFile(entry,`export * from ${JSON.stringify(path.join(repository,'packages/web/server/default-config/plugins/devryan-document-reader.mjs'))};export * from ${JSON.stringify(path.join(repository,'packages/web/server/lib/opencode/runtime-host/native-document.ts'))};`);
 const originals=await Bun.build({entrypoints:[entry],target:'bun',plugins:[plugin]});if(!originals.success)throw new AggregateError(originals.logs,'Original document cache graph failed');
 const originalFile=path.join(root,'original.mjs');await fs.writeFile(originalFile,await originals.outputs[0].text());
 return {root,bundle,original:await import(originalFile)};
}
const shared=await prepareGraph(),AdmZip=require('adm-zip');
afterAll(()=>fs.rm(shared.root,{recursive:true,force:true}));
const graph=async()=>({...shared,root:await fs.mkdtemp(path.join(repository,'.cache/v2-validation/document-owned-'))});

test('actual writer artifact parser returns large text and ZIP only after real supervised receipts',async()=>{
 const {root,bundle}=await graph(),receipts=[];
 try{
  const parse=createNativeDocumentParser({launcher:path.join(repository,'packages/web/runtime/darwin-arm64/DevRyan-execution-darwin-arm64'),command:process.execPath,args:[bundle],storage:root,onTermination:receipt=>receipts.push(receipt)});
  const signal=new AbortController().signal,text='Exact document line\n'.repeat(70_000);
  const result=await parse({bytes:Buffer.from(text),name:'actual.txt',type:'text'},signal);expect(result.documents[0].text).toBe(text);
  expect(Buffer.byteLength(result.documents[0].text)).toBeGreaterThan(1024*1024);expect(receipts[0]).toMatchObject({terminated:true,confined:true,cancelled:false,exitCode:0});
  const zip=new AdmZip();zip.addFile('report.csv',Buffer.from('item,value\nExact,42\n'));zip.addFile('nested/note.txt',Buffer.from('Exact nested report'));
  const archived=await parse({bytes:zip.toBuffer(),name:'actual.zip',type:'zip'},signal);expect(archived.documents.map(document=>({name:document.name,text:document.text}))).toEqual([{name:'actual.zip!/nested/note.txt',text:'Exact nested report'},{name:'actual.zip!/report.csv',text:'item,value\nExact,42\n'}]);
  expect(receipts[1]).toMatchObject({terminated:true,confined:true,cancelled:false,exitCode:0});
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>','<< /Length 43 >>\nstream\nBT /F1 12 Tf 72 720 Td (Exact PDF) Tj ET\nendstream','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let pdf='%PDF-1.4\n';const offsets=[];for(const [index,object]of objects.entries()){offsets.push(Buffer.byteLength(pdf));pdf+=`${index+1} 0 obj\n${object}\nendobj\n`;}
  const xref=Buffer.byteLength(pdf);pdf+='xref\n0 6\n0000000000 65535 f \n';for(const offset of offsets)pdf+=String(offset).padStart(10,'0')+' 00000 n \n';pdf+=`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const parsedPdf=await parse({bytes:Buffer.from(pdf),name:'actual.pdf',type:'pdf'},signal);expect(parsedPdf.documents[0].text).toContain('Exact PDF');expect(parsedPdf.documents[0].text).toContain('[Page 1]');expect(receipts[2]).toMatchObject({terminated:true,confined:true,cancelled:false,exitCode:0});
  const docx=new AdmZip();docx.addFile('[Content_Types].xml',Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'));
  docx.addFile('_rels/.rels',Buffer.from('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'));
  docx.addFile('word/document.xml',Buffer.from('<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Exact DOCX</w:t></w:r></w:p></w:body></w:document>'));
  const parsedDocx=await parse({bytes:docx.toBuffer(),name:'actual.docx',type:'docx'},signal);expect(parsedDocx.documents[0].text).toContain('Exact DOCX');expect(receipts[3]).toMatchObject({terminated:true,confined:true,cancelled:false,exitCode:0});
  await expect(parse({bytes:Buffer.from('not PDF'),name:'invalid.pdf',type:'pdf'},signal)).rejects.toThrow('DOCUMENT_');
  expect(receipts[4]).toMatchObject({terminated:true,confined:true,cancelled:false,exitCode:1});
  expect((await fs.readdir(root)).filter(name=>name.startsWith('provider-'))).toEqual([]);
 }finally{await fs.rm(root,{recursive:true,force:true});}
},60_000);

test('parser cancellation waits for actual supervisor exit before rejecting and removes only private parser files',async()=>{
 const {root,bundle}=await graph(),receipts=[],controller=new AbortController();let started;
 try{
  const parse=createNativeDocumentParser({launcher:path.join(repository,'packages/web/runtime/darwin-arm64/DevRyan-execution-darwin-arm64'),command:process.execPath,args:[bundle],storage:root,
   onStarted:handle=>{started=handle.pid;handle.child.stdout.once('data',()=>controller.abort(Error('owned parser cancel')));},onTermination:receipt=>receipts.push(receipt)});
  await expect(parse({bytes:Buffer.from('Exact private document\n'.repeat(500_000)),name:'actual.txt',type:'text'},controller.signal)).rejects.toThrow('owned parser cancel');
  expect(started).toBeGreaterThan(0);expect(receipts).toHaveLength(1);expect(receipts[0]).toMatchObject({terminated:true,confined:true,cancelled:true});
  expect((await fs.readdir(root)).filter(name=>name.startsWith('provider-'))).toEqual([]);
 }finally{await fs.rm(root,{recursive:true,force:true});}
},60_000);

test('canonical owner and exact original cache preserve attachment identity, parent grants, source-last commit and revocation',async()=>{
 const {root,original}=await graph();let live=true,parentAllowed=true,uncertain=false;
 try{
  const directory=path.join(root,'project'),otherDirectory=path.join(root,'other-project'),cacheRoot=path.join(root,'cache');await fs.mkdir(directory);await fs.mkdir(otherDirectory);await fs.mkdir(cacheRoot);
  const part={id:'prt_exact',filename:'actual.txt',mime:'text/plain',url:'data:text/plain;base64,'+Buffer.from('Exact canonical\r\nreport').toString('base64')};
  const sessions={ses_child:{id:'ses_child',directory,parentID:'ses_parent'},ses_parent:{id:'ses_parent',directory},ses_other:{id:'ses_other',directory:otherDirectory}};
  const checks=[],canonicalParts=[{messageID:'msg_canonical',part}];let revokeOnRead=false;
  let factories=0;const maintenance=[];
  const owner=createNativeDocumentOwner({locations:[{directory},{directory:otherDirectory}],cacheRoot,createCache:options=>{
   factories++;return original.createReviewedDocumentCache({...options,authorizeWrite:async(file,context)=>{if(context?.reason==='maintenance')maintenance.push(context.operation);return options.authorizeWrite(file,context);}});
  },
   readSession:async({sessionID})=>sessions[sessionID],readUserAttachments:async({sessionID})=>{if(revokeOnRead)live=false;return sessionID==='ses_parent'?canonicalParts:[];},
   authorizeParent:async input=>{checks.push(input);if(!parentAllowed)throw Error('parent_grant_revoked');},parseAttachment:async payload=>{
    if(uncertain)throw Object.assign(Error('native_document_termination_unconfirmed'),{code:'native_document_termination_unconfirmed',nativeProcessUnsettled:true});
    return original.parseAttachmentPayload(payload);
   }});
  const signal=new AbortController().signal,assertCurrent=async()=>{if(!live)throw Error('original_grant_revoked');};
  const owned=original.createOwnedNativeDocument({originals:original,directory,ownersFor:({sessionID})=>owner.ownersFor({sessionID,directory,assertCurrent,signal})});
  const rendered=await owned.transformAttachment(part,{sessionID:'ses_parent',abort:signal});expect(rendered).toContain('Exact canonical\nreport');
  const other=await owner.ownersFor({sessionID:'ses_other',directory:otherDirectory,assertCurrent,signal}),sourceHash='b'.repeat(64),sourceName='other.txt';
  const otherSource=await other.saveParsedSource({sessionID:'ses_other',sourceHash,sourceName,sourceID:original.createSourceID(sourceHash,sourceName),parsed:{sourceType:'text',documents:[{name:sourceName,type:'text',text:'Unrelated private content'}],manifest:[]}},assertCurrent);
  expect(factories).toBe(1);
  const otherKey=createHash('sha256').update('session\0ses_other').digest('hex'),otherPath=path.join(cacheRoot,otherKey,otherSource.documentRecords[0].id+'.json');
  await fs.utimes(otherPath,new Date(Date.now()-8*24*60*60*1000),new Date(Date.now()-8*24*60*60*1000));
  const parentOwner=await owner.ownersFor({sessionID:'ses_parent',directory,assertCurrent,signal});
  await parentOwner.saveParsedSource({sessionID:'ses_parent',sourceHash:'c'.repeat(64),sourceName:'new.txt',sourceID:original.createSourceID('c'.repeat(64),'new.txt'),parsed:{sourceType:'text',documents:[],manifest:[]}},assertCurrent);
  expect(await fs.stat(otherPath).catch(()=>null)).toBeNull();expect(maintenance).toContain('rm');
  expect(()=>parentOwner.readCachedSource('ses_other',otherSource.id)).toThrow('native_document_scope_mismatch');
  const list=JSON.parse(await owned.tool.execute({action:'list'},{sessionID:'ses_child',abort:signal}));expect(list.documents).toHaveLength(1);expect(list.documents[0]).toMatchObject({scope:'parent',parent_depth:1});expect(checks.length).toBeGreaterThan(2);
  const id=list.documents[0].id;expect(JSON.parse(await owned.tool.execute({action:'read',document_id:id},{sessionID:'ses_child',abort:signal})).text).toBe('Exact canonical\nreport');
  const current=await owner.ownersFor({sessionID:'ses_parent',directory,assertCurrent,signal});
  await expect(current.readAttachment({...part,id:'prt_forged'})).rejects.toThrow('native_document_attachment_not_canonical');
  await expect(current.readAttachment({...part,url:'data:text/plain;base64,'+Buffer.from('Changed').toString('base64')})).rejects.toThrow('native_document_attachment_not_canonical');
  const outside=path.join(root,'outside.txt');await fs.writeFile(outside,'Outside bytes');const link=path.join(directory,'link.txt');await fs.symlink(outside,link);
  const escaped={id:'prt_symlink',filename:'link.txt',url:new URL('file://'+link).href};canonicalParts.push({messageID:'msg_exact_link',part:escaped});
  await expect(current.readAttachment(escaped)).rejects.toThrow('native_document_attachment_root_denied');
  await fs.mkdir(path.join(directory,'.GiT'));const gitFile=path.join(directory,'.GiT/hidden.txt');await fs.writeFile(gitFile,'Git metadata');
  const hidden={id:'prt_git',filename:'hidden.txt',url:new URL('file://'+gitFile).href};canonicalParts.push({messageID:'msg_exact_git',part:hidden});
  await expect(current.readAttachment(hidden)).rejects.toThrow('native_document_attachment_root_denied');
  revokeOnRead=true;await expect(current.readAttachment(part)).rejects.toThrow('original_grant_revoked');live=true;revokeOnRead=false;
  parentAllowed=false;await expect(owned.tool.execute({action:'read',document_id:id},{sessionID:'ses_child',abort:signal})).rejects.toThrow('parent_grant_revoked');
  live=false;await expect(current.saveFailedSource({sessionID:'ses_parent',sourceID:'source_'+'a'.repeat(64),sourceName:'denied',sourceType:'text',failure:{code:'DENIED',message:'Denied'}},assertCurrent)).rejects.toThrow('original_grant_revoked');
  live=true;parentAllowed=true;uncertain=true;
  const unsafe={id:'prt_uncertain',filename:'unsettled.txt',mime:'text/plain',url:'data:text/plain;base64,'+Buffer.from('Unsettled parser bytes').toString('base64')};
  canonicalParts.push({messageID:'msg_unsettled',part:unsafe});
  const parentKey=createHash('sha256').update('session\0ses_parent').digest('hex'),before=await fs.readdir(path.join(cacheRoot,parentKey));
  // This is a propagation regression, not fabricated native termination proof:
  // the original catches parser errors, but unsettled processes must escape it.
  await expect(owned.transformAttachment(unsafe,{sessionID:'ses_parent',abort:signal})).rejects.toMatchObject({code:'native_document_termination_unconfirmed',nativeProcessUnsettled:true});
  expect(await fs.readdir(path.join(cacheRoot,parentKey))).toEqual(before);
 }finally{await fs.rm(root,{recursive:true,force:true});}
},60_000);
