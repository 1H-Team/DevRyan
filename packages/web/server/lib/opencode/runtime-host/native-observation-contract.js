export {parseNativeObservation,parseNativeJournalObservation,projectNativeReasoningOptions,isSafeNativeOpenAiRefusalCode} from '../../../../../shared-runtime/lib/native-observation.js';

/** Private controller presentation proof, distinct from diagnostic observations. */
export function parseNativePresentation(value) {
  const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
  const id=value=>typeof value==='string'&&/^[A-Za-z0-9_.:/-]{1,256}$/.test(value);
  const keys=['schema','controllerInstanceID','configurationDigest','sessionID','directory','requestID','assistantMessageID','stepID','attempt','phase','progress','sequence'];
  const fail=()=>{throw Object.assign(Error('native_presentation_invalid'),{code:'native_presentation_invalid',statusCode:403});};
  if(!object(value)||Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key))||value.schema!==1
    ||!['controllerInstanceID','sessionID','requestID','assistantMessageID','stepID'].every(key=>id(value[key]))
    ||!/^[a-f0-9]{64}$/.test(value.configurationDigest??'')||typeof value.directory!=='string'||!value.directory.startsWith('/')||value.directory.length>4096||/[\0\r\n]/.test(value.directory)
    ||!object(value.attempt)||Object.keys(value.attempt).length!==2||!id(value.attempt.traceID)||!id(value.attempt.spanID)
    ||!['finalizing','cleared'].includes(value.phase)||!Number.isSafeInteger(value.progress)||value.progress<0||!Number.isSafeInteger(value.sequence)||value.sequence<1)fail();
  return structuredClone(value);
}
