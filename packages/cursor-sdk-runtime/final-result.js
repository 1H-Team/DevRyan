import { cursorWorkerFailure } from './sdk-error.js';
const invalid = reason => Object.assign(new Error(`Cursor final association unavailable (${reason}).`), {
  code: 'CURSOR_STREAM_FINAL_ASSOCIATION_INVALID', reason,
});

/** SDK 1.0.28 constructs result from the last assistantMessage, skipping tools
 * and reasoning. Keep only its ordinal witness; the conversation stays private. */
export async function cursorFinalText(result, run) {
  if (result?.status === 'error') throw cursorWorkerFailure(result.error?.message || 'Cursor SDK run failed.', {name:'CursorAgentError',code:result.error?.code,source:'provider'});
  if (typeof result?.result !== 'string') return {};
  if (typeof run?.conversation !== 'function' || run.supports?.('conversation') === false) throw invalid('missing');
  let turns;
  try { turns = await run.conversation(); } catch { throw invalid('unavailable'); }
  if (!Array.isArray(turns) || turns.length > 4096) throw invalid('limit');
  let ordinal = 0, priorNonempty = 0, last, lastPrior = 0, bytes = 0, steps = 0;
  for (const turn of turns) {
    if (turn?.type !== 'agentConversationTurn') continue;
    if (!Array.isArray(turn.turn?.steps)) throw invalid('shape');
    for (const step of turn.turn.steps) {
      if (++steps > 4096) throw invalid('limit');
      if (step?.type !== 'assistantMessage') continue;
      if (typeof step.message?.text !== 'string') throw invalid('shape');
      bytes += Buffer.byteLength(step.message.text);
      if (bytes > 16 * 1024 * 1024) throw invalid('limit');
      last = step.message.text; lastPrior = priorNonempty; ordinal++;
      if (last) priorNonempty++;
    }
  }
  if (!ordinal || last !== result.result) throw invalid('mismatch');
  return { finalText: result.result, finalTextWitness: { assistantOrdinal: ordinal, priorNonempty: lastPrior } };
}

export function cursorFinalTextTarget(witness, streamedCount) {
  if (!witness || Object.keys(witness).length !== 2 || !Number.isSafeInteger(witness.assistantOrdinal)
    || witness.assistantOrdinal < 1 || witness.assistantOrdinal > 4096 || !Number.isSafeInteger(witness.priorNonempty)
    || witness.priorNonempty < 0 || witness.priorNonempty >= witness.assistantOrdinal
    || streamedCount < witness.priorNonempty || streamedCount > witness.priorNonempty + 1) throw invalid('mismatch');
  return witness.priorNonempty;
}
