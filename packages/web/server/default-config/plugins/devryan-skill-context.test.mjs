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
    const system = `<available_skills><skill><name>sample-skill</name><description>${'Verbose details. '.repeat(30)}</description><location>/private/skill/SKILL.md</location></skill></available_skills>`;
    const output = { system: [system] };

    await plugin['experimental.chat.system.transform'](
      { model: { providerID } },
      output,
    );

    expect(output.system[0]).toContain('<name>sample-skill</name>');
    expect(output.system[0]).not.toContain('<location>');
    expect(Buffer.byteLength(output.system[0], 'utf8')).toBeLessThan(Buffer.byteLength(system, 'utf8'));
  });

  it('idempotently guides the skill tool while leaving unrelated tools unchanged', async () => {
    const plugin = await DevRyanSkillContextPlugin();
    const skill = { description: 'Load a skill by name.' };
    const read = { description: 'Read a file.' };

    await plugin['tool.definition']({ toolID: 'skill' }, skill);
    await plugin['tool.definition']({ toolID: 'skill' }, skill);
    await plugin['tool.definition']({ toolID: 'read' }, read);

    expect(skill.description.split(SKILL_CONTEXT_POLICY_MARKER)).toHaveLength(2);
    expect(skill.description.split(EXTERNAL_SKILL_REFERENCE_POLICY_MARKER)).toHaveLength(2);
    expect(skill.description).toContain('moving from planning to implementation');
    expect(skill.description).toContain('no full result remains after compaction');
    expect(skill.description).toContain('use the native read tool for that file');
    expect(skill.description).toContain('authorized for the active agent');
    expect(skill.description).toContain('Do not create or modify global OpenCode/Claude permission files');
    expect(read.description).toBe('Read a file.');
  });

  it('leaves transcript projection exclusively to the qualified managed harness', async () => {
    const plugin = await DevRyanSkillContextPlugin();
    expect(plugin['experimental.chat.messages.transform']).toBeUndefined();
    expect(SKILL_CONTEXT_REUSE_MARKER).toBe('<devryan_skill_reuse>');
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

  it('does not select an arbitrary skill when normalized aliases collide', async () => {
    const hooks = await DevRyanSkillContextPlugin({ client: { app: { skills: async () => ({ data: [
      { name: 'Code Review', location: '/a/skills/review/SKILL.md' },
      { name: 'Code-Review', location: '/b/skills/review/SKILL.md' },
    ] }) } } });
    for (const name of ['code-review', 'review', 'code']) {
      const output = { args: { name } };
      await hooks['tool.execute.before']({ tool: 'skill' }, output);
      expect(output.args.name).toBe(name);
    }
    const exact = { args: { name: 'Code Review' } };
    await hooks['tool.execute.before']({ tool: 'skill' }, exact);
    expect(exact.args.name).toBe('Code Review');
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
