import assert from 'node:assert/strict';
import { evaluate } from './cdp.mjs';

/** Fixture-only UI transport. It never claims to execute or verify a native restore. */
export function createQaChangeProofScript({ origin, sessionID, directory, summary }) {
  const parsed = new URL(origin);
  assert.ok(parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1' && parsed.origin === origin);
  assert.ok(sessionID && directory && summary?.revision);
  return `(() => {
    const origin=${JSON.stringify(origin)},sessionID=${JSON.stringify(sessionID)},directory=${JSON.stringify(directory)},base=${JSON.stringify(summary)};
    if(location.origin!==origin)return;
    const key='__devryanQaChangeProof',original=globalThis.fetch.bind(globalThis);
    if(globalThis[key])throw Error('Fixture already installed');
    const state={revision:base.revision,proof:{version:1,digest:'a'.repeat(64)},undone:false,staleNext:false,requests:[],closed:false};
    const advance=()=>{state.revision=state.revision==='b'.repeat(64)?'c'.repeat(64):'b'.repeat(64);state.proof={version:1,digest:state.proof.digest==='d'.repeat(64)?'e'.repeat(64):'d'.repeat(64)};};
    const wrapper=async(input,init)=>{
      const req=typeof Request!=='undefined'&&input instanceof Request?input:null,url=new URL(req?req.url:String(input),location.href);
      const prefix='/api/devryan/session/'+encodeURIComponent(sessionID)+'/changes';
      if(state.closed||url.origin!==origin||!(url.pathname===prefix||url.pathname===prefix+'/undo'||url.pathname===prefix+'/redo'))return original(input,init);
      const method=String(init?.method??req?.method??'GET').toUpperCase(),query=url.searchParams;
      if(query.get('directory')!==directory||query.getAll('directory').length!==1||[...query.keys()].some(key=>key!=='directory'))throw Error('Fixture scope mismatch');
      if(url.pathname===prefix&&method==='GET')return Response.json({...base,revision:state.revision,undone:state.undone,restoreAvailable:true,restoreReasons:[],restoreProof:state.proof});
      if(method!=='POST'||!['/undo','/redo'].some(suffix=>url.pathname===prefix+suffix))throw Error('Fixture operation refused');
      const body=JSON.parse(String(init?.body??''));const action=url.pathname.endsWith('/undo')?'undo':'redo';
      state.requests.push({action,body});
      if(state.staleNext){state.staleNext=false;advance();return Response.json({code:'restore_proof_stale',error:'restore_proof_stale'},{status:409});}
      if(body.revision!==state.revision||body.restoreProof?.version!==state.proof.version||body.restoreProof?.digest!==state.proof.digest||state.undone!==(action==='redo'))
        return Response.json({code:'restore_proof_stale',error:'restore_proof_stale'},{status:409});
      state.undone=action==='undo';advance();return Response.json({undone:state.undone});
    };
    state.restore=()=>{state.closed=true;if(globalThis.fetch===wrapper)globalThis.fetch=original;};
    Object.defineProperty(globalThis,key,{value:state,configurable:true});globalThis.fetch=wrapper;
  })();`;
}

export async function installQaChangeProof({ cdp, origin, sessionID, directory, summary }) {
  assert.equal(await evaluate(cdp, 'location.origin'), origin);
  const { identifier } = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: createQaChangeProofScript({ origin, sessionID, directory, summary }) });
  return { close: async () => {
    await evaluate(cdp, `globalThis.__devryanQaChangeProof?.restore()`);
    await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier });
  } };
}
