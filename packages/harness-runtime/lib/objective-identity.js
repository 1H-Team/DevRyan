// Native history stays authoritative. Only these typed maintenance records
// preserve an existing objective; ordinary synthetic user requests do not.
export const isNativeCompactionRecord = (record) => record?.info?.role === 'user'
  && Array.isArray(record.parts) && record.parts.some((part) => part?.type === 'compaction'
    || (part?.type === 'text' && part.synthetic === true && part.metadata?.compaction_continue === true));

export const currentObjectiveUser = (record) => record.activeUserID ?? record.recoveryID ?? record.continuationID ?? record.anchorID;

export const isManagedMaintenancePrompt = (body) => {
  if (!Array.isArray(body?.parts)) return false;
  if (body.parts.some((part) => part?.type === 'text' && part.synthetic === true
    && part.text?.startsWith('[openchamber-plan-action:v1] '))) return false;
  return isNativeCompactionRecord({ info: { role: 'user' }, parts: body.parts })
    || body.parts.some((part) => part?.type === 'text' && part.synthetic === true && typeof part.text === 'string'
      && (/^\[devryan-provider-recovery:v1:[^\]\r\n]+\]/.test(part.text)
        || part.text.startsWith('[devryan-open-todo-continuation:v1]\n')));
};

export const observesNativeContinuation = (record, observation, userMessageID) => {
  if (!observation?.complete || observation.session?.id !== record.sessionID
    || observation.session.directory !== record.directory || observation.session.parentID
    || observation.session.time?.archived || !Array.isArray(observation.messages)) return false;
  const users = observation.messages.filter((message) => message.info?.role === 'user');
  const previous = users.findIndex((message) => message.info.id === currentObjectiveUser(record));
  if (previous < 0 || !users.some((message) => message.info.id === record.anchorID)
    || users.at(-1)?.info.id !== userMessageID || previous === users.length - 1) return false;
  return users.slice(previous + 1).every(isNativeCompactionRecord);
};
