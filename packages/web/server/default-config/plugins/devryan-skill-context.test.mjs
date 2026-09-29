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

  // OpenCode hands native plugins the legacy SDK client: its App exposes only
  // log() and agents(), never skills(). The catalog must be read through the
  // agents() URL override, exactly as it is in production.
  const legacyClient = (read) => {
    const calls = [];
    return {
      calls,
      client: { app: { agents: async (options) => { calls.push(options); return read(options); } } },
    };
  };

  const makePlugin = () => DevRyanSkillContextPlugin({
    ...legacyClient(async () => ({ data: catalog })),
    directory: '/repo',
  });

  const runBefore = async (requested) => {
    const hooks = await makePlugin();
    const output = { args: { name: requested } };
    await hooks['tool.execute.before']({ tool: 'skill' }, output);
    return output.args.name;
  };

  it('reads the catalog through the legacy client /skill URL override', async () => {
    const { client, calls } = legacyClient(async () => ({ data: catalog }));
    const hooks = await DevRyanSkillContextPlugin({ client, directory: '/repo' });
    const output = { args: { name: 'accessibility' } };
    await hooks['tool.execute.before']({ tool: 'skill' }, output);
    expect(calls).toEqual([{ url: '/skill', query: { directory: '/repo' } }]);
    expect(output.args.name).toBe('Accessibility (a11y)');
  });

  it('uses the SDK v2 skills() method when the client provides it', async () => {
    const hooks = await DevRyanSkillContextPlugin({
      client: { app: { skills: async () => ({ data: catalog }) } },
      directory: '/repo',
    });
    const output = { args: { name: '1health-vitest' } };
    await hooks['tool.execute.before']({ tool: 'skill' }, output);
    expect(output.args.name).toBe('1Health Vitest');
  });

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

  it('rejects colliding aliases with the catalog instead of selecting an arbitrary skill', async () => {
    const hooks = await DevRyanSkillContextPlugin(legacyClient(async () => ({ data: [
      { name: 'Code Review', location: '/a/skills/review/SKILL.md' },
      { name: 'Code-Review', location: '/b/skills/review/SKILL.md' },
    ] })));
    for (const name of ['code-review', 'review', 'code']) {
      const output = { args: { name } };
      const error = await hooks['tool.execute.before']({ tool: 'skill' }, output).catch((err) => err);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain(`Skill "${name}" not found.`);
      expect(output.args.name).toBe(name);
    }
    const exact = { args: { name: 'Code Review' } };
    await hooks['tool.execute.before']({ tool: 'skill' }, exact);
    expect(exact.args.name).toBe('Code Review');
  });

  it('rejects an unknown name with the slug-aware catalog', async () => {
    const hooks = await makePlugin();
    const output = { args: { name: 'definitely-not-a-skill' } };
    const error = await hooks['tool.execute.before']({ tool: 'skill' }, output).catch((err) => err);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('Skill "definitely-not-a-skill" not found.');
    expect(error.message).toContain('accessibility (Accessibility (a11y))');
    expect(error.message).toContain('1health-vitest (1Health Vitest)');
    // "Linear" and its slug normalize identically, so it renders once.
    expect(error.message).toContain('Linear');
    expect(error.message).not.toContain('linear (Linear)');
  });

  it('refreshes a stale catalog before rejecting a newly added skill', async () => {
    let current = catalog;
    const { client, calls } = legacyClient(async () => ({ data: current }));
    const hooks = await DevRyanSkillContextPlugin({ client, directory: '/repo' });

    await hooks['tool.execute.before']({ tool: 'skill' }, { args: { name: 'linear' } });
    current = [...catalog, { name: 'Fresh Skill', location: '/repo/.agents/skills/fresh-skill/SKILL.md' }];

    const output = { args: { name: 'fresh-skill' } };
    await hooks['tool.execute.before']({ tool: 'skill' }, output);
    expect(output.args.name).toBe('Fresh Skill');
    expect(calls).toHaveLength(2);
  });

  it('ignores tools other than skill', async () => {
    const hooks = await makePlugin();
    const output = { args: { name: 'accessibility' } };
    await hooks['tool.execute.before']({ tool: 'read' }, output);
    expect(output.args.name).toBe('accessibility');
  });

  it('passes the call through when the catalog read throws', async () => {
    const hooks = await DevRyanSkillContextPlugin(legacyClient(async () => { throw new Error('boom'); }));
    const output = { args: { name: 'accessibility' } };
    await expect(hooks['tool.execute.before']({ tool: 'skill' }, output)).resolves.toBeUndefined();
    expect(output.args.name).toBe('accessibility');
  });

  it('passes the call through when the catalog request returns an error', async () => {
    const hooks = await DevRyanSkillContextPlugin(legacyClient(async () => ({ error: { status: 500 }, data: undefined })));
    const output = { args: { name: 'accessibility' } };
    await expect(hooks['tool.execute.before']({ tool: 'skill' }, output)).resolves.toBeUndefined();
    expect(output.args.name).toBe('accessibility');
  });

  it('passes the call through when the client exposes no catalog transport', async () => {
    const hooks = await DevRyanSkillContextPlugin({ client: { app: {} } });
    const output = { args: { name: 'accessibility' } };
    await expect(hooks['tool.execute.before']({ tool: 'skill' }, output)).resolves.toBeUndefined();
    expect(output.args.name).toBe('accessibility');
  });

  it('does not register a tool.execute.after hook, which never sees thrown skill errors', async () => {
    const hooks = await makePlugin();
    expect(hooks['tool.execute.after']).toBeUndefined();
  });
});
