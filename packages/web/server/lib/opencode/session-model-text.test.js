import { describe, expect, it, vi } from 'vitest';
import { classifySessionModelProviderError, generateTextWithSessionModel, sessionModelFailureReasonForStatus } from './session-model-text.js';

describe('native model-text boundary', () => {
  it.each([undefined, {}, { generation: () => 1 }, { generation: () => 3 }])('refuses unsupported identity without helper effects: %j', async openCodeClient => {
    const fetchImpl = vi.fn(); const buildOpenCodeUrl = vi.fn();
    expect(await generateTextWithSessionModel({ openCodeClient, fetchImpl, buildOpenCodeUrl }))
      .toMatchObject({ ok: false, reason: 'runtime_unavailable', attempts: 0, error: { code: 'opencode_generation_invalid' } });
    expect(fetchImpl).not.toHaveBeenCalled(); expect(buildOpenCodeUrl).not.toHaveBeenCalled();
  });
  it('requires an admitted native helper owner before any inference or session creation', async () => {
    const fetchImpl = vi.fn(); const sessions = { create: vi.fn() }; const accept = vi.fn();
    expect(await generateTextWithSessionModel({ openCodeClient: { generation: () => 2, sessions }, fetchImpl, accept }))
      .toMatchObject({ ok: false, reason: 'capability_absent', capability: 'session_model_text', attempts: 0 });
    expect(fetchImpl).not.toHaveBeenCalled(); expect(sessions.create).not.toHaveBeenCalled(); expect(accept).not.toHaveBeenCalled();
  });
  it.each([[429, 'rate_limited'], [401, 'unauthorized'], [404, 'model_unavailable'], [503, 'upstream_error'], [400, 'request_failed']])('preserves provider classification %i', (status, reason) => {
    expect(sessionModelFailureReasonForStatus(status)).toBe(reason);
    expect(classifySessionModelProviderError({ data: { statusCode: status } })).toEqual({ reason, status });
  });
  it('keeps unavailable-model and free-tier error classification', () => {
    expect(classifySessionModelProviderError({ name: 'ProviderModelNotFoundError' }).reason).toBe('model_unavailable');
    expect(classifySessionModelProviderError({ data: { message: 'Free tier can only be used by OpenCode' } }).reason).toBe('free_tier_rejected');
  });
  it('uses exact supplied model text and waits for the first settled result before repair', async () => {
    const calls=[];let resolve;const original=new Promise(done=>{resolve=done;});
    const generateHelperText=vi.fn(async request=>{calls.push(request);return calls.length===1?original:{text:'valid'};});
    const work=generateTextWithSessionModel({openCodeClient:{generation:()=>2},generateHelperText,directory:'/fixture',providerID:'owned',modelID:'m2',variant:'high',agent:'devryan-commit',prompt:'Original',repairPrompt:'Repair',accept:text=>text==='valid'?text:null});
    await Promise.resolve();expect(calls).toHaveLength(1);resolve({text:'invalid'});expect(await work).toMatchObject({ok:true,value:'valid',attempts:2});
    expect(calls.map(x=>[x.prompt,x.modelID,x.variant])).toEqual([['Original','m2','high'],['Repair','m2','high']]);
    expect(calls[0].operationID).toBeTruthy();expect(calls[1].operationID).toBe(calls[0].operationID);
  });
  it('returns unsettled before timeout classification and never starts repair',async()=>{
    const abort=new AbortController();const generateHelperText=vi.fn(async()=>{abort.abort();throw Object.assign(Error('held'),{code:'native_helper_unsettled',statusCode:503});});
    expect(await generateTextWithSessionModel({openCodeClient:{generation:()=>2},generateHelperText,directory:'/fixture',providerID:'owned',modelID:'m2',agent:'devryan-commit',prompt:'Original',repairPrompt:'Repair',signal:abort.signal}))
      .toMatchObject({reason:'unsettled',code:'native_helper_unsettled',attempts:1});
    expect(generateHelperText).toHaveBeenCalledTimes(1);
  });
  it('preserves Cursor raw text with the selected model and never creates a helper session', async()=>{
    const generateText=vi.fn(async()=> '# Raw\n\nBody');const create=vi.fn();
    expect(await generateTextWithSessionModel({openCodeClient:{generation:()=>2,sessions:{create}},cursorRuntime:{generateText},directory:'/fixture',providerID:'cursor-acp',modelID:'selected',agent:'devryan-commit',prompt:'Exact'})).toMatchObject({ok:true,value:'# Raw\n\nBody'});
    expect(generateText).toHaveBeenCalledWith(expect.objectContaining({modelID:'selected',text:'Exact'}));expect(create).not.toHaveBeenCalled();
  });

});
