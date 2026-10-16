import { toV1ToolName } from '../v2/projection/tools.js';
const fail = () => Object.assign(Error('native_plan_denial_unproved'), { code: 'native_plan_denial_unproved', statusCode: 409 });
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_:/.-]{1,256}$/.test(value);

/** Called only after constructor-owned initial admission has rejected a writer.
 * Canonical pending call identity and absent ledger execution independently prove no start. */
export function createNativePlanDenialOwner({ readMessage, runtime }) {
  return async (request, session, recheck, guard) => {
    const callID = request.input?.callID, tool = request.input?.nativeToolID ?? request.input?.toolID;
    if (request.operation !== 'tool.execute' || !identifier(request.sessionID) || !identifier(request.messageID) || !identifier(callID)
      || session.id !== request.sessionID || typeof session.directory !== 'string'
      || !identifier(tool) || typeof guard?.assertCurrent !== 'function' || !Number.isSafeInteger(guard.admissionRevision)) throw fail();
    await recheck();
    const message = await readMessage(request.sessionID, request.messageID, session.directory);
    const matches = message?.parts?.filter(part => part.type === 'tool' && part.callID === callID);
    if (message?.info?.id !== request.messageID || message.info.sessionID !== request.sessionID || message.info.role !== 'assistant'
      || message.info.time?.completed || !Array.isArray(matches) || matches.length !== 1
      || matches[0].tool !== toV1ToolName(tool) || !['pending', 'running'].includes(matches[0].state?.status)) throw fail();
    await recheck();
    await runtime.cancelUnstartedCall({ directory: session.directory, sessionID: session.id, messageID: request.messageID, callID, requireAbsent: true, guard });
    await recheck();
  };
}
