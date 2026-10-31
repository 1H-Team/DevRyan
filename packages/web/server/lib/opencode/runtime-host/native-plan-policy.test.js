import { expect, it } from 'vitest';
import { createNativeAdmissionOwner } from './native-admission-owner.js';
const fixture = () => {
  let readOnly = true;
  const sessionID = 'ses_plan', directory = '/fixture/plan';
  const owner = createNativeAdmissionOwner({ directory, ownerID: 'fixture',
    runtime: { registerNativeSession: async () => {}, nativeAdmissionState: async () => ({ held: false, revision: 0 }) },
    getSession: async id => ({ id, directory }), authorizeOperation: async () => {},
    readPlanPolicy: async () => ({ readOnly, objectiveID: 'msg_original' }) });
  const request = toolID => ({ operation: 'tool.execute', sessionID, messageID: 'msg_assistant',
    input: { toolID, callID: 'call_fixture', provenance: {kind:'native',id:`opencode.tool.${toolID}`}, input: { readOnly: false } } });
  return { owner, request, directory, sessionID, setReadOnly: value => { readOnly = value; } };
};
it.each(['write', 'edit', 'patch', 'apply_patch', 'ast_grep_replace', 'gpt_imagegen'])('rejects %s from canonical Plan policy regardless of caller flags', async tool => {
  const f = fixture();
  try { await expect(f.owner.handleRpc('native.admission.authorize', f.request(tool))).rejects.toMatchObject({ code: 'native_plan_write_denied' }); }
  finally { f.owner.dispose(); }
});
it.each(['read','glob','grep','skill','webfetch','websearch','question','shell'])('preserves trusted native Plan %s authority', async tool => {
  const f=fixture();try{expect((await f.owner.handleRpc('native.admission.authorize',f.request(tool))).sessionID).toBe(f.sessionID);}finally{f.owner.dispose();}
});
it.each([
  {toolID:'mcp.server_delete',provenance:{kind:'native',id:'opencode.tools'}},
  {toolID:'plugin_read',provenance:{kind:'plugin',id:'unknown-plugin'}},
  {toolID:'read',provenance:{kind:'plugin',id:'unknown-plugin'}},
  {toolID:'devryan_browser',provenance:{kind:'plugin',id:'devryan.browser'}},
  {toolID:'devryan_operation',provenance:{kind:'native',id:'devryan.host-operations'}},
])('unknown Plan effects remain denied even with read-only annotations: $toolID',async input=>{
  const f=fixture();try{await expect(f.owner.handleRpc('native.admission.authorize',{...f.request(input.toolID),input:{...input,callID:'call_fixture',annotations:{readOnlyHint:true},input:{readOnly:true}}})).rejects.toMatchObject({code:'native_plan_write_denied',
    message:expect.stringMatching(new RegExp(`^native_plan_write_denied: Plan mode cannot run ${input.toolID}\\. .*Verification`))});}finally{f.owner.dispose();}
});
it.each([
  ['devryan.managed-task','devryan_task'],['devryan.harness-context','todoread'],['devryan.harness-context','todowrite'],
  ['devryan.managed-task','devryan_plan_read'],
  ['devryan.document-reader','devryan_document'],['devryan.slim','ast_grep_search'],['devryan.slim','webfetch'],
])('preserves separately owned Plan tool %s/%s',async (id,toolID)=>{
  const f=fixture();try{await f.owner.handleRpc('native.admission.authorize',{...f.request(toolID),input:{toolID,provenance:{kind:'plugin',id}}});}finally{f.owner.dispose();}
});
it('captures readonly shell policy and revokes the retained permit if authority changes', async () => {
  const f = fixture();
  try {
    const authorization = f.request('shell'), permit = await f.owner.handleRpc('native.admission.authorize', authorization);
    const input = { directory: f.directory, sessionID: f.sessionID, messageID: 'msg_assistant', callID: 'call_fixture', tool: 'shell', authorization, permit };
    expect(await f.owner.readOnlyExecution(input)).toBe(true);
    f.setReadOnly(false);
    await expect(f.owner.readOnlyExecution(input)).rejects.toMatchObject({ code: 'native_plan_policy_changed' });
    const writer = await f.owner.handleRpc('native.admission.authorize', f.request('write'));
    expect(writer.sessionID).toBe(f.sessionID);
  } finally { f.owner.dispose(); }
});
it('a refused Implement selection never invokes the accepted operation', async () => {
  let invoked = false;
  const owner = createNativeAdmissionOwner({ directory: '/fixture', ownerID: 'fixture', runtime: { nativeAdmissionState: async () => ({ revision: 0, held: false }), registerNativeSession: async () => {} },
    getSession: async id => ({ id, directory: '/fixture' }), authorizeOperation: async () => {},
    validatePlanImplementation: async () => { throw Object.assign(Error('stale'), { code: 'plan_source_stale' }); } });
  try {
    await expect(owner.withAcceptedOperation({ sessionID: 'ses_plan', messageID: 'msg_implement', fingerprint: 'a'.repeat(64), metadata: {}, intent: { parts: [] } }, async () => { invoked = true; })).rejects.toMatchObject({ code: 'plan_source_stale' });
    expect(invoked).toBe(false);
  } finally { owner.dispose(); }
});
it.each(['readPlanPolicy', 'validatePlanImplementation'])('Plan admission requires its %s hook independently', async missing => {
  const options = { directory:'/fixture', ownerID:'fixture',
    runtime:{ nativeAdmissionState:async()=>({revision:0,held:false}), registerNativeSession:async()=>{} },
    getSession:async id=>({id,directory:'/fixture'}), authorizeOperation:async()=>{},
    readPlanPolicy:async()=>({readOnly:true}), validatePlanImplementation:async()=>{} };
  delete options[missing];
  const owner=createNativeAdmissionOwner(options);
  try {
    await expect(owner.withAcceptedOperation({sessionID:'ses_plan',messageID:'msg_plan',fingerprint:'a'.repeat(64),metadata:{devryan:{planMode:true}}},async()=>{}))
      .rejects.toMatchObject({code:'native_plan_policy_unavailable'});
  } finally { owner.dispose(); }
});
it('read-only OpenCode children require canonical policy even without Plan prompt metadata', async () => {
  const dispatch={operation:'prompt',taskId:'dvr_task_one',leaseToken:'lease_one',directory:'/fixture',sessionID:'ses_child',providerId:'openai',modelId:'model',agent:'builder',variant:null};
  const task={...dispatch,owner:'devryan',status:'running',rootSessionId:'ses_root',childSessionId:'ses_child',dispatchCallId:'call_task',readOnly:true};
  const owner=createNativeAdmissionOwner({directory:'/fixture',ownerID:'fixture',
    runtime:{registerNativeSession:async()=>{},nativeAdmissionState:async()=>({revision:0,held:false,reverting:false}),
      capturedSessionState:async()=>({captured:true,pending:false,generation:1}),
      leaseForCall:async()=>({executionKind:'control',preparation:'none',state:'published',generation:1,directory:'/fixture',scope:{sessionID:'ses_root',callID:'call_task'}})},
    getSession:async id=>({id,directory:'/fixture',...(id==='ses_child'?{parentID:'ses_root'}:{})}),
    verifyManagedTaskDispatch:async()=>({...task}),authorizeOperation:async()=>{} });
  try {
    await expect(owner.withManagedTaskDispatch(dispatch,()=>owner.withAcceptedOperation({sessionID:'ses_child',messageID:'msg_child',fingerprint:'a'.repeat(64),metadata:{}},async()=>{})))
      .rejects.toMatchObject({code:'native_plan_policy_unavailable'});
    task.readOnly=false;
    await owner.withManagedTaskDispatch(dispatch,()=>owner.withAcceptedOperation({sessionID:'ses_child',messageID:'msg_child',fingerprint:'a'.repeat(64),metadata:{}},async()=>{}));
  } finally {owner.dispose();}
});
it.each([
  { metadata: { devryan: { planMode: true } } },
  { metadata: { devryan: { agent: 'plan', planMode: false } } },
  { intent: { agent: 'plan', parts: [] } },
  { request: { agent: 'plan', parts: [] } },
  { intent: { planMode: true } },
  { intent: { parts: [{ type:'text', synthetic:true, text:'User has requested to enter plan mode' }] } },
  { intent: { parts: [{ type:'text', synthetic:true, text:'[openchamber-plan-action:v1] {}' }] } },
])('Plan admission fails closed with absent enforcement hooks: $metadata', async variant => {
  let invoked = false;
  const owner = createNativeAdmissionOwner({ directory:'/fixture', ownerID:'fixture',
    runtime:{ nativeAdmissionState:async()=>({revision:0,held:false}), registerNativeSession:async()=>{} },
    getSession:async id=>({id,directory:'/fixture'}), authorizeOperation:async()=>{} });
  try {
    await expect(owner.withAcceptedOperation({sessionID:'ses_plan',messageID:'msg_plan',fingerprint:'a'.repeat(64),metadata:{},...variant},async()=>{invoked=true;}))
      .rejects.toMatchObject({code:'native_plan_policy_unavailable'});
    expect(invoked).toBe(false);
    await owner.withAcceptedOperation({sessionID:'ses_normal',messageID:'msg_normal',fingerprint:'b'.repeat(64),metadata:{devryan:{planMode:false}},intent:{parts:[]}},async()=>{invoked=true;});
    expect(invoked).toBe(true);
  } finally { owner.dispose(); }
});
