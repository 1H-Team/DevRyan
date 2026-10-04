const failure = () => Object.assign(new Error('native_observation_invalid'), { code: 'native_observation_invalid', statusCode: 403 });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_.:/-]{1,256}$/.test(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const exact = (value, required, optional = []) => {
  if (!object(value) || required.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw failure();
};
const tuple = value => {
  exact(value, ['agent', 'providerID', 'modelID', 'variant']);
  if (![value.agent, value.providerID, value.modelID].every(id) || value.variant !== null && !id(value.variant)) throw failure();
};
const intent = value => {
  exact(value, ['source', 'variantPresent'], ['agent', 'model', 'variant']);
  if (!['prompt', 'command-definition'].includes(value.source) || typeof value.variantPresent !== 'boolean'
    || value.agent !== undefined && !id(value.agent) || value.variantPresent !== Object.hasOwn(value, 'variant')
    || value.variantPresent && value.variant !== null && value.variant !== '' && !id(value.variant)) throw failure();
  if (value.model !== undefined) { exact(value.model, ['providerID', 'modelID']); if (!id(value.model.providerID) || !id(value.model.modelID)) throw failure(); }
};
const attempt = value => {
  if (value === null) return;
  exact(value, ['traceID', 'spanID']);
  if (![value.traceID, value.spanID].every(id)) throw failure();
};
export function projectNativeReasoningOptions(value) {
  const output = {}, source = object(value) ? value : {};
  for (const key of ['reasoningEffort', 'reasoningSummary', 'reasoning_effort', 'effort', 'thinkingLevel']) if (id(source[key])) output[key] = source[key];
  for (const key of ['thinkingBudget', 'maxThinkingTokens']) if (number(source[key])) output[key] = source[key];
  for (const [key, stringKeys, numberKeys] of [['thinking', ['type'], ['budgetTokens', 'budget_tokens']], ['reasoning', ['effort', 'summary'], []], ['outputConfig', ['effort'], []], ['output_config', ['effort'], []]]) {
    if (!object(source[key])) continue;
    const child = {};
    for (const name of stringKeys) if (id(source[key][name])) child[name] = source[key][name];
    for (const name of numberKeys) if (number(source[key][name])) child[name] = source[key][name];
    if (Object.keys(child).length) output[key] = child;
  }
  return output;
}
/** Same finite parser used at the private journal boundary and by QA consumers. */
function parse(value, journal) {
  if (!object(value) || JSON.stringify(value).length > 16384) throw failure();
  const common = ['schema', 'stage', 'controllerInstanceID', 'configurationDigest', 'sessionID', 'directory'];
  if (value.schema !== 1 || !id(value.controllerInstanceID) || !hash(value.configurationDigest) || !id(value.sessionID)
    || typeof value.directory !== 'string' || value.directory.length > 4096 || /[\0\r\n]/.test(value.directory)
    || (journal ? !/^<WORKTREE_[a-f0-9]{12}>$/.test(value.directory) : !value.directory.startsWith('/'))) throw failure();
  switch (value.stage) {
    case 'accepted-user':
      exact(value, [...common, 'messageID', 'fingerprint', 'intent'], ['execution']);
      if (!id(value.messageID) || !hash(value.fingerprint)) throw failure();
      intent(value.intent); if (value.execution !== undefined) tuple(value.execution); break;
    case 'model-prepared':
      exact(value, [...common, 'requestID', 'kind', 'execution', 'options', 'hookOptions', 'modelLimits']);
      if (!id(value.requestID) || !['primary','title','compaction','generate'].includes(value.kind)) throw failure();
      tuple(value.execution); exact(value.modelLimits, ['context', 'input', 'output']);
      if (!number(value.modelLimits.context) || !number(value.modelLimits.output) || value.modelLimits.input !== null && !number(value.modelLimits.input) || !object(value.options)
        || JSON.stringify(projectNativeReasoningOptions(value.options)) !== JSON.stringify(value.options)
        || !object(value.hookOptions) || JSON.stringify(projectNativeReasoningOptions(value.hookOptions)) !== JSON.stringify(value.hookOptions)) throw failure(); break;
    case 'physical':
      exact(value, [...common, 'requestID', 'kind', 'transport', 'wireOptions', 'ordinal', 'attempt']);
      if (!id(value.requestID) || !['primary','title','compaction','generate'].includes(value.kind)
        || !['http','ws'].includes(value.transport) || !Number.isSafeInteger(value.ordinal) || value.ordinal < 1) throw failure();
      if(value.wireOptions!==null&&(!object(value.wireOptions)||JSON.stringify(projectNativeReasoningOptions(value.wireOptions))!==JSON.stringify(value.wireOptions)))throw failure();
      attempt(value.attempt); break;
    case 'step-link':
      exact(value, [...common, 'eventID', 'sequence', 'created', 'assistantMessageID', 'userMessageID', 'execution', 'attempt']);
      if (![value.eventID, value.assistantMessageID, value.userMessageID].every(id) || !Number.isSafeInteger(value.sequence) || value.sequence < 1 || !number(value.created)) throw failure();
      tuple(value.execution); attempt(value.attempt); break;
    case 'compaction-trigger':
      exact(value,[...common,'triggerID','reason','inputID','entered','orderedInputDigest','inputCount','budget','anchorMessageID','checkpointMessageID']);
      if(!id(value.triggerID)||!['auto','overflow','manual'].includes(value.reason)||!number(value.entered)||!hash(value.orderedInputDigest)
        ||!Number.isSafeInteger(value.inputCount)||value.inputCount<0||[value.inputID,value.anchorMessageID,value.checkpointMessageID].some(item=>item!==null&&!id(item))
        ||(value.reason==='manual')!==(value.inputID!==null))throw failure();
      if(value.budget!==null){const b=value.budget;
        exact(b,['auto','buffer','keep','ceiling','budget','estimatePrompt','estimateContext','limits','anchorIndex','checkpointIndex','stateRevision','due']);
        exact(b.estimatePrompt,['measured','estimated']);exact(b.limits,['context','input','output']);
        if(typeof b.auto!=='boolean'||typeof b.due!=='boolean'||[b.keep,b.estimateContext,b.estimatePrompt.measured,b.estimatePrompt.estimated,b.limits.context,b.limits.output].some(item=>!number(item))
          ||b.buffer!==null&&!number(b.buffer)||b.limits.input!==null&&!number(b.limits.input)
          ||b.ceiling!==null&&(typeof b.ceiling!=='number'||!Number.isFinite(b.ceiling))||typeof b.budget!=='number'||!Number.isFinite(b.budget)
          ||![b.anchorIndex,b.checkpointIndex].every(item=>Number.isSafeInteger(item)&&item>=-1&&item<value.inputCount)
          ||!Number.isSafeInteger(b.stateRevision)||b.stateRevision<0)throw failure();
      }break;
    case 'compaction-outcome':
      exact(value,[...common,'triggerID','status','finished']);
      if(!id(value.triggerID)||!['skipped','completed','failed'].includes(value.status)||!number(value.finished))throw failure();break;
    case 'compaction-event':
      exact(value,[...common,'triggerID','eventID','sequence','created','event','reason','inputID','messageID','witness']);
      if(value.triggerID!==null&&!id(value.triggerID)||!id(value.eventID)||!Number.isSafeInteger(value.sequence)||value.sequence<1||!number(value.created)
        ||!['started','ended','failed'].includes(value.event)||!['auto','manual'].includes(value.reason)
        ||[value.inputID,value.messageID].some(item=>item!==null&&!id(item))||(value.event==='ended')!==(value.messageID!==null)||value.triggerID===null&&(value.reason!=='manual'||value.inputID===null))throw failure();
      exact(value.witness,['recent','text','providerState','providerContext']);
      for(const item of Object.values(value.witness)){if(item===null)continue;exact(item,['sha256','bytes']);if(!hash(item.sha256)||!Number.isSafeInteger(item.bytes)||item.bytes<0)throw failure();}
      break;
    default: throw failure();
  }
  return structuredClone(value);
}
export const parseNativeObservation = value => parse(value, false);
/** Exact sanitizer witness only; consumers bind it to their verified directory digest. */
export const parseNativeJournalObservation = value => parse(value, true);
