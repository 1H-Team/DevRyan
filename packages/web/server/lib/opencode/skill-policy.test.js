import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { describe, expect, it } from 'vitest';

import {
  applyRuntimeExternalDirectoryPolicy,
  buildVisibleSkillPolicy,
  filterVisibleSkills,
  resolveApprovedSkills,
  sanitizeAgentSkillPolicy,
} from './skill-policy.js';

const runtimeDirectoryAllows = (...directories) => Object.fromEntries(
  directories.flatMap((directory) => {
    const resolved = path.resolve(directory);
    const candidates = [resolved];
    try {
      const real = fs.realpathSync(resolved);
      if (real && real !== resolved) candidates.push(real);
    } catch {
    }
    return candidates.map((candidate) => [`${candidate.replace(/\/+$/, '')}/*`, 'allow']);
  }),
);

describe('skill policy', () => {
  it('adds runtime directories without changing role-level tool permissions', () => {
    const frontmatter = applyRuntimeExternalDirectoryPolicy({
      permission: {
        '*': 'deny',
        external_directory: {
          '*': 'ask',
          '/tmp/scratch/*': 'deny',
        },
        read: {
          '*': 'allow',
          '*.env': 'ask',
        },
        edit: 'deny',
      },
    }, ['/tmp/project/plans']);

    expect(frontmatter.permission).toEqual({
      '*': 'deny',
      external_directory: {
        '*': 'ask',
        '/tmp/scratch/*': 'deny',
        '/tmp/project/plans/*': 'allow',
      },
      read: {
        '*': 'allow',
        '*.env': 'ask',
      },
      edit: 'deny',
    });
  });

  it('filters hidden skills by normalized SKILL.md path', () => {
    const visiblePath = path.join('/tmp', 'skills', 'frontend-design', 'SKILL.md');
    const hiddenPath = path.join('/tmp', 'skills', 'debugging', 'SKILL.md');
    const skills = [
      { name: 'frontend-design', path: visiblePath },
      { name: 'debugging', path: hiddenPath },
    ];

    const result = filterVisibleSkills(skills, [
      { name: 'debugging', path: path.join('/tmp', 'skills', 'debugging', '.', 'SKILL.md') },
    ]);

    expect(result.map((skill) => skill.name)).toEqual(['frontend-design']);
  });

  it('deduplicates visible skills by normalized SKILL.md path', () => {
    const skillPath = path.join('/tmp', 'skills', 'debugging', 'SKILL.md');
    const skills = [
      { name: 'debugging', path: skillPath, description: 'Local discovery' },
      { name: 'debugging', path: path.join('/tmp', 'skills', 'debugging', '.', 'SKILL.md'), description: 'Runtime discovery' },
      { name: 'frontend-design', path: path.join('/tmp', 'skills', 'frontend-design', 'SKILL.md') },
    ];

    const result = filterVisibleSkills(skills, []);

    expect(result.map((skill) => `${skill.name}:${skill.description || ''}`)).toEqual([
      'debugging:Local discovery',
      'frontend-design:',
    ]);
  });

  it('hides package-cache skills', () => {
    const skills = [
      {
        name: 'dispatching-parallel-agents',
        path: '/Users/test/.config/opencode/skills/superpowers/dispatching-parallel-agents/SKILL.md',
      },
      {
        name: 'dispatching-parallel-agents',
        path: '/Users/test/.cache/opencode/packages/superpowers/node_modules/superpowers/skills/dispatching-parallel-agents/SKILL.md',
      },
      {
        name: 'cache-only',
        path: '/Users/test/.cache/opencode/packages/example/skills/cache-only/SKILL.md',
      },
    ];

    const result = filterVisibleSkills(skills, []);

    expect(result.map((skill) => skill.path)).toEqual([
      '/Users/test/.config/opencode/skills/superpowers/dispatching-parallel-agents/SKILL.md',
    ]);
  });

  it('rejects unsupported skill roots and sources', () => {
    const result = filterVisibleSkills([
      { name: 'agents-ok', path: '/repo/.agents/skills/agents-ok/SKILL.md', source: 'agents' },
      { name: 'opencode-ok', path: '/repo/.opencode/skills/opencode-ok/SKILL.md', source: 'opencode' },
      { name: 'cursor-no', path: '/repo/.cursor/skills/cursor-no/SKILL.md', source: 'opencode' },
      { name: 'codex-no', path: '/repo/.codex/skills/codex-no/SKILL.md', source: 'opencode' },
      { name: 'claude-no', path: '/repo/.claude/skills/claude-no/SKILL.md', source: 'claude' },
      { name: 'plugin-no', path: '/home/test/.codex/plugins/cache/example/skills/plugin-no/SKILL.md', source: 'opencode' },
    ], []);

    expect(result.map((skill) => skill.name)).toEqual(['agents-ok', 'opencode-ok']);
  });

  it('uses local discovery as authority and only enriches exact runtime paths', () => {
    const approvedPath = '/repo/.agents/skills/accessibility/SKILL.md';
    const result = resolveApprovedSkills({
      discoveredSkills: [{
        name: 'accessibility',
        path: approvedPath,
        scope: 'project',
        source: 'agents',
        description: 'Local description',
      }],
      runtimeSkills: [
        { name: 'accessibility', path: approvedPath, description: 'Runtime description' },
        { name: 'runtime-only', path: '/runtime/skills/runtime-only/SKILL.md', description: 'Untrusted' },
      ],
    });

    expect(result).toEqual([{
      name: 'accessibility',
      path: approvedPath,
      scope: 'project',
      source: 'agents',
      description: 'Runtime description',
    }]);
  });

  it('denies retired Superpowers skill names regardless of their directory', () => {
    const result = filterVisibleSkills([
      {
        name: 'test-driven-development',
        path: '/tmp/project/.agents/skills/test-driven-development/SKILL.md',
      },
      {
        name: 'subagent-driven-development',
        path: '/Users/test/.agents/skills/subagent-driven-development/SKILL.md',
      },
      {
        name: 'systematic-debugging',
        path: '/Users/test/.config/opencode/skills/superpowers/systematic-debugging/SKILL.md',
      },
    ], []);

    expect(result.map((skill) => skill.name)).toEqual(['systematic-debugging']);
  });

  it('normalizes existing symlinked skill paths to their real SKILL.md target', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-policy-realpath-'));
    const realDir = path.join(root, 'real', 'frontend-design');
    const linkDir = path.join(root, 'linked', 'frontend-design');
    fs.mkdirSync(realDir, { recursive: true });
    fs.mkdirSync(path.dirname(linkDir), { recursive: true });
    fs.writeFileSync(path.join(realDir, 'SKILL.md'), '---\nname: frontend-design\n---\n');
    fs.symlinkSync(realDir, linkDir, 'dir');

    const visiblePath = path.join(realDir, 'SKILL.md');
    const linkedPath = path.join(linkDir, 'SKILL.md');

    const result = filterVisibleSkills([
      { name: 'frontend-design', path: visiblePath },
    ], [
      { name: 'frontend-design', path: linkedPath },
    ]);

    expect(result).toEqual([]);
  });

  it('builds an allow policy from visible skills only', () => {
    const skills = [
      { name: 'frontend-design', path: '/tmp/skills/frontend-design/SKILL.md' },
      { name: 'debugging', path: '/tmp/skills/debugging/SKILL.md' },
    ];

    const policy = buildVisibleSkillPolicy({
      skills,
      hiddenSkills: [{ name: 'debugging', path: '/tmp/skills/debugging/SKILL.md' }],
    });

    expect(policy.skillNames).toEqual(['frontend-design']);
    expect(policy.skillDirectories).toEqual(['/tmp/skills/frontend-design']);
  });

  it('excludes hidden global skills from agent skill names and directories', () => {
    const globalSkillPath = path.join('/home/tester', '.config', 'opencode', 'skills', 'lint-helper', 'SKILL.md');
    const visibleSkillPath = path.join('/home/tester', '.agents', 'skills', 'codemap', 'SKILL.md');

    const policy = buildVisibleSkillPolicy({
      skills: [
        { name: 'lint-helper', path: globalSkillPath },
        { name: 'codemap', path: visibleSkillPath },
      ],
      hiddenSkills: [{ name: 'lint-helper', path: globalSkillPath }],
    });

    expect(policy.skillNames).toEqual(['codemap']);
    expect(policy.skillDirectories).toEqual([path.dirname(visibleSkillPath)]);
    expect(policy.skillDirectories).not.toContain(path.dirname(globalSkillPath));
  });

  it('allows every visible skill for skill-capable agents without an explicit wildcard deny', () => {
    const policy = buildVisibleSkillPolicy({
      skills: [
        { name: 'frontend-design', path: '/tmp/skills/frontend-design/SKILL.md' },
        { name: 'project-audit', path: '/tmp/project/.opencode/skills/project-audit/SKILL.md' },
      ],
      hiddenSkills: [],
    });

    const frontmatter = sanitizeAgentSkillPolicy({
      permission: {
        '*': 'allow',
        external_directory: {
          '*': 'ask',
          '/tmp/skills/frontend-design/*': 'allow',
          '/tmp/skills/debugging/*': 'allow',
          '/tmp/scratch/*': 'allow',
        },
        skill: {
          'frontend-design': 'allow',
          debugging: 'allow',
        },
      },
    }, policy);

    expect(frontmatter.permission.skill).toEqual({
      '*': 'deny',
      'frontend-design': 'allow',
      'project-audit': 'allow',
    });
    expect(frontmatter.permission.external_directory).toEqual({
      '*': 'ask',
      '/tmp/scratch/*': 'allow',
      '/tmp/skills/frontend-design/*': 'allow',
      '/tmp/project/.opencode/skills/project-audit/*': 'allow',
    });
  });

  it('adds runtime project directories while preserving external-directory fallback and read prompts', () => {
    const policy = buildVisibleSkillPolicy({
      skills: [{ name: 'frontend-design', path: '/tmp/project/.opencode/skills/frontend-design/SKILL.md' }],
      hiddenSkills: [],
      runtimeExternalDirectories: [
        '/tmp/project/app',
        '/tmp/project',
      ],
    });

    const frontmatter = sanitizeAgentSkillPolicy({
      permission: {
        '*': 'allow',
        external_directory: {
          '*': 'ask',
        },
        read: {
          '*.env': 'ask',
        },
        skill: {
          'frontend-design': 'allow',
        },
      },
    }, policy);

    expect(frontmatter.permission.read).toEqual({ '*.env': 'ask' });
    expect(frontmatter.permission.external_directory).toEqual({
      '*': 'ask',
      ...runtimeDirectoryAllows('/tmp/project', '/tmp/project/app'),
      '/tmp/project/.opencode/skills/frontend-design/*': 'allow',
    });
  });

  it('dedupes repeated runtime external directory variants', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-policy-runtime-dir-'));
    const realDir = path.join(root, 'project');
    const linkDir = path.join(root, 'linked-project');
    fs.mkdirSync(realDir, { recursive: true });
    fs.symlinkSync(realDir, linkDir, 'dir');

    try {
      const policy = buildVisibleSkillPolicy({
        runtimeExternalDirectories: [realDir, linkDir, path.join(realDir, '.')],
      });

      const frontmatter = sanitizeAgentSkillPolicy({
        permission: {
          external_directory: {
            '*': 'ask',
          },
        },
      }, policy);

      expect(frontmatter.permission.external_directory).toEqual({
        '*': 'ask',
        ...runtimeDirectoryAllows(realDir, linkDir),
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('replaces stale per-skill lists with the complete approved set', () => {
    const policy = buildVisibleSkillPolicy({
      skills: [
        { name: 'codemap', path: '/tmp/skills/codemap/SKILL.md' },
        { name: 'project-audit', path: '/tmp/project/.opencode/skills/project-audit/SKILL.md' },
      ],
      hiddenSkills: [],
    });

    const frontmatter = sanitizeAgentSkillPolicy({
      permission: {
        '*': 'allow',
        skill: {
          '*': 'deny',
          codemap: 'allow',
        },
      },
    }, policy);

    expect(frontmatter.permission.skill).toEqual({
      '*': 'deny',
      codemap: 'allow',
      'project-audit': 'allow',
    });
    expect(frontmatter.permission.external_directory).toEqual({
      '/tmp/skills/codemap/*': 'allow',
      '/tmp/project/.opencode/skills/project-audit/*': 'allow',
    });
  });

  it('allows the approved set for agents without a per-skill list when their role permits tools', () => {
    const policy = buildVisibleSkillPolicy({
      skills: [{ name: 'frontend-design', path: '/tmp/skills/frontend-design/SKILL.md' }],
      hiddenSkills: [],
    });

    const frontmatter = sanitizeAgentSkillPolicy({
      permission: {
        '*': 'allow',
      },
    }, policy);

    expect(frontmatter.permission.skill).toEqual({
      '*': 'deny',
      'frontend-design': 'allow',
    });
  });

  it('preserves explicit complete skill denial', () => {
    const policy = buildVisibleSkillPolicy({
      skills: [{ name: 'frontend-design', path: '/tmp/skills/frontend-design/SKILL.md' }],
    });

    const directDeny = sanitizeAgentSkillPolicy({ permission: { '*': 'allow', skill: 'deny' } }, policy);
    const globalDeny = sanitizeAgentSkillPolicy({ permission: { '*': 'deny' } }, policy);

    expect(directDeny.permission.skill).toEqual({ '*': 'deny' });
    expect(globalDeny.permission.skill).toEqual({ '*': 'deny' });
  });
});
