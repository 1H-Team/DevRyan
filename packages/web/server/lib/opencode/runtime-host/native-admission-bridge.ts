import type { NativeAdmissionBridge, OperationPermit } from './native-admission-contract.js';
import { HostRefusal } from './host-refusal.js';

export interface NativeAdmissionRpc { readonly rpc: (method: string, input: unknown) => Promise<unknown> }
const record = (input: unknown): input is Record<string, unknown> => input !== null && typeof input === 'object' && !Array.isArray(input);
export function createRemoteNativeAdmissionBridge({ rpc }: NativeAdmissionRpc): NativeAdmissionBridge {
  const call = async (operation: string, input?: unknown) => {
    try { return await rpc(`native.admission.${operation}`, input); }
    catch (error) {
      if (record(error) && typeof error.code === 'string') throw new HostRefusal(error.code,
        error.status === 403 ? 403 : error.status === 503 ? 503 : 409, `native.admission.${operation}`);
      throw error;
    }
  };
  const nothing = async (operation: string, input?: unknown) => { await call(operation, input); };
  return {
    queuedAdmissionRejected:(permit,messageID)=>nothing('queuedAdmissionRejected',{permit,messageID}),
    queuedAdmissionCommitted:input=>nothing('queuedAdmissionCommitted',input),
    queuedDeliveryAuthorized:input=>nothing('queuedDeliveryAuthorized',input),
    queuedBlocked:(permit,sessionID)=>nothing('queuedBlocked',{permit,sessionID}),
    queuedWake:sessionID=>nothing('queuedWake',{sessionID}),
    retention:(permit,members,acquire)=>nothing(acquire?'retentionAcquire':'retentionRecheck',{permit,members}),
    beginCommand: async input => {
      const result = await call('beginCommand', input);
      if (typeof result !== 'string' || !/^[a-f0-9]{64}$/.test(result)) throw new HostRefusal('native_command_derivation_invalid', 503, 'native.admission.beginCommand');
      return result;
    },
    awaitReady: () => nothing('ready'),
    authorize: async (request): Promise<OperationPermit> => {
      const permit = await call('authorize', request);
      if (!record(permit) || typeof permit.token !== 'string' || !/^[a-f0-9]{64}$/.test(permit.token)
        || typeof permit.revision !== 'number' || !Number.isSafeInteger(permit.revision) || permit.revision < 0
        || (permit.sessionID !== undefined && typeof permit.sessionID !== 'string')) throw new HostRefusal('native_permit_response_invalid', 503, 'native.admission.authorize');
      return { token: permit.token, revision: permit.revision, ...(typeof permit.sessionID === 'string' ? { sessionID: permit.sessionID } : {}) };
    },
    recheck: (permit, request) => nothing('recheck', { permit, request }),
    release: (permit) => nothing('release', permit),
    sealPrompt: async (permit, input) => {
      const result = await call('sealPrompt', { permit, input });
      if (!record(result)) throw new HostRefusal('native_seal_response_invalid', 503, 'native.admission.sealPrompt');
      return result;
    },
    verifyAccepted: (permit, accepted) => nothing('verifyAccepted', { permit, accepted }),
    registerShellJob: input => nothing('registerShellJob', input),
    sealSynthetic: async (permit, input) => {
      const result = await call('sealSynthetic', { permit, input });
      if (!record(result)) throw new HostRefusal('native_seal_response_invalid', 503, 'native.admission.sealSynthetic');
      return result;
    },
    hold: (sessionID) => nothing('hold', { sessionID }),
    releaseHold: (sessionID) => nothing('releaseHold', { sessionID }),
    isHeld: async (sessionID) => { const held = await call('isHeld', { sessionID }); if (typeof held !== 'boolean') throw new HostRefusal('native_hold_response_invalid', 503, 'native.admission.isHeld'); return held; },
    deferContinuation: (sessionID, operation) => nothing('deferContinuation', { sessionID, operation }),
  };
}
