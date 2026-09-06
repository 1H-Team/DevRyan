// A native compaction may append generated user records after the real input.
// Identify the exact submitted input before considering which answer settles it.
export function findQaSubmittedUser(rows, previousIds, text) {
  // ChatInput's submission boundary removes only leading/trailing LF runs.
  const expectedText = text.replace(/^\n+|\n+$/g, '');
  const candidates = rows.filter(row => row.info?.role === 'user' && !previousIds.has(row.info.id)
    && !row.parts?.some(part => part.type === 'compaction')
    && row.parts?.some(part => part.type === 'text' && part.synthetic !== true && part.text === expectedText));
  if (candidates.length > 1) throw new Error('One UI submission created multiple matching canonical user messages');
  // Native attachment ingestion appends its own non-synthetic captions. The UI
  // input is one exact text part; captions are not trimmed or guessed from prose.
  if (candidates[0]?.parts.filter(part => part.type === 'text' && part.synthetic !== true && part.text === expectedText).length > 1) {
    throw new Error('Canonical user message contains multiple exact submitted input parts');
  }
  return candidates[0] ?? null;
}

export function assertQaSubmittedPlanMode(row, expected) {
  const observed = row.parts?.some(part => part.type === 'text' && part.synthetic === true
    && part.text?.trim().startsWith('User has requested to enter plan mode')) ?? false;
  if (observed !== expected) throw new Error(`Canonical submission changed Plan mode: expected ${expected}, observed ${observed}`);
  return observed;
}

export function findQaTurnAssistants(rows, previousIds, userMessageID) {
  const index = rows.findIndex(row => row.info?.id === userMessageID);
  if (index < 0) return [];
  return rows.slice(index + 1).filter(row => row.info?.role === 'assistant' && !previousIds.has(row.info.id)
    && row.info.summary !== true);
}

export function findQaCompletedTurnAssistant({ rows, previousIds, submittedUser, sessionID, status }) {
  const user = submittedUser?.info;
  const assistant = rows.at(-1);
  const info = assistant?.info;
  const userIndex = rows.findIndex(row => row.info?.id === user?.id);
  if (!user || user.role !== 'user' || user.sessionID !== sessionID || previousIds.has(user.id)
    || !Number.isFinite(user.time?.created)
    || userIndex < 0 || userIndex === rows.length - 1
    || !info || info.role !== 'assistant' || info.sessionID !== sessionID || previousIds.has(info.id)
    || info.summary === true || info.error || typeof info.finish !== 'string' || !info.finish || info.finish === 'tool-calls'
    || !Number.isFinite(info.time?.completed) || info.time.completed < user.time.created
    || (status[sessionID] && status[sessionID].type !== 'idle')) return null;
  // Keep native continuation eligibility without inventing a parent chain;
  // only the actual tail can complete the submitted turn, never an older answer.
  return assistant;
}
