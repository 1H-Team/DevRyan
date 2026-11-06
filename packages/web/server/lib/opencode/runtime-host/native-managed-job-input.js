import path from 'node:path';

const invalid=()=>Object.assign(new Error('native_managed_job_scope_invalid'),{code:'native_managed_job_scope_invalid',status:403,statusCode:403});
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const text=value=>typeof value==='string'&&value.length>0&&value.length<=512&&!value.includes('\0');
const fields=['taskId','leaseToken','rootSessionId','directory','sessionID','providerId','modelId','agent','variant'];
const segmentFields=['messageID','jobID','notificationID'];
/** Constructor-only terminal proof; JSON/protocol fields cannot manufacture it. */
export const NATIVE_MANAGED_JOB_COMPLETION=Symbol('DevRyan/native-managed-job-completion');
export const NATIVE_MANAGED_JOB_PHASES=Object.freeze(['prepare','activate','cancelSegment','cancelTask','acknowledge']);
export function nativeManagedJobInput(value,phase){
  if(!NATIVE_MANAGED_JOB_PHASES.includes(phase)||!record(value))throw invalid();
  const allowed=[...fields,...phase==='cancelTask'?['segments']:segmentFields,...phase==='acknowledge'?['envelopeID']:[]];
  if(Object.keys(value).some(key=>!allowed.includes(key))||fields.some(key=>key!=='variant'&&key!=='directory'&&!text(value[key]))
    ||typeof value.directory!=='string'||!path.isAbsolute(value.directory)||value.directory.includes('\0')
    ||value.variant!==null&&!text(value.variant)||value.providerId==='cursor-acp'
    ||!/^ses[0-9A-Za-z_-]{1,128}$/.test(value.sessionID)||!/^ses[0-9A-Za-z_-]{1,128}$/.test(value.rootSessionId)
    ||value.sessionID===value.rootSessionId)throw invalid();
  const segment=item=>{
    if(!record(item)||segmentFields.some(key=>!text(item[key]))||!/^msg[0-9A-Za-z_-]{1,128}$/.test(item.messageID)
      ||!/^msg[0-9A-Za-z_-]{1,128}$/.test(item.notificationID)||item.messageID===item.notificationID
      ||item.jobID===value.sessionID)throw invalid();
  };
  if(phase==='cancelTask'){
    if(!Array.isArray(value.segments))throw invalid();
    for(const item of value.segments){if(!record(item)||Object.keys(item).some(key=>!segmentFields.includes(key)))throw invalid();segment(item);}
    if(new Set(value.segments.map(item=>item.jobID)).size!==value.segments.length)throw invalid();
  }else segment(value);
  if(phase==='acknowledge'&&!text(value.envelopeID))throw invalid();
  return structuredClone(value);
}
