import { it, expect } from 'vitest';
import { createHarnessSkillDiscovery } from './harness-skill-discovery.js';

it('deduplicates discovered skills and retains malformed frontmatter as explicit diagnostics', () => {
  const runtime = createHarnessSkillDiscovery({
    fs: { readFileSync: (file) => file.endsWith('bad.md') ? 'no frontmatter' : '---\nname: skill\n---\n' },
    os: { homedir: () => '/fixture' }, yaml: { parse: () => ({ name: 'skill' }) },
    discoverSkills: () => [{ path: '/fixture/good.md', name: 'existing' }],
    findWorktreeRoot: () => '/project', getAncestors: () => ['/project'],
    resolveSkillSearchDirectories: () => ['/project/.opencode'],
    walkSkillMdFiles: () => ['/fixture/good.md', '/fixture/bad.md'],
  });
  expect(runtime.collectHarnessSkillEntries('/project')).toEqual([
    { path: '/fixture/good.md', name: 'existing', parseOk: true },
    { path: '/fixture/bad.md', name: '', parseOk: false, error: 'Missing YAML frontmatter' },
  ]);
});
