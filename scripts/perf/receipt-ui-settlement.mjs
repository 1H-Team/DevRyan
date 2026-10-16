import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { createInteractiveProbe } from './electron-interactive-benchmark.mjs';
import { evaluate } from '../qa/cdp.mjs';
import { classifySessionChangeTool } from '../../packages/harness-runtime/lib/session-changes-tools.js';

const id = value => typeof value === 'string' && /^[A-Za-z0-9_:/.-]{1,256}$/.test(value);
const number = value => Number.isFinite(value) && value >= 0;
const phases = new Set(['cursor_receipts', 'native_save', 'finish', 'direct_finish']);
const gap = reason => ({ status: 'gap', reason });

/** Called only by the existing bounded, private journal reader. No content leaves. */
export function projectReceiptSettlementDiagnostic(row) {
  if (row.type !== 'lifecycle' || row.event !== 'session_execution' || !phases.has(row.payload?.phase)) return null;
  const value = row.payload;
  if (!id(row.sessionID) || value.sessionID !== row.sessionID || !id(value.messageID)
    || !['started', 'completed', 'failed'].includes(value.state)) return null;
  if (value.state === 'completed' && !number(value.elapsedMs)) return null;
  return { type: 'receipt-boundary', at: row.at, sessionID: row.sessionID, messageID: value.messageID,
    phase: value.phase, state: value.state, ...(id(value.callID) ? { callID: value.callID } : {}),
    ...(number(value.elapsedMs) ? { elapsedMs: value.elapsedMs } : {}),
    // The inner Cursor event proves an actual write; the outer summary may be a no-op.
    ...(Number.isSafeInteger(value.receipts) && value.receipts > 0 ? { receipts: value.receipts } : {}) };
}

/** The renderer and journal use wall time; host monotonic brackets detect clock steps. */
export async function calibrateReceiptClock(cdp, { wall = Date.now, monotonic = () => performance.now() } = {}) {
  const samples = [];
  for (let i = 0; i < 3; i++) {
    const before = { wall: wall(), mono: monotonic() };
    const renderer = await evaluate(cdp, '({wall:Date.now(),mono:performance.now()})');
    const after = { wall: wall(), mono: monotonic() };
    assert.ok(number(renderer?.wall) && number(renderer.mono) && after.mono >= before.mono);
    const rtt = after.mono - before.mono;
    assert.ok(Math.abs(after.wall - before.wall - rtt) <= 2, 'Host clock stepped during calibration');
    const offset = (before.wall + after.wall) / 2 - renderer.mono;
    const uncertaintyMs = rtt / 2 + 2;
    assert.ok(Math.abs(renderer.wall - (before.wall + after.wall) / 2) <= uncertaintyMs, 'Renderer wall clock differs from journal host');
    samples.push({ offset, uncertaintyMs, rendererWallOffset: renderer.wall - renderer.mono,
      hostWallOffset: (before.wall + after.wall - before.mono - after.mono) / 2 });
  }
  return samples.sort((a, b) => a.uncertaintyMs - b.uncertaintyMs)[0];
}

/** Starts before submission. Reuses the interactive owner's two-rAF completion check. */
export async function startReceiptSettlementProbe({ cdp, sessionID, directory, previousUserIDs, timeoutMs = 180000 }) {
  assert.ok(id(sessionID) && typeof directory === 'string' && Array.isArray(previousUserIDs)
    && previousUserIDs.length <= 200 && previousUserIDs.every(id));
  const calibration = await calibrateReceiptClock(cdp);
  const input = JSON.stringify({ sessionID, directory, previousUserIDs });
  await evaluate(cdp, `(() => {
    if(window.__qaReceiptSettlement)throw Error('Receipt probe already active');
    const input=${input}, probe=(${createInteractiveProbe.toString()})({actionTimeoutMs:${timeoutMs},eventTimingMinimumDurationMs:16});
    const state={input,probe,lastPoll:-Infinity,ready:false,observation:null};
    window.__qaReceiptSettlement=state;
    state.condition=async()=>{
      if(!state.ready&&performance.now()-state.lastPoll<100)return false;
      state.lastPoll=performance.now();
      const query='?directory='+encodeURIComponent(input.directory);
      const messages=await fetch('/api/session/'+encodeURIComponent(input.sessionID)+'/message'+query+'&limit=200',{signal:AbortSignal.timeout(2000)});
      if(!messages.ok)throw Error('Canonical messages unavailable');
      const rows=await messages.json(), startedAt=performance.now();
      const response=await fetch('/api/session/status'+query,{signal:AbortSignal.timeout(2000)});
      if(!response.ok)throw Error('Canonical status unavailable');
      const statuses=await response.json(), idleAt=performance.now();
      if(!Array.isArray(rows)||rows.length>=200)throw Error('Incomplete canonical turn inventory');
      if(!statuses||typeof statuses!=='object'||Array.isArray(statuses))throw Error('Malformed canonical status inventory');
      const validStatuses=Object.values(statuses).every(status=>status&&typeof status==='object'&&!Array.isArray(status)
        &&(['idle','busy'].includes(status.type)||(status.type==='retry'&&Number.isSafeInteger(status.attempt)
          &&typeof status.message==='string'&&Number.isFinite(status.next))));
      const idle=validStatuses&&(!Object.hasOwn(statuses,input.sessionID)||statuses[input.sessionID]?.type==='idle');
      const users=rows.filter(row=>row.info?.role==='user'&&!input.previousUserIDs.includes(row.info.id));
      if(users.length>1)throw Error('Later human turn changed objective');
      const user=users[0], assistants=rows.filter(row=>row.info?.role==='assistant'&&row.info.parentID===user?.info.id);
      const assistant=assistants.at(-1);
      const canonical=user&&assistant&&assistants.every(row=>row.info.time?.completed&&!row.info.error)
        &&idle;
      const textarea=document.querySelector('textarea'), send=document.querySelector('button[aria-label="Send Message"]');
      const rendered=assistant&&document.querySelector('[data-message-id="'+assistant.info.id+'"]');
      const selected=new URL(location.href).searchParams.get('session')===input.sessionID;
      const controls=selected&&textarea?.isConnected&&!textarea.disabled&&textarea.getBoundingClientRect().height>0
        &&send?.isConnected&&send.getBoundingClientRect().height>0&&!document.querySelector('button[aria-label="Stop Generating"]')
        &&rendered?.getBoundingClientRect().height>0;
      state.ready=Boolean(canonical&&controls);
      if(!canonical){state.idleObservation=null;state.observation=null;return false;}
      state.idleObservation??={sessionID:input.sessionID,objectiveID:user.info.id,assistantID:assistant.info.id,idleStartedAt:startedAt,idleAt};
      if(!state.ready){state.observation=null;return false;}
      state.observation??={...state.idleObservation,controlsAt:performance.now()};
      if(state.observation.objectiveID!==user.info.id||state.observation.assistantID!==assistant.info.id)throw Error('Canonical turn changed');
      return true;
    };
    state.job=probe.arm({group:'receipt-settlement',action:'canonical idle and restored controls',event:'manual',selector:'body',condition:'window.__qaReceiptSettlement.condition()'});
    probe.start(state.job);
  })()`);
  return { calibration, sessionID };
}

export async function finishReceiptSettlementProbe({ cdp, calibration, sessionID, wait }) {
  const result = await wait(() => evaluate(cdp, `(() => {const s=window.__qaReceiptSettlement;
    const action=s?.probe.snapshot().actions.find(row=>row.id===s.job);return action?{action,observation:s.observation}:false;})()`));
  const after = await calibrateReceiptClock(cdp);
  await closeReceiptSettlementProbe(cdp);
  return { ...result, sessionID, calibration, after };
}

export async function closeReceiptSettlementProbe(cdp) {
  await evaluate(cdp, 'window.__qaReceiptSettlement?.probe.close();delete window.__qaReceiptSettlement');
}

/** Missing, foreign or coarse evidence stays a gap, never a fast sample. */
export function joinReceiptSettlement({ journal, rows, sessionID, objectiveID, probe, cohort }) {
  if (journal?.complete !== true || journal.gapCount !== 0) return gap('journal-coverage');
  if (!Array.isArray(rows) || !id(sessionID) || !id(objectiveID)) return gap('canonical-identity');
  const users = rows.filter(row => row.info?.role === 'user');
  if (users.at(-1)?.info.id !== objectiveID || !users.some(row => row.info.id === objectiveID)) return gap('canonical-objective');
  const assistants = rows.filter(row => row.info?.role === 'assistant' && row.info.parentID === objectiveID);
  if (!assistants.length || assistants.some(row => !row.info.time?.completed || row.info.error)) return gap('canonical-completion');
  const records = journal.records, accepted = records.filter(row => row.type === 'native' && row.stage === 'accepted-user'
    && row.sessionID === sessionID && row.messageID === objectiveID);
  if (accepted.length !== 1) return gap('controller-identity');
  const scopeID = accepted[0].scopeID;
  const links = records.filter(row => row.type === 'native' && row.stage === 'step-link'
    && row.sessionID === sessionID && row.userMessageID === objectiveID);
  if (!Number.isSafeInteger(scopeID) || !links.length || records.some(row => row.type === 'native' && row.sessionID === sessionID && row.scopeID !== scopeID)
    || assistants.some(row => !links.some(link => link.assistantMessageID === row.info.id))) return gap('canonical-step-identity');
  const boundaries = [];
  const toolCalls = new Set();
  for (const assistant of assistants) {
    const relevant = records.filter(row => row.type === 'receipt-boundary' && row.sessionID === sessionID && row.messageID === assistant.info.id);
    if (relevant.some(row => row.state === 'failed')) return gap('failed-receipt');
    if (assistant.info.providerID === 'cursor-acp') {
      const receipts = relevant.filter(row => row.phase === 'cursor_receipts' && row.state === 'completed' && row.receipts > 0);
      const saves = relevant.filter(row => row.phase === 'native_save' && row.state === 'completed');
      if (!receipts.length || !saves.length) return gap('cursor-durable-boundary');
      boundaries.push(...receipts.map(row => [row.at - 1, row.at + 1]), ...saves.map(row => [row.at - 1, row.at + 1]));
    } else {
      for (const part of assistant.parts ?? []) {
        if (part.type !== 'tool') continue;
        if (!id(part.callID) || toolCalls.has(part.callID) || part.state?.status !== 'completed') return gap('canonical-tool');
        toolCalls.add(part.callID);
        if (classifySessionChangeTool(part.tool) === 'read-only') continue;
        const matches = relevant.filter(row => ['finish', 'direct_finish'].includes(row.phase) && row.callID === part.callID && row.state === 'completed');
        if (matches.length !== 1 || !number(matches[0].elapsedMs)) return gap('native-durable-boundary');
        // Native finish includes cleanup after commit. It bounds the commit; it does not timestamp it.
        boundaries.push([matches[0].at - matches[0].elapsedMs - 1, matches[0].at + 1]);
      }
    }
  }
  if (!boundaries.length || boundaries.some(pair => pair.some(value => !number(value)))) return gap('required-durable-boundary');
  const observation = probe?.observation, action = probe?.action, before = probe?.calibration, after = probe?.after;
  if (probe?.sessionID !== sessionID || observation?.sessionID !== sessionID || observation.objectiveID !== objectiveID
    || observation.assistantID !== assistants.at(-1).info.id || action?.outcome !== 'passed') return gap('renderer-identity');
  if (![before, after].every(clock => clock && ['offset', 'uncertaintyMs', 'rendererWallOffset', 'hostWallOffset'].every(key => number(clock[key])))) return gap('clock-calibration');
  const drift = Math.max(Math.abs(after.offset - before.offset), Math.abs(after.rendererWallOffset - before.rendererWallOffset), Math.abs(after.hostWallOffset - before.hostWallOffset));
  const uncertaintyMs = Math.max(before.uncertaintyMs, after.uncertaintyMs) + drift;
  if (drift > before.uncertaintyMs + after.uncertaintyMs + 2) return gap('clock-step');
  const { idleStartedAt, idleAt, controlsAt } = observation;
  if (![idleStartedAt, idleAt, controlsAt, action.endedAt].every(number)
    || idleStartedAt > idleAt || idleAt > controlsAt || controlsAt > action.endedAt) return gap('renderer-order');
  const receipt = [Math.max(...boundaries.map(pair => pair[0])), Math.max(...boundaries.map(pair => pair[1]))];
  const wall = value => value + before.offset;
  if (receipt[1] > wall(idleStartedAt) - uncertaintyMs) return gap('receipt-idle-order-unproven');
  return { status: 'matched', cohort, sessionID, objectiveID, assistantID: observation.assistantID, scopeID,
    receiptWallInterval: receipt, idleWallInterval: [wall(idleStartedAt) - uncertaintyMs, wall(idleAt) + uncertaintyMs],
    controlsWallInterval: [wall(controlsAt) - uncertaintyMs, wall(controlsAt) + uncertaintyMs],
    twoFrameWallInterval: [wall(action.endedAt) - uncertaintyMs, wall(action.endedAt) + uncertaintyMs],
    postReceiptMs: [Math.max(0, wall(action.endedAt) - uncertaintyMs - receipt[1]), Math.max(0, wall(action.endedAt) + uncertaintyMs - receipt[0])],
    clockUncertaintyMs: uncertaintyMs, endpoint: 'render-ready-two-raf-not-compositor-presentation' };
}

export function summarizeReceiptSettlements(samples) {
  if (!Array.isArray(samples) || samples.length !== 5 || samples.some(row => row.status !== 'matched'
    || !['buildID', 'artifactManifestSha256', 'sourceDigest', 'runnerSha256', 'uiSha256'].every(key => /^[a-f0-9]{64}$/.test(row.cohort?.[key] ?? ''))
    || !['workload', 'agent', 'providerID', 'modelID', 'variant'].every(key => id(row.cohort?.[key]))
    || !isDeepStrictEqual(row.cohort, samples[0].cohort)
    || !Array.isArray(row.postReceiptMs) || row.postReceiptMs.length !== 2 || !row.postReceiptMs.every(number) || row.postReceiptMs[0] > row.postReceiptMs[1])
    || new Set(samples.map(row => `${row.sessionID}\0${row.objectiveID}`)).size !== 5) return gap('five-matched-samples-required');
  const lower = samples.map(row => row.postReceiptMs[0]).sort((a, b) => a - b), upper = samples.map(row => row.postReceiptMs[1]).sort((a, b) => a - b);
  return { status: 'measured', count: 5, medianMs: [lower[2], upper[2]], worstMs: [lower[4], upper[4]],
    finalizingThresholdExceeded: lower[2] > 1000 || lower[4] > 3000 };
}
