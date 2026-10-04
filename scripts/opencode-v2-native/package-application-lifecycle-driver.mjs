import assert from 'node:assert/strict';
import { Console } from 'node:console';
import fs from 'node:fs/promises';
import path from 'node:path';
import { openApplicationStopStream } from './package-application-stop-stream.mjs';
import { waitFor } from './process-lanes.mjs';
import { readBundleConversationRows } from './package-bundle-upgrade-lane.mjs';
import { createV2MessageId } from '../../packages/web/server/lib/opencode/v2/admission.js';
import { readManagedOpenCodeRegistry } from '../../packages/web/server/lib/opencode/managed-process-registry.js';

globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });
// The original A-issued grant crosses only the owned parent/child IPC pipe.
// It is never serialized into stdin, results, logs, or fixture evidence.
const sharedOwner=new Promise((resolve,reject)=>process.once('message',message=>{
 if(message?.type!=='application-owner-session'||!(message.owner===null||(typeof message.owner?.name==='string'&&typeof message.owner?.value==='string'&&message.owner.name.length<=256&&message.owner.value.length<=8192)))return reject(Error('Invalid private owner-session handoff'));
 resolve(message.owner);
}));
process.send({type:'application-owner-session-ready'});
let bytes = '';
for await (const chunk of process.stdin) { bytes += chunk; assert.ok(Buffer.byteLength(bytes) <= 65536); }
const input = JSON.parse(bytes);
assert.ok(['upgrade', 'rollback', 'rollback-crash', 'inspection', 'resumed-inspection', 'parent-death'].includes(input.mode));
const { selectedRuntimeBundle: binding } = await import('../../packages/web/server/lib/opencode/runtime-host/runtime-bundle-binding.js');
assert.ok(binding && binding.admission !== 'held');
const { startWebUiServer } = await import('../../packages/web/server/index.js');
let server, result, stopProof, candidateStopHistory, stopStream;
try {
  // Actual entry imports and application owners, not a hand-built native graph.
  server = await startWebUiServer({ host: '127.0.0.1', port: 0, attachSignals: false });
  const origin = `http://127.0.0.1:${server.getPort()}`;
  await waitFor(() => server.isReady(), Boolean, 'Production application native startup did not become ready', 120000);
  const receivedOwner=await sharedOwner,owner=receivedOwner??await server.issueLocalOwnerSession(); assert.ok(owner?.name && owner?.value);
  if(!receivedOwner)await new Promise((resolve,reject)=>process.send({type:'application-owner-session',owner:{name:owner.name,value:owner.value}},error=>error?reject(error):resolve()));
  const api = async (route, body) => {
    const response = await fetch(origin + route, { method: body === undefined ? 'GET' : 'POST',
      headers: { origin, cookie: `${owner.name}=${owner.value}`, 'content-type': 'application/json', 'x-devryan-csrf': '1',
        'x-opencode-directory': encodeURIComponent(input.directory) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
    assert.equal(response.ok, true, `Production application request failed: ${route.split('?')[0]} HTTP ${response.status}`);
    if (response.status === 204) { assert.equal(await response.text(), ''); return null; }
    return response.json();
  };
  const messages = sessionID => api(`/api/session/${sessionID}/message?directory=${encodeURIComponent(input.directory)}`);
  const history = {};
  for (const sessionID of input.sessionIDs ?? []) {
    const rows = await messages(sessionID); assert.ok(rows.length > 0); history[sessionID] = rows.map(row => row.info.id);
    if (input.history?.[sessionID]) assert.deepEqual(history[sessionID], input.history[sessionID], 'Recomposition merged or replayed history');
  }
  const registryPath = path.join(binding.descriptor.launch.global.state, 'managed-opencode-processes.json');
  const controllers = () => readManagedOpenCodeRegistry({ registryPath }).filter(row => row.ownerPid === process.pid);
  const initialControllers = controllers(); assert.equal(initialControllers.length, 1);
  const prompt = async (sessionID,text) => {
    const messageID=createV2MessageId();
    await api(`/api/session/${sessionID}/prompt_async?directory=${encodeURIComponent(input.directory)}`, {
      messageID, agent: 'builder', variant: 'high', model: { providerID: 'devryan-smoke', modelID: 'smoke-write' }, parts: [{ type: 'text', text }] });
    return messageID;
  };
  const stopConversation=async sessionID=>{
    const beforeStop = await messages(sessionID);
    const deadline=Date.now()+30000;
    stopProof={sessionID,scope:input.mode==='upgrade'?'old-A-streaming-Stop':'candidate-B-streaming-Stop',
      bundleID:binding.descriptor.bundleID,manifestSha256:binding.descriptor.launch.artifactManifestSha256};
    stopStream=await openApplicationStopStream({origin,directory:input.directory,sessionID,deadline,
      headers:{origin,cookie:`${owner.name}=${owner.value}`,'x-opencode-directory':encodeURIComponent(input.directory)}});
    stopProof.submittedAt=Date.now();
    const stopUserID=await prompt(sessionID,'Write 250 numbered one-line test cases.');stopProof.userID=stopUserID;
    const streamingAssistant=row=>row.info.role==='assistant' && row.info.parentID===stopUserID && !row.info.time?.completed
      && stopStream.witness(row.info.id,row.parts);
    const active=await waitFor(async()=>{
      stopStream.requireOpen();
      return {rows:await messages(sessionID),status:await api(`/api/session/status?directory=${encodeURIComponent(input.directory)}`)};
    },value=>{stopStream.requireOpen();return value.status[sessionID]?.type==='busy' && value.rows.some(streamingAssistant);},
      'Production Stop never observed its exact native streaming assistant',Math.max(1,deadline-Date.now()));
    const activeAssistant=active.rows.find(streamingAssistant);
    assert.ok(activeAssistant,'Production Stop lost its live streaming assistant');
    const streamEvent=stopStream.witness(activeAssistant.info.id,activeAssistant.parts);
    assert.ok(streamEvent && streamEvent.readyAt<=stopProof.submittedAt && streamEvent.observedAt>=stopProof.submittedAt);
    Object.assign(stopProof,{assistantID:activeAssistant.info.id,streamObservedAt:streamEvent.observedAt,streamedTextBytes:streamEvent.deltaBytes,streamEvent});
    stopStream.requireOpen();
    const stopRequestedAt=Date.now();stopProof.stopRequestedAt=stopRequestedAt;
    const abortAcknowledgement=await api(`/api/session/${sessionID}/abort?directory=${encodeURIComponent(input.directory)}`, {});
    stopProof.abortAcknowledgement=abortAcknowledgement===true;
    assert.equal(abortAcknowledgement,true);
    const stopped = await waitFor(() => messages(sessionID), rows => rows.length > beforeStop.length
      && rows.some(row=>row.info.id===activeAssistant.info.id && row.info.time?.completed && row.info.error), 'Production Stop did not settle its exact canonical assistant');
    await waitFor(()=>api(`/api/session/status?directory=${encodeURIComponent(input.directory)}`),status=>!status[sessionID]||status[sessionID].type==='idle','Stopped native attempt remained busy');
    const nativeRows=readBundleConversationRows(binding.descriptor).messages.filter(row=>row.session_id===sessionID);
    const nativeAssistant=nativeRows.find(row=>row.id===activeAssistant.info.id);assert.ok(nativeAssistant);
    const nativeData=typeof nativeAssistant.data==='string'?JSON.parse(nativeAssistant.data):nativeAssistant.data;
    assert.equal(nativeData.error?.type,'aborted');assert.ok(nativeData.time.completed>=stopRequestedAt);
    const idle=nativeRows.find(row=>row.type==='idle'&&row.seq>nativeAssistant.seq);assert.ok(idle);
    const idleData=typeof idle.data==='string'?JSON.parse(idle.data):idle.data;assert.equal(idleData.outcome,'interrupted');
    Object.assign(stopProof,{nativeCompletedAt:nativeData.time.completed,nativeError:nativeData.error.type,nativeIdleOutcome:idleData.outcome});
    await stopStream.close();stopStream=undefined;
    return stopped;
  };
  if (input.mode === 'upgrade') {
    const session = await api('/api/session?directory=' + encodeURIComponent(input.directory), {
      title: 'Production application owned conversation', model: { providerID: 'devryan-smoke', modelID: 'smoke-write', variant: 'high' }, agent: 'builder' });
    await prompt(session.id,'Reply exactly: DevRyan live QA ready.');
    await waitFor(() => messages(session.id), rows => rows.some(row => row.info.role === 'assistant' && row.info.time?.completed && !row.info.error),
      'Production application conversation did not settle');
    const stopped = await stopConversation(session.id);
    history[session.id] = stopped.map(row => row.info.id);
    await server.restartOpenCode();
    await waitFor(() => server.isReady(), Boolean, 'Production restart never became ready', 120000);
    assert.equal(controllers().length, 1); assert.notEqual(controllers()[0].childPid, initialControllers[0].childPid);
    assert.deepEqual((await messages(session.id)).map(row => row.info.id), history[session.id]);
    const available = await api('/api/runtime/bundle'); assert.equal(available.state, 'upgrade_available');
    const transition = await api('/api/runtime/bundle/upgrade', { expectedRevision: available.revision });
    assert.equal(transition.transition, 'upgrade'); assert.equal(transition.restartRequired, true);
    assert.equal(transition.reconciliationRequired, false); assert.notEqual(transition.bundleID, binding.descriptor.bundleID);
    result = { status: 'passed', mode: input.mode, history, sessionIDs: Object.keys(history), transition,stopProof,
      source: 'server/index-application-native-conversation-Stop-restart-and-authenticated-upgrade-route' };
  } else if (input.mode === 'rollback' || input.mode === 'rollback-crash') {
    const candidate = await api('/api/session?directory=' + encodeURIComponent(input.directory), { title: 'Candidate-only production work',
      model: { providerID: 'devryan-smoke', modelID: 'smoke-write', variant: 'high' }, agent: 'builder' });
    await api(`/api/session/${candidate.id}/prompt_async?directory=${encodeURIComponent(input.directory)}`, { messageID: createV2MessageId(), agent: 'builder', variant: 'high',
      model: { providerID: 'devryan-smoke', modelID: 'smoke-write' }, parts: [{ type: 'text', text: 'Reply exactly: DevRyan live QA ready.' }] });
    await waitFor(() => messages(candidate.id), rows => rows.some(row => row.info.role === 'assistant' && row.info.time?.completed && !row.info.error), 'Candidate-only work did not settle');
    const candidateStopped=await stopConversation(candidate.id);
    candidateStopHistory=candidateStopped.map(row=>row.info.id);
    const current = await api('/api/runtime/bundle');
    if(input.mode==='rollback-crash')await new Promise((resolve,reject)=>process.send({type:'application-rollback-crash-ready',revision:current.revision,bundleID:binding.descriptor.bundleID,
      result:{status:'passed',mode:input.mode,history,sessionIDs:Object.keys(history),candidateSessionID:candidate.id,candidateStopHistory,stopProof,ownerSessionReused:receivedOwner!==null}},error=>error?reject(error):resolve()));
    const transition = await api('/api/runtime/bundle/rollback', { expectedRevision: current.revision });
    assert.notEqual(input.mode,'rollback-crash','Original rollback completed before its required pending-intent crash');
    assert.equal(transition.transition, 'rollback'); assert.equal(transition.reconciliationRequired, false);
    assert.equal(transition.restartRequired, true);
    result = { status: 'passed', mode: input.mode, history, sessionIDs: Object.keys(history), transition, candidateSessionID: candidate.id, candidateStopHistory,stopProof };
  } else if (input.mode === 'parent-death') {
    const controller = initialControllers[0];
    const evidence = { ownerPID: process.pid, controllerPID: controller.childPid, instanceID: controller.nativeInstanceID,
      receiptPath: path.join(path.dirname(binding.descriptor.preparedManifestPath), '.native-controller', controller.nativeInstanceID, 'termination.json'), registryPath,
      bundleID: binding.descriptor.bundleID, history };
    await fs.writeFile(input.evidencePath, JSON.stringify(evidence) + '\n', { mode: 0o600 });
    await new Promise((resolve, reject) => process.send({ type: 'application-parent-death-ready', evidence }, error => error ? reject(error) : resolve()));
    await new Promise(() => {});
  } else result = { status: 'passed', mode: input.mode, history, sessionIDs: Object.keys(history) };
  result.ownerSessionReused=receivedOwner!==null;
} catch(error) {
  result={status:'failed',mode:input.mode,error:{name:error.name,code:error.code??null,message:error.message},...(stopProof?{stopProof}:{}),...(candidateStopHistory?{candidateStopHistory}:{})};process.exitCode=1;
} finally {
  if(stopStream) {
    try { await stopStream.close(); }
    catch {
      if(result?.status!=='failed')result={status:'failed',mode:input.mode,error:{name:'Error',code:'application_stop_stream_cleanup_failed',message:'Production Stop stream cleanup failed'},...(stopProof?{stopProof}:{}),...(candidateStopHistory?{candidateStopHistory}:{})};
      result.cleanup={...result.cleanup,stopStream:'failed'};process.exitCode=1;
    }
  }
  if (server) {
    try { await server.stop({ exitProcess: false }); }
    catch {
      if(result?.status!=='failed')result={status:'failed',mode:input.mode,error:{name:'Error',code:'application_server_stop_failed',message:'Production application cleanup failed'},...(stopProof?{stopProof}:{}),...(candidateStopHistory?{candidateStopHistory}:{})};
      result.cleanup={...result.cleanup,serverStop:'failed'};process.exitCode=1;
    }
  }
}
process.stdout.write(JSON.stringify(result) + '\n');
process.disconnect?.();
