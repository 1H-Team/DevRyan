import { describe, expect, it } from 'vitest';

import { DevRyanSkillContextPlugin, __test } from './devryan-skill-context.mjs';

// Constants live on `__test` because OpenCode's plugin loader rejects any module
// with a non-function named export.
const {
  ANTHROPIC_SKILL_CATALOG_DESCRIPTION_LIMIT,
  EXTERNAL_SKILL_REFERENCE_POLICY_MARKER,
  SKILL_CONTEXT_POLICY_MARKER,
  SKILL_CONTEXT_REUSE_MARKER,
} = __test;

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

  it.each(['xai', 'grok', 'xai-oauth'])('compacts skill metadata for Grok provider alias %s', async (providerID) => {
    const plugin = await DevRyanSkillContextPlugin();
    const system = `<available_skills><skill><name>context-mode</name><description>${'Verbose details. '.repeat(30)}</description><location>/private/skill/SKILL.md</location></skill></available_skills>`;
    const output = { system: [system] };

    await plugin['experimental.chat.system.transform'](
      { model: { providerID } },
      output,
    );

    expect(output.system[0]).toContain('<name>context-mode</name>');
    expect(output.system[0]).not.toContain('<location>');
    expect(Buffer.byteLength(output.system[0], 'utf8')).toBeLessThan(Buffer.byteLength(system, 'utf8'));
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

describe('skill alias resolution', () => {
  // Real shapes observed in the 1Health repo on 2026-08-21, where the model
  // called the directory slug and the tool failed with "not found" even though
  // every one of these skills existed on disk.
  const catalog = [
    { name: 'Accessibility (a11y)', location: '/repo/.agents/skills/accessibility/SKILL.md' },
    { name: '1Health Vitest', location: '/repo/.agents/skills/1health-vitest/SKILL.md' },
    { name: 'Linear', location: '/repo/.agents/skills/linear/SKILL.md' },
    { name: '1Health Data Layer', location: '/repo/.agents/skills/1health-data-layer/SKILL.md' },
  ];

  const makePlugin = () => DevRyanSkillContextPlugin({
    client: { app: { skills: async () => ({ data: catalog }) } },
    directory: '/repo',
  });

  const runBefore = async (requested) => {
    const hooks = await makePlugin();
    const output = { args: { name: requested } };
    await hooks['tool.execute.before']({ tool: 'skill' }, output);
    return output.args.name;
  };

  it('rewrites a directory slug to the registered display name', async () => {
    expect(await runBefore('1health-vitest')).toBe('1Health Vitest');
    expect(await runBefore('1health-data-layer')).toBe('1Health Data Layer');
  });

  it('resolves a slug that is a prefix of the registered name', async () => {
    expect(await runBefore('accessibility')).toBe('Accessibility (a11y)');
  });

  it('resolves case-insensitively', async () => {
    expect(await runBefore('linear')).toBe('Linear');
  });

  it('leaves an already-correct canonical name untouched', async () => {
    expect(await runBefore('1Health Vitest')).toBe('1Health Vitest');
  });

  it('leaves an unknown name untouched so the tool reports it honestly', async () => {
    expect(await runBefore('definitely-not-a-skill')).toBe('definitely-not-a-skill');
  });

  it('ignores tools other than skill', async () => {
    const hooks = await makePlugin();
    const output = { args: { name: 'accessibility' } };
    await hooks['tool.execute.before']({ tool: 'read' }, output);
    expect(output.args.name).toBe('accessibility');
  });

  it('does not throw when the catalog cannot be read', async () => {
    const hooks = await DevRyanSkillContextPlugin({
      client: { app: { skills: async () => { throw new Error('boom'); } } },
    });
    const output = { args: { name: 'accessibility' } };
    await expect(hooks['tool.execute.before']({ tool: 'skill' }, output)).resolves.toBeUndefined();
    expect(output.args.name).toBe('accessibility');
  });

  it('rewrites the not-found error with slugs and a suggestion', async () => {
    const hooks = await makePlugin();
    const output = { output: 'Skill "1health-serch" not found. Available skills: Accessibility (a11y), Linear' };
    await hooks['tool.execute.after']({ tool: 'skill' }, output);

    expect(output.output).toContain('accessibility (Accessibility (a11y))');
    expect(output.output).toContain('1health-vitest (1Health Vitest)');
    // "Linear" and its slug normalize identically, so it renders once.
    expect(output.output).toContain('Linear');
    expect(output.output).not.toContain('linear (Linear)');
  });

  it('suggests the closest match in the not-found error', async () => {
    const hooks = await makePlugin();
    const output = { output: 'Skill "accessibility" not found. Available skills: Linear' };
    await hooks['tool.execute.after']({ tool: 'skill' }, output);
    expect(output.output).toContain('Did you mean "Accessibility (a11y)"?');
  });

  it('leaves successful skill output alone', async () => {
    const hooks = await makePlugin();
    const output = { output: '# Accessibility\nsome real skill body' };
    await hooks['tool.execute.after']({ tool: 'skill' }, output);
    expect(output.output).toBe('# Accessibility\nsome real skill body');
  });
});
