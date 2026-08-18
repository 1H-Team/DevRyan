import { describe, expect, it } from 'vitest';

import {
  ANTHROPIC_SKILL_CATALOG_DESCRIPTION_LIMIT,
  DevRyanSkillContextPlugin,
  EXTERNAL_SKILL_REFERENCE_POLICY_MARKER,
  SKILL_CONTEXT_POLICY_MARKER,
  SKILL_CONTEXT_REUSE_MARKER,
} from './devryan-skill-context.mjs';

let fixtureSequence = 0;

const completedSkill = ({
  id,
  name = 'Impeccable',
  output = '<skill_content name="Impeccable">Complete design guidance.</skill_content>',
  compacted,
} = {}) => ({
  id: id || `part-${fixtureSequence += 1}`,
  sessionID: 'session-1',
  messageID: 'assistant-1',
  type: 'tool',
  callID: `call-${fixtureSequence += 1}`,
  tool: 'skill',
  state: {
    status: 'completed',
    input: { name },
    output,
    title: '',
    metadata: { source: 'fixture' },
    time: {
      start: 1,
      end: 2,
      ...(compacted === undefined ? {} : { compacted }),
    },
  },
});

const transform = async (messages) => {
  const plugin = await DevRyanSkillContextPlugin();
  const output = { messages };
  await plugin['experimental.chat.messages.transform']({}, output);
  return output.messages;
};

const outputs = (messages) => messages.flatMap((message) => (
  message.parts
    .filter((part) => part.type === 'tool' && part.tool === 'skill')
    .map((part) => part.state.output)
));

describe('DevRyan skill context plugin', () => {
  it('compacts Anthropic skill metadata without hiding skills or their on-demand bodies', async () => {
    const plugin = await DevRyanSkillContextPlugin();
    const longDescription = `Use this skill for ${'detailed workflows '.repeat(30)}`;
    const original = `Skills provide specialized instructions and workflows for specific tasks.
Use the skill tool to load a skill when a task matches its description.
<available_skills>
  <skill>
    <name>alpha</name>
    <description>${longDescription}</description>
    <location>/Users/example/.config/opencode/skills/alpha/SKILL.md</location>
  </skill>
  <skill>
    <name>beta</name>
    <description>  Short\n description.  </description>
    <location>/private/project/.agents/skills/beta/SKILL.md</location>
  </skill>
</available_skills>`;
    const output = { system: [original, 'Unrelated system text.'] };

    await plugin['experimental.chat.system.transform'](
      { model: { providerID: 'anthropic' } },
      output,
    );

    expect(output.system[0]).toContain('<name>alpha</name>');
    expect(output.system[0]).toContain('<name>beta</name>');
    expect(output.system[0]).toContain('<description>Short description.</description>');
    expect(output.system[0]).not.toContain('<location>');
    expect(output.system[0]).not.toContain('Skills provide specialized instructions');
    const compactedDescription = output.system[0].match(/<name>alpha<\/name>\s*<description>([^<]+)<\/description>/)?.[1] ?? '';
    expect(Array.from(compactedDescription)).toHaveLength(ANTHROPIC_SKILL_CATALOG_DESCRIPTION_LIMIT);
    expect(compactedDescription.endsWith('…')).toBe(true);
    expect(output.system[1]).toBe('Unrelated system text.');
    const originalPrefixBytes = Buffer.byteLength(original, 'utf8');
    const transformedPrefixBytes = Buffer.byteLength(output.system[0], 'utf8');
    expect(transformedPrefixBytes).toBeLessThan(originalPrefixBytes);
    expect(transformedPrefixBytes * 40).toBeLessThan(originalPrefixBytes * 40);
  });

  it('leaves non-Anthropic skill catalogs unchanged', async () => {
    const plugin = await DevRyanSkillContextPlugin();
    const system = '<available_skills><skill><name>alpha</name><description>Alpha</description><location>/tmp/alpha</location></skill></available_skills>';
    const output = { system: [system] };

    await plugin['experimental.chat.system.transform'](
      { model: { providerID: 'openai' } },
      output,
    );

    expect(output.system).toEqual([system]);
  });

  it('idempotently guides skill and ctx_execute_file while leaving unrelated tools unchanged', async () => {
    const plugin = await DevRyanSkillContextPlugin();
    const skill = { description: 'Load a skill by name.' };
    const executeFile = { description: 'Process a project file.' };
    const read = { description: 'Read a file.' };

    await plugin['tool.definition']({ toolID: 'skill' }, skill);
    await plugin['tool.definition']({ toolID: 'skill' }, skill);
    await plugin['tool.definition']({ toolID: 'ctx_execute_file' }, executeFile);
    await plugin['tool.definition']({ toolID: 'ctx_execute_file' }, executeFile);
    await plugin['tool.definition']({ toolID: 'read' }, read);

    expect(skill.description.split(SKILL_CONTEXT_POLICY_MARKER)).toHaveLength(2);
    expect(skill.description.split(EXTERNAL_SKILL_REFERENCE_POLICY_MARKER)).toHaveLength(2);
    expect(skill.description).toContain('moving from planning to implementation');
    expect(skill.description).toContain('no full result remains after compaction');
    expect(skill.description).toContain('use the native read tool');
    expect(executeFile.description.split(EXTERNAL_SKILL_REFERENCE_POLICY_MARKER)).toHaveLength(2);
    expect(executeFile.description).toContain('instead of ctx_execute_file');
    expect(executeFile.description).toContain('authorized for the active agent');
    expect(executeFile.description).toContain('Do not create or modify global OpenCode/Claude permission files');
    expect(executeFile.description).toContain('files contained by the active project');
    expect(executeFile.description).not.toContain(SKILL_CONTEXT_POLICY_MARKER);
    expect(read.description).toBe('Read a file.');
  });

  it('keeps one full body and compacts every byte-identical repeat without mutating its source state', async () => {
    const full = '<skill_content name="Impeccable">'.concat('Design guidance. '.repeat(500), '</skill_content>');
    const first = completedSkill({ id: 'first', output: full });
    const second = completedSkill({ id: 'second', output: full });
    const third = completedSkill({ id: 'third', output: full });
    const secondSourceState = second.state;
    const messages = [{ info: { role: 'assistant' }, parts: [first, second, third] }];
    const beforeBytes = Buffer.byteLength(JSON.stringify(messages));

    const transformed = await transform(messages);

    const skillOutputs = outputs(transformed);
    expect(skillOutputs[0]).toBe(full);
    expect(skillOutputs[1]).toContain(SKILL_CONTEXT_REUSE_MARKER);
    expect(skillOutputs[2]).toContain(SKILL_CONTEXT_REUSE_MARKER);
    expect(secondSourceState.output).toBe(full);
    expect(outputs(messages)).toEqual([full, full, full]);
    expect(transformed[0].parts[1].state).not.toBe(secondSourceState);
    expect(transformed[0].parts[1]).toMatchObject({
      id: second.id,
      callID: second.callID,
      sessionID: second.sessionID,
      messageID: second.messageID,
      state: {
        status: second.state.status,
        title: second.state.title,
        metadata: second.state.metadata,
        time: second.state.time,
      },
    });
    expect(Buffer.byteLength(JSON.stringify(transformed))).toBeLessThan(beforeBytes / 2);
  });

  it('does not conflate different skill names with identical output', async () => {
    const shared = '<skill_content>Shared text.</skill_content>';
    const messages = [{
      info: { role: 'assistant' },
      parts: [
        completedSkill({ name: 'Accessibility', output: shared }),
        completedSkill({ name: 'Impeccable', output: shared }),
      ],
    }];

    const transformed = await transform(messages);

    expect(outputs(transformed)).toEqual([shared, shared]);
  });

  it('retains every content transition, including a return to an older version', async () => {
    const versionOne = '<skill_content>Version one.</skill_content>';
    const versionTwo = '<skill_content>Version two.</skill_content>';
    const messages = [{
      info: { role: 'assistant' },
      parts: [
        completedSkill({ output: versionOne }),
        completedSkill({ output: versionOne }),
        completedSkill({ output: versionTwo }),
        completedSkill({ output: versionTwo }),
        completedSkill({ output: versionOne }),
      ],
    }];

    const transformed = await transform(messages);

    const skillOutputs = outputs(transformed);
    expect(skillOutputs[0]).toBe(versionOne);
    expect(skillOutputs[1]).toContain(SKILL_CONTEXT_REUSE_MARKER);
    expect(skillOutputs[2]).toBe(versionTwo);
    expect(skillOutputs[3]).toContain(SKILL_CONTEXT_REUSE_MARKER);
    expect(skillOutputs[4]).toBe(versionOne);
  });

  it('is idempotent when provider-bound messages are transformed repeatedly', async () => {
    const full = '<skill_content>Stable body.</skill_content>';
    const messages = [{
      info: { role: 'assistant' },
      parts: [completedSkill({ output: full }), completedSkill({ output: full })],
    }];

    const transformed = await transform(messages);
    const once = JSON.stringify(transformed);
    const transformedAgain = await transform(transformed);

    expect(JSON.stringify(transformedAgain)).toBe(once);
    expect(outputs(transformedAgain).filter((output) => output === full)).toHaveLength(1);
  });

  it('leaves non-completed, malformed, empty, compacted, and non-skill parts unchanged', async () => {
    const compacted = completedSkill({ id: 'compacted', compacted: 5 });
    const running = {
      ...completedSkill({ id: 'running' }),
      state: { status: 'running', input: { name: 'Impeccable' }, time: { start: 1 } },
    };
    const pending = {
      ...completedSkill({ id: 'pending' }),
      state: { status: 'pending', input: { name: 'Impeccable' } },
    };
    const errored = {
      ...completedSkill({ id: 'errored' }),
      state: { status: 'error', input: { name: 'Impeccable' }, error: 'failed' },
    };
    const empty = completedSkill({ id: 'empty', output: '' });
    const whitespace = completedSkill({ id: 'whitespace', output: '   \n' });
    const malformed = { type: 'tool', tool: 'skill', state: { status: 'completed', input: {} } };
    const read = { ...completedSkill({ id: 'read' }), tool: 'read' };
    const parts = [
      compacted,
      running,
      pending,
      errored,
      empty,
      whitespace,
      malformed,
      read,
      { type: 'text', text: 'hello' },
    ];
    const before = JSON.stringify(parts);

    const messages = [{ info: { role: 'assistant' }, parts }];
    const transformed = await transform(messages);

    expect(JSON.stringify(parts)).toBe(before);
    expect(transformed).toBe(messages);
  });

  it('keeps the next full body when the earlier copy was compacted, replaced by a reuse marker, or removed', async () => {
    const full = '<skill_content>Recover after compaction.</skill_content>';
    const compactedMessages = [{
      info: { role: 'assistant' },
      parts: [
        completedSkill({ output: full, compacted: 10 }),
        completedSkill({ output: full }),
      ],
    }];
    const removedMessages = [{
      info: { role: 'assistant' },
      parts: [completedSkill({ output: full })],
    }];
    const markerSeed = [{
      info: { role: 'assistant' },
      parts: [completedSkill({ output: full }), completedSkill({ output: full })],
    }];

    const transformedCompacted = await transform(compactedMessages);
    const transformedRemoved = await transform(removedMessages);
    const transformedMarkerSeed = await transform(markerSeed);

    const markerThenFull = [{
      info: { role: 'assistant' },
      parts: [transformedMarkerSeed[0].parts[1], completedSkill({ output: full })],
    }];
    const transformedMarkerThenFull = await transform(markerThenFull);

    expect(outputs(transformedCompacted)).toEqual([full, full]);
    expect(outputs(transformedRemoved)).toEqual([full]);
    expect(outputs(transformedMarkerThenFull)[0]).toContain(SKILL_CONTEXT_REUSE_MARKER);
    expect(outputs(transformedMarkerThenFull)[1]).toBe(full);
  });
});
