import path from 'node:path';

export function createHarnessSkillDiscovery({ fs, os, yaml, discoverSkills, findWorktreeRoot, getAncestors, resolveSkillSearchDirectories, walkSkillMdFiles }) {
  function parseSkillFrontmatterForHarness(skillMdPath) {
    try {
      const content = fs.readFileSync(skillMdPath, 'utf8');
      const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
      if (!match) {
        return {
          name: '',
          path: skillMdPath,
          parseOk: false,
          error: 'Missing YAML frontmatter',
        };
      }
      const frontmatter = yaml.parse(match[1]) || {};
      const name = typeof frontmatter.name === 'string' ? frontmatter.name.trim() : '';
      return {
        name,
        path: skillMdPath,
        parseOk: Boolean(name),
        ...(name ? {} : { error: 'Missing skill name in frontmatter' }),
      };
    } catch (error) {
      return {
        name: '',
        path: skillMdPath,
        parseOk: false,
        error: error.message || 'Failed to parse skill frontmatter',
      };
    }
  }

  function collectHarnessSkillEntries(directory) {
    const byPath = new Map();
    for (const skill of discoverSkills(directory)) {
      if (!skill?.path) continue;
      byPath.set(path.resolve(skill.path), {
        ...skill,
        parseOk: true,
      });
    }

    const roots = [
      path.join(os.homedir(), '.agents', 'skills'),
    ];

    if (directory) {
      const worktreeRoot = findWorktreeRoot(directory) || path.resolve(directory);
      for (const ancestor of getAncestors(directory, worktreeRoot)) {
        roots.push(path.join(ancestor, '.agents', 'skills'));
      }
    }

    for (const dir of resolveSkillSearchDirectories(directory)) {
      roots.push(path.join(dir, 'skill'));
      roots.push(path.join(dir, 'skills'));
    }

    for (const root of roots) {
      for (const skillMdPath of walkSkillMdFiles(root)) {
        const resolved = path.resolve(skillMdPath);
        if (byPath.has(resolved)) continue;
        byPath.set(resolved, parseSkillFrontmatterForHarness(skillMdPath));
      }
    }

    return [...byPath.values()];
  }

  return { collectHarnessSkillEntries, parseSkillFrontmatterForHarness };
}
