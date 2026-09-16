import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Opt-in native acceptance alongside the editing study. The runner owns quota
// admission, cancellation deadlines, child cleanup, and the consumption ledger.
export async function exerciseCursorLifecycle({ request, workspace, beforeSend, deadline }) {
  const steps = [];
  const historyToken = randomBytes(16).toString('hex');
  await fs.writeFile(path.join(workspace, 'history-token.txt'), historyToken);
  const send = async text => {
    await beforeSend();
    const start = Date.now();
    const result = await deadline(request('send', { text }), 180_000, 'Lifecycle prompt deadline exceeded');
    steps.push({ start, completedAt: Date.now(), result });
    if (result.status !== 'finished') throw new Error(`Lifecycle run finished with ${result.status}`);
    return result;
  };
  // Two actual MCP calls on ordinary warm turns verify rotating run scopes.
  for (const word of ['amber', 'violet']) {
    const historyInstruction = word === 'amber'
      ? 'First read history-token.txt once and retain its exact contents for a later turn. Do not copy that token to another file or repeat it in your final response. ' : '';
    const result = await send(`This is a bounded integration fixture. ${historyInstruction}Use the DevRyan question tool once to ask which marker to use, offering ${word} and grey. Wait for the answer, then write exactly that answer to marker-${word}.txt. Do not delegate or change other files.`);
    const marker = (await fs.readFile(path.join(workspace, `marker-${word}.txt`), 'utf8')).trim();
    if (marker !== word || result.questionsAnswered !== 1) throw new Error('Native per-run question bridge was not verified');
    if (word === 'amber') await fs.unlink(path.join(workspace, 'history-token.txt'));
  }
  await send('Use exactly one native explorer subagent to read marker-amber.txt and marker-violet.txt and report their contents. Do not make edits. Wait for its result and write the two reported words, amber then violet, to subagent-result.txt. This explicitly authorizes this one bounded subagent task.');
  if ((await fs.readFile(path.join(workspace, 'subagent-result.txt'), 'utf8')).trim().replace(/\s+/g, ' ') !== 'amber violet') {
    throw new Error('Subagent result did not preserve fixture contents');
  }
  await beforeSend();
  const pending = request('send', { text: 'Run this single foreground shell command, then wait: node -e "const fs=require(\'fs\');fs.writeFileSync(\'cancel-started\',\'started\');setTimeout(()=>fs.writeFileSync(\'cancel-finished\',\'finished\'),45000)". Do not background it, delegate it, or alter the command. This is a cancellation fixture.' });
  // Attach a rejection handler immediately; the abort may race the sentinel.
  const settled = pending.then(value => ({ value }), error => ({ error: error.message }));
  await deadline((async () => {
    while (!await fs.stat(path.join(workspace, 'cancel-started')).catch(() => null)) await delay(100);
  })(), 90_000, 'Native cancellation start sentinel was not observed');
  const abortedAt = Date.now();
  await deadline(request('cancel'), 30_000, 'Native abort did not settle');
  const cancellation = await deadline(settled, 30_000, 'Cancelled prompt did not settle');
  if (cancellation.error || cancellation.value?.status !== 'cancelled') throw new Error('Accepted native Stop did not retain cancelled status');
  const settledAt = Date.now();
  await delay(50_000);
  if (await fs.stat(path.join(workspace, 'cancel-finished')).catch(() => null)) throw new Error('Cancelled native shell continued to completion');
  await request('reload');
  await send('Recall the exact history token from the earlier tool output and write it to recalled-token.txt. Its source file has been removed: use the retained conversation, with no filesystem or network recovery. Then read marker-amber.txt and marker-violet.txt, verify they still contain amber and violet, and write exactly continuity-ok to resumed.txt. Do not ask questions, delegate, or change any other files.');
  if ((await fs.readFile(path.join(workspace, 'resumed.txt'), 'utf8')).trim() !== 'continuity-ok') throw new Error('Native cancellation/resume continuity failed');
  if ((await fs.readFile(path.join(workspace, 'recalled-token.txt'), 'utf8')).trim() !== historyToken) throw new Error('Native tool-result history did not survive resume');
  return { steps, historyRecall: { sourceRemoved: true, passed: true, tokenSha256: createHash('sha256').update(historyToken).digest('hex') },
    cancellation: { abortedAt, settledAt, ...cancellation, finishSentinelAbsent: true } };
}
