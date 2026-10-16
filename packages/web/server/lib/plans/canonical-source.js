import { createHash } from 'node:crypto';
import { planError } from './revisions.js';

const hash = value => createHash('sha256').update(value).digest('hex');
// The original recovery owner persists a native trace/span witness, not an
// attempt counter. Ordinal and event sequence establish successor ordering.
const validAttempt = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === 2
  && ['traceID', 'spanID'].every(key => typeof value[key] === 'string' && /^[a-f0-9]{1,128}$/.test(value[key]));
const settled = row => Number.isSafeInteger(row.info.time?.completed) && row.info.time.completed > 0
  && !row.parts.some(part => part.type === 'tool' && !['completed', 'error'].includes(part.state?.status));
const successful = row => settled(row) && !row.info.error && ['stop', 'end_turn', 'complete', 'completed'].includes(row.info.finish)
  && !row.parts.some(part => part.type === 'tool' && part.state?.status === 'error');
const text = row => row.parts.filter(part => part.type === 'text').map(part => part.text ?? '').join('');

/** Exact native stream or automatic-compaction successors can finish a prefix. Arbitrary synthetic or
 * replacement attempts never inherit a failed draft's authority. */
export function validateCanonicalPlanSource({ sessionID, sourceMessageID, records, receipts = [], nativeSequence = [], allowSelected = false }) {
  const reject = code => { throw planError(409, code); };
  if (!Array.isArray(records) || records.length > 2000 || records.some(row => row?.info?.sessionID !== sessionID || !Array.isArray(row.parts))) reject('plan_source_unavailable');
  const byID = new Map(records.map(row => [row.info.id, row]));
  if (byID.size !== records.length) reject('plan_source_unavailable');
  if (!Array.isArray(nativeSequence) || nativeSequence.length > 2000) reject('plan_source_unavailable');
  const compactions = new Map(), summaryIDs = new Set(), nativeIDs = new Set();
  let parentID, previousStepID;
  for (const [ordinal,row] of nativeSequence.entries()) {
    if (row?.ordinal !== ordinal || typeof row.id !== 'string' || nativeIDs.has(row.id)) reject('plan_source_unavailable');
    nativeIDs.add(row.id);
    if (row.type === 'assistant') previousStepID = row.id;
    else if (row.type === 'user' || row.type === 'synthetic' && row.turnParent === true || row.type === 'compaction') {
      if (row.type === 'compaction') {
        summaryIDs.add(`${row.id}:summary`);
        if (row.reason === 'auto' && row.status === 'completed' && parentID) compactions.set(row.id, { id:row.id, parentID, previousStepID });
      }
      parentID = row.id; previousStepID = undefined;
    }
  }
  const source = byID.get(sourceMessageID);
  if (source?.info.role !== 'assistant' || summaryIDs.has(sourceMessageID) || source.turnOwnership?.source !== 'native-sequence'
    || source.turnOwnership.userMessageID !== source.info.parentID) reject('plan_source_mismatch');
  const proof = receipts.filter(receipt => receipt.assistantMessageID === sourceMessageID || receipt.previousStepID === sourceMessageID);
  let ancestorID = source.info.parentID;
  while (compactions.has(ancestorID)) ancestorID = compactions.get(ancestorID).parentID;
  const ancestorReceipt = receipts.find(receipt => receipt.userMessageID === ancestorID);
  const objectiveID = proof[0]?.objectiveID ?? ancestorReceipt?.objectiveID ?? ancestorID;
  const rootUserID = proof[0]?.anchorID ?? ancestorReceipt?.anchorID ?? objectiveID;
  const root = byID.get(rootUserID);
  if (root?.info.role !== 'user' || root.parts.every(part => part.synthetic === true) || root.parts.some(part=>part.type==='compaction')
    || nativeSequence.length && nativeSequence.find(row=>row.id===rootUserID)?.type!=='user') reject('plan_source_mismatch');
  const chain = receipts.filter(receipt => receipt.objectiveID === objectiveID && receipt.anchorID === rootUserID).sort((a, b) => a.ordinal - b.ordinal);
  if (chain.length > 2) reject('plan_continuation_invalid');
  const memberUserMessageIDs = [rootUserID], continuedSteps = new Set(), usedCompactions = [];
  let previousUser = rootUserID, previousOrdinal = chain.length ? chain[0].ordinal - 1 : 0, previousSeq = 0, configurationDigest, toolPolicySha256;
  const addCompaction = edge => {
    const boundary = byID.get(edge.id), previous = edge.previousStepID && byID.get(edge.previousStepID);
    if (edge.parentID !== previousUser || boundary?.info.role !== 'user'
      || previous && (previous.info.role !== 'assistant' || previous.info.parentID !== previousUser || !settled(previous) || previous.info.error
        || !['stop','end_turn','complete','completed','tool-calls','tool_calls'].includes(previous.info.finish))
      || edge.previousStepID && !previous || records.indexOf(boundary) <= records.indexOf(byID.get(previousUser))
      || previous && records.indexOf(previous) >= records.indexOf(boundary)) reject('plan_continuation_invalid');
    if (previous) continuedSteps.add(previous.info.id);
    previousUser = edge.id; memberUserMessageIDs.push(edge.id); usedCompactions.push(edge);
  };
  const advanceTo = target => {
    const path = []; let current = target;
    while (current !== previousUser && compactions.has(current)) { const edge = compactions.get(current); path.unshift(edge); current = edge.parentID; }
    if (current !== previousUser) reject('plan_continuation_invalid');
    for (const edge of path) addCompaction(edge);
  };
  for (const receipt of chain) {
    advanceTo(receipt.sourceUserMessageID);
    const previous = byID.get(receipt.previousStepID), user = byID.get(receipt.userMessageID), assistant = byID.get(receipt.assistantMessageID);
    if (receipt.anchorID !== rootUserID || !Number.isSafeInteger(receipt.ordinal) || receipt.ordinal < 1 || receipt.ordinal > 2 || receipt.sourceUserMessageID !== previousUser || receipt.ordinal !== previousOrdinal + 1
      || !Number.isSafeInteger(receipt.eventSeq) || receipt.eventSeq <= previousSeq
      || !/^evt_[a-zA-Z0-9_-]{1,512}$/.test(receipt.eventID ?? '') || receipt.userMessageID !== receipt.eventID.replace(/^evt_/, 'msg_')
      || !validAttempt(receipt.successorAttempt)
      || ![receipt.permitSha256, receipt.configurationDigest, receipt.toolPolicySha256, receipt.syntheticFingerprint].every(value => /^[a-f0-9]{64}$/.test(value ?? ''))
      || configurationDigest && configurationDigest !== receipt.configurationDigest || toolPolicySha256 && toolPolicySha256 !== receipt.toolPolicySha256
      || previous?.info.role !== 'assistant' || previous.info.parentID !== previousUser || !settled(previous) || !previous.info.error
      || user?.info.role !== 'user' || !user.parts.length || user.parts.some(part => part.type !== 'text' || part.synthetic !== true || typeof part.text !== 'string')
      || hash(text(user)) !== receipt.syntheticFingerprint || assistant?.info.role !== 'assistant' || assistant.info.parentID !== receipt.userMessageID
      || assistant.turnOwnership?.source !== 'native-sequence' || assistant.turnOwnership.userMessageID !== receipt.userMessageID
      || records.indexOf(previous) >= records.indexOf(user) || records.indexOf(user) >= records.indexOf(assistant)) reject('plan_continuation_invalid');
    configurationDigest = receipt.configurationDigest; toolPolicySha256 = receipt.toolPolicySha256;
    previousOrdinal = receipt.ordinal; previousSeq = receipt.eventSeq; previousUser = receipt.userMessageID;
    memberUserMessageIDs.push(previousUser); continuedSteps.add(receipt.previousStepID);
  }
  for (;;) {
    const edge = [...compactions.values()].find(edge => edge.parentID === previousUser);
    if (!edge) break;
    addCompaction(edge);
  }
  if (!memberUserMessageIDs.includes(source.info.parentID)) reject('plan_source_mismatch');
  const nativeContext = new Set(nativeSequence.filter(row=>row.type==='skill'||row.type==='synthetic'&&row.turnParent===false).map(row=>row.id));
  const start = records.indexOf(root), tailIndex = records.findIndex((row, index) => index > start && row.info.role === 'user'
    && !nativeContext.has(row.info.id) && !memberUserMessageIDs.includes(row.info.id));
  const members = records.slice(start, tailIndex < 0 ? undefined : tailIndex).filter(row => row.info.role === 'assistant' && !summaryIDs.has(row.info.id));
  if (!allowSelected && tailIndex >= 0) reject('plan_source_stale');
  if (!members.length || !members.includes(source) || members.some(row => !memberUserMessageIDs.includes(row.info.parentID)
    || row.turnOwnership?.source !== 'native-sequence' || row.turnOwnership.userMessageID !== row.info.parentID || !settled(row)
    || !continuedSteps.has(row.info.id) && (!settled(row) || row.info.error || !['stop', 'end_turn', 'complete', 'completed', 'tool-calls', 'tool_calls'].includes(row.info.finish)))) reject('plan_source_incomplete');
  const tail = members.at(-1);
  if (!successful(tail)) reject('plan_source_incomplete');
  const continued = chain.length > 0 || usedCompactions.length > 0;
  const lastCompaction = usedCompactions.at(-1), lastReceipt = chain.at(-1);
  if (!continued && source !== tail || lastReceipt && (!lastCompaction || records.indexOf(byID.get(lastReceipt.userMessageID)) > records.indexOf(byID.get(lastCompaction.id)))
    && lastReceipt.assistantMessageID !== tail.info.id) reject('plan_source_stale');
  // A native tail continues bytes; siblings and replacement attempts remain
  // separate drafts. Never concatenate unrelated earlier assistant messages.
  const contentMembers = continued ? [...new Set([...continuedSteps].map(id => byID.get(id)).concat(tail))].sort((a,b)=>records.indexOf(a)-records.indexOf(b)) : [source];
  if (!contentMembers.includes(source)) reject('plan_source_mismatch');
  let content = contentMembers.map(text).join('');
  const sentinel = /(^|\r?\n)[ \t]*`{0,3}<!--[ \t]*plan[ \t]*-->`{0,3}[ \t]*(?:\r?\n|$)/.exec(content);
  if (sentinel) content = content.slice(sentinel.index + sentinel[0].length);
  else if (root.info.metadata?.openchamberPlanMode !== true) reject('plan_source_not_plan');
  if (!content.trim()) reject('plan_source_empty');
  return { content, sourceIdentity: { sessionID, sourceMessageID, rootUserMessageID: rootUserID,
    memberUserMessageIDs, memberAssistantMessageIDs: members.map(row => row.info.id), currentSourceMessageID: tail.info.id,
    successful: true, settled: true, current: tailIndex < 0 } };
}
