// Only a fresh, directly correlated permission rejection can end this QA turn.
// Native automatic continuations without a proven parent chain are not inferred.
export function findQaTerminalPermissionDenial({ rows, previousIds, submittedUser, sessionID, status, observations }) {
  const user = submittedUser?.info;
  const assistant = rows.at(-1);
  const info = assistant?.info;
  if (!user || user.role !== 'user' || user.sessionID !== sessionID || previousIds.has(user.id)
    || !Number.isFinite(user.time?.created)
    || !info || info.role !== 'assistant' || info.sessionID !== sessionID || info.parentID !== user.id
    || previousIds.has(info.id) || info.summary === true || info.error || info.finish !== 'tool-calls'
    || !Number.isFinite(info.time?.completed) || info.time.completed < user.time.created
    || (status[sessionID] && status[sessionID].type !== 'idle')) return null;
  const tools = assistant.parts.filter(part => part.type === 'tool');
  if (!tools.length || tools.some(part => !['completed', 'error'].includes(part.state?.status))) return null;
  for (const part of tools) {
    if (part.state.status !== 'error' || part.messageID !== info.id || part.sessionID !== sessionID || !part.callID) continue;
    const asked = observations.filter(event => event.kind === 'native.permission.asked'
      && event.sessionID === sessionID && event.messageID === info.id && event.callID === part.callID
      && typeof event.requestID === 'string' && event.requestID.length > 0
      && Number.isFinite(event.at) && event.at >= user.time.created);
    const requestIDs = [...new Set(asked.map(event => event.requestID))];
    if (requestIDs.length !== 1) continue;
    const requestID = requestIDs[0];
    const askedAt = Math.min(...asked.map(event => event.at));
    const replies = observations.filter(event => event.kind === 'native.permission.replied'
      && event.sessionID === sessionID && event.requestID === requestID);
    if (!replies.length || replies.some(event => event.reply !== 'reject' || !Number.isFinite(event.at)
      || event.at < askedAt || event.at > info.time.completed)) continue;
    return { sessionID, userMessageID: user.id, assistantMessageID: info.id,
      callID: part.callID, requestID, askedAt, rejectedAt: Math.max(...replies.map(event => event.at)),
      assistantCompletedAt: info.time.completed, finish: info.finish };
  }
  return null;
}

export function createQaTerminalPermissionGuard() {
  let previous = null;
  return input => {
    const current = findQaTerminalPermissionDenial(input);
    const confirmed = current && previous && ['sessionID', 'userMessageID', 'assistantMessageID', 'callID', 'requestID',
      'askedAt', 'rejectedAt', 'assistantCompletedAt'].every(key => current[key] === previous[key]);
    previous = current;
    return confirmed ? current : null;
  };
}
