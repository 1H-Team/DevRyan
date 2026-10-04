import { evaluate } from './cdp.mjs';

const id = value => typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,128}$/.test(value) ? value : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const counts = value => Object.fromEntries(Object.entries(value ?? {}).slice(0,128)
  .filter(([key,value]) => id(key) && count(value) !== null));
const selection = value => ({ providerID:id(value?.providerID), modelID:id(value?.modelID),
  agent:id(value?.agent), variant:id(value?.variant), planMode:typeof value?.planMode==='boolean'?value.planMode:null });

export const qaFixtureFailureUiExpression = `(() => {
  const sessionID=new URL(location.href).searchParams.get('session');
  const queues=[];let unavailable=false;
  for(let i=0;i<Math.min(localStorage.length,256);i++){
    const key=localStorage.key(i);
    if(key!=='message-queue-store'&&!/^devryan\\.user\\.(anonymous|local-admin):message-queue-store$/.test(key??''))continue;
    const raw=localStorage.getItem(key);
    if(!raw||raw.length>1048576){unavailable=true;continue;}
    try{const saved=JSON.parse(raw).state;
      for(const [owner,items] of Object.entries(saved?.queuedMessages??{}).slice(0,8)){
        if(!Array.isArray(items))continue;
        for(const item of items.slice(0,32))queues.push({sessionID:owner,id:item.id,messageID:item.messageId,
          createdAt:item.createdAt,sendConfig:item.sendConfig});
      }
    }catch{unavailable=true;}
  }
  const stopVisible=[...document.querySelectorAll('button')].some(e=>e.getAttribute('aria-label')==='Stop Generating'&&e.getBoundingClientRect().width>0&&!e.disabled);
  return {sessionID,queues,unavailable,stopVisible};
})()`;

/** Failure-only metadata; never retain prompt, attachment, credential or tool content. */
export async function captureQaFixtureFailureSnapshot({ cdp, fixture, api, directory, evaluateUi = evaluate, fetchImpl = fetch }) {
  const ui=await evaluateUi(cdp,qaFixtureFailureUiExpression);
  const state=fixture.getState();
  const prompts=state.receivedPrompts.slice(-32).map(row=>({sessionID:id(row.sessionID),messageID:id(row.messageID),
    ...selection({...row.model,agent:row.agent,variant:row.variant,planMode:row.planMode}),partCount:count(row.partTypes?.length)}));
  const queues=(Array.isArray(ui.queues)?ui.queues:[]).slice(0,256).map(row=>({sessionID:id(row.sessionID),
    id:id(row.id),messageID:id(row.messageID),createdAt:count(row.createdAt),selection:selection(row.sendConfig)}));
  const sessionIDs=[...new Set([id(ui.sessionID),...queues.map(row=>row.sessionID),...prompts.map(row=>row.sessionID)].filter(Boolean))].slice(0,8);
  const status=await api(`/api/session/status?directory=${encodeURIComponent(directory)}`);
  const statusSnapshotValid=Boolean(status&&typeof status==='object'&&!Array.isArray(status)
    &&Object.values(status).every(value=>value&&['idle','busy','retry'].includes(value.type)));
  const sessions=await Promise.all(sessionIDs.map(async sessionID=>{
    const rows=await api(`/api/session/${sessionID}/message?directory=${encodeURIComponent(directory)}`);
    const response=await fetchImpl(`${fixture.origin}/api/session/${encodeURIComponent(sessionID)}/inbox`,{
      headers:{...fixture.authHeaders,'x-opencode-directory':encodeURIComponent(directory)},signal:AbortSignal.timeout(3000)});
    if(!response.ok)throw new Error(`qa_failure_inbox_http_${response.status}`);
    const bytes=await response.text();if(bytes.length>1048576)throw new Error('qa_failure_inbox_bound');
    const body=JSON.parse(bytes);if(!Array.isArray(body.data))throw new Error('qa_failure_inbox_shape');
    return {sessionID,status:!statusSnapshotValid?{type:'unavailable'}:
      status[sessionID]?{type:id(status[sessionID].type)}:{type:'omitted-idle'},
      canonical:rows.slice(-32).map(row=>({id:id(row.info?.id),role:id(row.info?.role),parentID:id(row.info?.parentID),
        createdAt:count(row.info?.time?.created),completedAt:count(row.info?.time?.completed),finish:id(row.info?.finish),
        errorName:id(row.info?.error?.name),partCount:count(row.parts?.length)})),
      inbox:body.data.slice(0,128).map(row=>({id:id(row.id),type:id(row.type),delivery:id(row.delivery)}))};
  }));
  return {schema:1,scope:'Synthetic transport failure only; native provider journal coverage unavailable',
    ui:{sessionID:id(ui.sessionID),stopVisible:ui.stopVisible===true,queues,queueReadUnavailable:ui.unavailable===true,
      liveStatus:'not exposed by renderer public diagnostic API'},
    fixture:{receivedPrompts:prompts,statusSnapshotValid,activePrompts:count(state.activePrompts),executingSessions:(state.executingSessions??[]).slice(0,128).map(id),
      eventCounts:counts(state.eventCounts),statusRequestCount:count(state.statusRequestCount),messageRequestCounts:counts(state.messageRequestCounts),
      sseConnectionCount:count(state.sseConnectionCount)},sessions};
}
