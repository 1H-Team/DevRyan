import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { createSkill, deleteSkill, discoverSkills, getSkillSources } from './skills.js';

describe('skill discovery', () => {
  it('does not treat non-file discovered skill paths as editable markdown sources', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-runtime-skill-'));

    try {
      const sources = getSkillSources('runtime-helper', root, {
        name: 'runtime-helper',
        description: 'Runtime helper',
        path: '<built-in>',
        scope: 'user',
        source: 'opencode',
        preferDiscoveredPath: true,
      });

      expect(sources.md.exists).toBe(false);
      expect(sources.md.path).toBe(null);
      expect(sources.md.supportingFiles).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps duplicate skill names when their canonical paths differ', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-skills-'));
    const opencodeSkill = path.join(root, '.opencode', 'skills', 'lint-helper');
    const agentsSkill = path.join(root, '.agents', 'skills', 'lint-helper');
    fs.mkdirSync(opencodeSkill, { recursive: true });
    fs.mkdirSync(agentsSkill, { recursive: true });
    fs.writeFileSync(path.join(opencodeSkill, 'SKILL.md'), '---\nname: lint-helper\ndescription: Project default\n---\n');
    fs.writeFileSync(path.join(agentsSkill, 'SKILL.md'), '---\nname: lint-helper\ndescription: Agents skill\n---\n');

    const skills = discoverSkills(root)
      .filter((skill) => skill.name === 'lint-helper' && skill.path.startsWith(root))
      .sort((a, b) => a.path.localeCompare(b.path));

    expect(skills).toHaveLength(2);
    expect(skills.map((skill) => skill.path)).toEqual([
      path.join(root, '.agents', 'skills', 'lint-helper', 'SKILL.md'),
      path.join(root, '.opencode', 'skills', 'lint-helper', 'SKILL.md'),
    ]);
  });

  it('permanently deletes only the supplied discovered skill directory', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-skills-delete-'));
    const userSkill = path.join(root, '.agents', 'skills', 'lint-helper');
    const projectSkill = path.join(root, '.opencode', 'skills', 'lint-helper');
    const userSkillPath = path.join(userSkill, 'SKILL.md');
    const projectSkillPath = path.join(projectSkill, 'SKILL.md');
    fs.mkdirSync(userSkill, { recursive: true });
    fs.mkdirSync(projectSkill, { recursive: true });
    fs.writeFileSync(userSkillPath, '---\nname: lint-helper\n---\n');
    fs.writeFileSync(projectSkillPath, '---\nname: lint-helper\n---\n');

    try {
      deleteSkill('lint-helper', root, {
        name: 'lint-helper',
        path: projectSkillPath,
        scope: 'project',
        source: 'opencode',
      });

      expect(fs.existsSync(projectSkill)).toBe(false);
      expect(fs.existsSync(userSkill)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('discovers nested user skills from a config skills directory without an active project', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-user-skills-'));
    const originalConfigDir = process.env.OPENCODE_CONFIG_DIR;
    const skillDir = path.join(root, 'skills', 'superpowers', 'writing-plans');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: writing-plans\ndescription: Plan work\n---\n',
      'utf8',
    );

    try {
      process.env.OPENCODE_CONFIG_DIR = root;

      const skills = discoverSkills(null).filter((skill) => skill.path.startsWith(root));

      expect(skills).toEqual([
        {
          name: 'writing-plans',
          description: 'Plan work',
          path: path.join(skillDir, 'SKILL.md'),
          scope: 'user',
          source: 'opencode',
        },
      ]);
    } finally {
      if (originalConfigDir === undefined) {
        delete process.env.OPENCODE_CONFIG_DIR;
      } else {
        process.env.OPENCODE_CONFIG_DIR = originalConfigDir;
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('excludes the claude skill source from discovery', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-claude-skills-'));
    const agentsSkill = path.join(root, '.agents', 'skills', 'note-taker');
    const claudeSkill = path.join(root, '.claude', 'skills', 'note-taker');
    fs.mkdirSync(agentsSkill, { recursive: true });
    fs.mkdirSync(claudeSkill, { recursive: true });
    fs.writeFileSync(path.join(agentsSkill, 'SKILL.md'), '---\nname: note-taker\ndescription: Agents skill\n---\n');
    fs.writeFileSync(path.join(claudeSkill, 'SKILL.md'), '---\nname: note-taker\ndescription: Claude skill\n---\n');

    try {
      const skills = discoverSkills(root).filter((skill) => skill.path.startsWith(root));

      expect(skills.map((skill) => skill.path)).toEqual([
        path.join(agentsSkill, 'SKILL.md'),
      ]);
      expect(skills.some((skill) => skill.source === 'claude')).toBe(false);
      expect(skills.some((skill) => skill.path.includes(`${path.sep}.claude${path.sep}`))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not discover or create retired Superpowers skills from project harness directories', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-retired-skills-'));
    const controlSkill = path.join(root, '.agents', 'skills', 'control-skill');
    const retiredNames = ['test-driven-development', 'subagent-driven-development'];
    fs.mkdirSync(controlSkill, { recursive: true });
    fs.writeFileSync(
      path.join(controlSkill, 'SKILL.md'),
      '---\nname: control-skill\ndescription: Visible control\n---\n',
      'utf8',
    );
    for (const name of retiredNames) {
      const skillDirectory = path.join(root, '.agents', 'skills', name);
      fs.mkdirSync(skillDirectory, { recursive: true });
      fs.writeFileSync(
        path.join(skillDirectory, 'SKILL.md'),
        `---\nname: ${name}\ndescription: Must remain unavailable\n---\n`,
        'utf8',
      );
    }

    try {
      const skills = discoverSkills(root).filter((skill) => skill.path.startsWith(root));
      expect(skills.map((skill) => skill.name)).toEqual(['control-skill']);
      for (const name of retiredNames) {
        expect(() => createSkill(name, {}, root, 'project')).toThrow(
          `Skill "${name}" is retired`,
        );
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
