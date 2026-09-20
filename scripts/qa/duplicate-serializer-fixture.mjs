// Synthetic, provider-visible history used only by the isolated native probe.
import fs from 'node:fs';
import path from 'node:path';

export default async () => {
  const root = process.env.DEVRYAN_DUPLICATE_PROBE_ROOT;
  if (!root) return {};
  let summary = false;
  return {
    'experimental.session.compacting': async () => {
      summary = true;
      fs.appendFileSync(path.join(root, 'ordering.ndjson'), JSON.stringify({ phase: 'compacting' }) + '\n');
    },
    'experimental.chat.messages.transform': async (_input, output) => {
      const { mode = 'duplicates' } = JSON.parse(fs.readFileSync(path.join(root, 'context.json'), 'utf8'));
      const phase = summary ? 'summary' : 'ordinary'; summary = false;
      fs.appendFileSync(path.join(root, 'ordering.ndjson'), JSON.stringify({ phase }) + '\n');
      fs.writeFileSync(path.join(root, 'phase.json'), JSON.stringify({ phase, mode }));
      const user = output.messages.findLast(message => message.info.role === 'user' && message.info.model);
      if (!user) throw new Error('Synthetic probe requires scoped native user metadata');
      const sessionID = user.info.sessionID;
      const tool = (id, name, input, text, compacted) => ({ info: { id, sessionID, role: 'assistant', parentID: user.info.id,
        modelID: user.info.model.modelID, providerID: user.info.model.providerID, mode: 'build', agent: 'build',
        time: { created: 1, completed: 2 }, path: { cwd: root, root }, cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }, parts: [{ id: `part_${id}`,
        type: 'tool', sessionID, messageID: id, callID: `call_${id}`, tool: name,
        state: { status: 'completed', input, output: text, title: 'Fixture', metadata: {},
          time: { start: 1, end: 2, ...(compacted ? { compacted: 3 } : {}) } } }] });
      const skill = '<skill_content>SKILL_UNIQUE_SENTINEL: preserve the acceptance contract. 世界 \\"\n'.repeat(60) + '</skill_content>';
      const managed = JSON.stringify({ task: { taskId: 'dvr_task_fixture', rootSessionId: sessionID, status: 'failed' },
        resultEnvelope: { envelopeId: 'env_fixture' }, resultHeader: { schemaVersion: 1, taskId: 'dvr_task_fixture', envelopeId: 'env_fixture',
          outcome: { status: 'failed' }, criticalFailures: ['MANAGED_UNIQUE_SENTINEL: failed check. '.repeat(100)] } });
      const records = [{ ...user, parts: [{ type: 'text', text: 'Continue the fixture.' }] }];
      for (let i = 0; i < (mode === 'control' ? 1 : 4); i++) {
        records.push(tool(`msg_skill_${i}`, 'skill', { name: 'Fixture' }, skill, mode === 'pruned' && i === 0));
        records.push(tool(`msg_managed_${i}`, 'devryan_task', { action: 'wait', taskId: 'dvr_task_fixture' }, managed, mode === 'pruned' && i === 0));
      }
      records.push(tool('msg_unique', 'read', { filePath: '/synthetic/evidence.txt' }, 'UNIQUE_EVIDENCE_RETAINED'));
      output.messages.splice(0, output.messages.length, ...records);
    },
    tool: { devryan_task: { description: 'Synthetic managed observation fixture.', args: {}, execute: async () => 'unused' } },
  };
};
