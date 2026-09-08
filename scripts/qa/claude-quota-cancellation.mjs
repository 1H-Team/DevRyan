// Opt-in live cancellation/recovery check, separate from paired quota totals.
// The sentinel files are created only in the owned disposable Git project.
import fs from 'node:fs/promises';
import path from 'node:path';
import { editingPrompts, verifyEditingFixture } from './claude-quota-fixture.mjs';
import { compareQuota, readNativeAssistants, summarizeNativeAssistants } from './claude-quota-evidence.mjs';
import { nativeTranscriptFiles } from './claude-quota-interactive.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const exists = async file => fs.access(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });

export async function checkClaudeCancellation({ interactive, api, sessionID, fixture, claudeDirectory,
  guard, idleGuard = guard, signal, sendWebPrompt, waitWebTurn }) {
  const startedFile = path.join(fixture.workspace, '.quota-cancel-started');
  const finishedFile = path.join(fixture.workspace, '.quota-cancel-finished');
  const command = `node -e 'const fs = require("node:fs"); fs.writeFileSync(".quota-cancel-started", "started"); setTimeout(() => fs.writeFileSync(".quota-cancel-finished", "finished"), 45000)'`;
  const prompt = `This is an intentional cancellation check in the disposable project. Run this exact foreground Bash command with a timeout of at least 60000 ms, and wait for it. Do not run it in the background or alter the TSX, CSS or test files: ${command}`;
  const evidence = { startedAt: Date.now(), before: await idleGuard(), passed: false };
  const read = async () => {
    const native = await readNativeAssistants(await nativeTranscriptFiles(claudeDirectory));
    if (native.gaps.length) throw new Error('Native cancellation evidence is incomplete');
    return summarizeNativeAssistants(native.rows);
  };
  const initial = await read();
  const initialIds = new Set(initial.requests.map(row => row.messageId));
  evidence.idle = { startedAt: Date.now(), durationMs: 6 * 60_000, before: evidence.before };
  console.log(JSON.stringify({ state: 'idle-observation', durationMs: evidence.idle.durationMs }));
  // Observe beyond the historical five-minute background-probe interval while
  // keeping the completed native/web session open. No prompt is submitted.
  while (Date.now() < evidence.idle.startedAt + evidence.idle.durationMs) {
    signal.throwIfAborted();
    await delay(Math.min(30_000, evidence.idle.startedAt + evidence.idle.durationMs - Date.now()));
    await idleGuard();
    if ((await read()).requests.some(row => !initialIds.has(row.messageId))) throw new Error('Native assistant activity occurred during the idle observation');
  }
  evidence.idle.after = await idleGuard({ after: evidence.idle.startedAt + evidence.idle.durationMs });
  evidence.idle.completedAt = Date.now();
  evidence.idle.quota = compareQuota(evidence.idle.before, evidence.idle.after);
  evidence.idle.observedResponses = 0;
  evidence.idle.passed = evidence.idle.quota.valid;
  if (!evidence.idle.passed) throw new Error('Idle quota observation is invalid');
  let nativeTask;
  let nativeFailure;
  try {
    if (interactive) {
      nativeTask = interactive.prompt(prompt, { onPoll: guard, allowInterrupt: true });
      // Retain the rejection until cleanup can handle it; never abandon a
      // running native prompt if the sentinel/readiness stage fails.
      nativeTask.catch(error => { nativeFailure = error; interactive.interrupt(); });
    } else await sendWebPrompt(prompt);
    const startDeadline = Date.now() + 90_000;
    let lastGuard = Date.now();
    while (!(await exists(startedFile))) {
      signal.throwIfAborted();
      if (nativeFailure) throw nativeFailure;
      if (Date.now() >= startDeadline) throw new Error('Cancellation tool did not create its start sentinel');
      if (!interactive && Date.now() - lastGuard > 30_000) { await guard(); lastGuard = Date.now(); }
      await delay(100);
    }
    evidence.toolStartedAt = Date.now();
    if (await exists(finishedFile)) throw new Error('Cancellation arrived after the tool finished');
    if (interactive) {
      interactive.interrupt();
      const completion = await Promise.race([nativeTask, delay(15_000).then(() => { throw new Error('Native cancellation did not settle'); })]);
      evidence.nativeCompletion = completion;
      if (!completion.interrupted) throw new Error('Native work completed without acknowledging the requested interruption');
    } else {
      const rows = await api(`/api/session/${sessionID}/message`);
      evidence.runningToolIds = rows.flatMap(row => row.parts).filter(part => part.type === 'tool'
        && part.tool === 'bash' && part.state?.status === 'running').map(part => part.callID);
      if (!evidence.runningToolIds.length) throw new Error('The cancellation sentinel has no live running Bash tool');
      await api(`/api/session/${sessionID}/abort`, {});
      const idleDeadline = Date.now() + 15_000;
      for (;;) {
        const statuses = await api('/api/session/status');
        if (!statuses[sessionID] || statuses[sessionID].type === 'idle') break;
        if (Date.now() >= idleDeadline) throw new Error('DevRyan cancellation did not settle');
        await delay(100);
      }
    }
    evidence.cancelledAt = Date.now();
    await delay(2000);
    const settled = await read();
    evidence.settledResponseIds = settled.requests.map(row => row.messageId);
    // A surviving tool would write the finish sentinel at 45 seconds. Observe
    // beyond that deadline before claiming cancellation or sending a resume.
    while (Date.now() < evidence.toolStartedAt + 50_000) {
      signal.throwIfAborted();
      await delay(Math.min(10_000, evidence.toolStartedAt + 50_000 - Date.now()));
    }
    evidence.finishSentinelAbsent = !(await exists(finishedFile));
    const afterIdle = await read();
    const known = new Set(evidence.settledResponseIds);
    evidence.responsesAfterSettledAbort = afterIdle.requests.filter(row => !known.has(row.messageId)).length;
    if (!evidence.finishSentinelAbsent || evidence.responsesAfterSettledAbort) throw new Error('Work continued after the settled cancellation');
    evidence.beforeResume = await idleGuard();
    if (interactive) await interactive.prompt(editingPrompts[2], { onPoll: guard });
    else {
      const oldIds = await sendWebPrompt(editingPrompts[2]);
      await waitWebTurn(oldIds);
    }
    evidence.verification = await verifyEditingFixture(fixture.workspace);
    evidence.resumedWorkCompletedAt = Date.now();
    evidence.after = await idleGuard({ after: evidence.resumedWorkCompletedAt });
    evidence.passed = evidence.verification.passed;
    return evidence;
  } finally {
    await fs.rm(startedFile, { force: true });
    await fs.rm(finishedFile, { force: true });
  }
}
