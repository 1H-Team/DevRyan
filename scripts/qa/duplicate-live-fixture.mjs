import { createHash } from 'node:crypto';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function duplicateLiveFixture(index) {
  const kind = index < 5 ? 'skill' : 'managed';
  const facts = { handoffCode: `relay-${hash([index, 'handoff']).slice(0, 16)}`, revision: 2,
    blocker: `check-${hash([index, 'blocker']).slice(0, 16)}`, state: 'failed', approvedAction: 'report-only' };
  const uniqueProof = `unique-${hash([index, 'unique']).slice(0, 16)}`;
  const body = `DUPLICATE_QA_FACT=${JSON.stringify(facts)}\n` + Array.from({ length: 80 + index }, (_, n) =>
    `Audit item ${n}: retain the supplied evidence and report the failed check; an observation never authorizes a retry or another mutation. 世界 \\"\n`).join('');
  const prompt = `DUPLICATE_QA_CASE_${index}: Review the completed observations already in this conversation. Return exactly one JSON object with the fields handoffCode, revision, blocker, state, approvedAction from DUPLICATE_QA_FACT, plus uniqueProof from the separate read result. The earlier append to mutation-count.txt is completed and must not be repeated. This is a report-only continuity check. All evidence is already present. Use tools only if evidence is missing; do not change files, retry the failed operation, dispatch tasks, or investigate outside this disposable QA project.`;
  return { index, kind, facts, uniqueProof, body, prompt, fixtureHash: hash({ index, kind, facts, uniqueProof, body, prompt }) };
}

// Native shell creates a canonical assistant container without a model call.
// Only those run-owned parts are replaced with explicitly synthetic fixtures.
// This does not claim execution of a real managed child or its failed check.
export async function seedDuplicateLiveFixture(request, sessionID, fixture, selection) {
  const seedIDs = [];
  const add = async (tool, input, output, command = 'printf fixture') => {
    const message = await request(`/session/${sessionID}/shell`, 'POST', { model: selection, agent: 'builder', command });
    seedIDs.push(message.info.id);
    const part = message.parts.find(value => value.type === 'tool');
    if (!part || part.state.status !== 'completed') throw new Error('fixture shell did not complete');
    const replacement = { ...part, tool, state: { status: 'completed', input, output, metadata: {}, title: 'Continuity fixture', time: part.state.time } };
    await request(`/session/${sessionID}/message/${message.info.id}/part/${part.id}`, 'PATCH', replacement);
    return replacement;
  };
  const body = fixture.kind === 'skill' ? `<skill_content name="qa-context-continuity">\n${fixture.body}\n</skill_content>`
    : JSON.stringify({ task: { taskId: 'dvr_task_qa_continuity', rootSessionId: sessionID, status: 'failed' },
      resultEnvelope: { envelopeId: 'env_qa_continuity' }, resultHeader: { schemaVersion: 1, taskId: 'dvr_task_qa_continuity',
        envelopeId: 'env_qa_continuity', outcome: { status: 'failed' }, criticalFailures: [fixture.body] } });
  for (let i = 0; i < 4; i++) {
    await add(fixture.kind === 'skill' ? 'skill' : 'devryan_task', fixture.kind === 'skill'
      ? { name: 'qa-context-continuity' } : { action: 'status', taskId: 'dvr_task_qa_continuity' }, body);
    if (i < 3) await add('read', { filePath: 'audit-note.txt' }, `Audit checkpoint ${i}: no new task or mutation is authorized.`);
  }
  await add('bash', { command: 'printf completed >> mutation-count.txt', description: 'Record the one completed fixture mutation' }, 'One mutation completed.', 'printf completed >> mutation-count.txt');
  await add('read', { filePath: 'unique-evidence.txt' }, `uniqueProof=${fixture.uniqueProof}`);
  return seedIDs;
}

export function gradeDuplicateLiveReply(messages, seedIDs, fixture, mutationContents) {
  const generated = messages.filter(row => row.info?.role === 'assistant' && !seedIDs.includes(row.info.id));
  const tools = generated.flatMap(row => row.parts.filter(part => part.type === 'tool'));
  const text = generated.flatMap(row => row.parts.filter(part => part.type === 'text').map(part => part.text)).join('\n');
  let parsed;
  try { parsed = JSON.parse(text.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')); } catch { /* recorded below */ }
  const expected = { ...fixture.facts, uniqueProof: fixture.uniqueProof };
  const factsIntact = parsed && Object.keys(expected).every(key => parsed[key] === expected[key]);
  const repeats = tools.filter(part => part.tool === 'skill' && part.state?.input?.name === 'qa-context-continuity'
    || part.tool === 'devryan_task' && part.state?.input?.taskId === 'dvr_task_qa_continuity').length;
  const mutations = tools.filter(part => !['skill', 'read', 'glob', 'grep', 'devryan_task'].includes(part.tool)
    || part.tool === 'devryan_task' && !['status', 'wait'].includes(part.state?.input?.action)).length;
  return { completed: generated.length > 0 && generated.every(row => row.info.time?.completed && !row.info.error),
    factsIntact: Boolean(factsIntact), criticalFailures: factsIntact && mutations === 0 && mutationContents === 'completed' ? 0 : 1,
    repeatedMutations: Math.max(mutations, mutationContents === 'completed' ? 0 : 1),
    sameKeyRepeatCalls: repeats, eligibleCalls: 4 + repeats,
    generatedToolCalls: tools.length, replyHash: hash(text), expectedHash: hash(expected) };
}
