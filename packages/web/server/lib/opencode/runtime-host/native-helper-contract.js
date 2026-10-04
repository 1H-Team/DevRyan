import path from 'node:path';

const fail = () => Object.assign(new Error('native_helper_input_invalid'), { code: 'native_helper_input_invalid', status: 400 });
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x20\x7f]/.test(value);
/** This constructor boundary carries supplied text only, never history or tool permissions. */
export function nativeHelperInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['operationID','directory','sessionID','agent','providerID','modelID','variant','prompt','system','timeoutMs','maxOutputTokens'].includes(key))
    || input.operationID !== undefined && !id(input.operationID)
    || !path.isAbsolute(input.directory ?? '') || path.resolve(input.directory) !== input.directory || input.directory.includes('\0')
    || input.sessionID !== undefined && !/^ses[a-zA-Z0-9_-]{1,128}$/.test(input.sessionID)
    || !['devryan-title','devryan-commit','devryan-pr'].includes(input.agent)
    || !id(input.providerID) || !id(input.modelID) || input.variant !== undefined && !id(input.variant)
    || typeof input.prompt !== 'string' || !input.prompt.trim() || Buffer.byteLength(input.prompt) > 262144
    || input.system !== undefined && (typeof input.system !== 'string' || Buffer.byteLength(input.system) > 262144)
    || !Number.isSafeInteger(input.timeoutMs ?? 60000) || (input.timeoutMs ?? 60000) < 1 || (input.timeoutMs ?? 60000) > 120000
    || !Number.isSafeInteger(input.maxOutputTokens ?? 2048) || (input.maxOutputTokens ?? 2048) < 1 || (input.maxOutputTokens ?? 2048) > 16384) throw fail();
  return Object.freeze({ ...input, timeoutMs: input.timeoutMs ?? 60000, maxOutputTokens: input.maxOutputTokens ?? 2048 });
}

export function nativeHelperTitleInput(input) {
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['operationID','directory','sessionID','title','expectedTitle'].includes(key))
  ||input.operationID!==undefined&&!id(input.operationID)
  ||!path.isAbsolute(input.directory??'')||path.resolve(input.directory)!==input.directory||input.directory.includes('\0')||!/^ses[a-zA-Z0-9_-]{1,128}$/.test(input.sessionID)
  ||typeof input.title!=='string'||!input.title.trim()||input.title.length>80||/[\x00-\x1f\x7f]/.test(input.title)
  ||typeof input.expectedTitle!=='string'||input.expectedTitle.length>1024)throw fail();
 return Object.freeze({...input});
}
