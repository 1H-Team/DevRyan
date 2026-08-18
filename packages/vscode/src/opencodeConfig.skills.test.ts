import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { discoverSkills } from './opencodeConfig';

describe('VS Code skill discovery', () => {
  it('matches the managed web policy for project skill roots', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-vscode-skills-'));
    const fixtures = [
      ['.agents', 'skills', 'accessibility'],
      ['.opencode', 'skill', 'opencode-helper'],
      ['.cursor', 'skills', 'cursor-helper'],
      ['.codex', 'skills', 'codex-helper'],
      ['.claude', 'skills', 'claude-helper'],
    ];
    for (const segments of fixtures) {
      const skillDir = path.join(root, ...segments);
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        `---\nname: ${segments.at(-1)}\ndescription: Fixture\n---\n`,
      );
    }

    try {
      const skills = discoverSkills(root).filter((skill) => skill.path.startsWith(root));
      expect(skills.map((skill) => `${skill.source}:${skill.name}`).sort()).toEqual([
        'agents:accessibility',
        'opencode:opencode-helper',
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
