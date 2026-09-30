import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

const readFrontmatter = (name) => {
  const content = fs.readFileSync(path.join(import.meta.dirname, `${name}.md`), 'utf8');
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) throw new Error(`Missing frontmatter for ${name}`);
  return YAML.parse(match[1]);
};

const deniesAll = (permission) => (
  permission === 'deny'
  || (permission && typeof permission === 'object' && permission['*'] === 'deny')
);

describe('packaged delegation permissions', () => {
  const childAgentNames = ['council', 'designer', 'explorer', 'fixer', 'librarian', 'oracle'];
  const packagedAgentNames = [
    'builder',
    ...childAgentNames,
    'orchestrator',
    'plan',
  ];

  it.each(childAgentNames)('keeps %s as a leaf managed specialist', (name) => {
    const frontmatter = readFrontmatter(name);

    expect(deniesAll(frontmatter.permission.task)).toBe(true);
    expect(frontmatter.permission.devryan_task).toBe('deny');
  });

  it('hides Slim background-task tools from Orchestrator, which delegates only through devryan_task', () => {
    // Slim's task_status/task_reply/... resolve only Slim-board jobs, which DevRyan never creates.
    const { permission } = readFrontmatter('orchestrator');
    expect(permission['task_*']).toBe('deny');
    const keys = Object.keys(permission);
    expect(keys.indexOf('task_*')).toBeGreaterThan(keys.indexOf('*'));
    expect(permission.devryan_task).toBe('allow');
  });

  it('exposes the private task tool to Builder for plans while native tasks stay denied', () => {
    const managedDelegators = packagedAgentNames.filter((name) => (
      readFrontmatter(name).permission.devryan_task === 'allow'
    ));

    expect(managedDelegators).toEqual(['builder', 'orchestrator']);
    expect(deniesAll(readFrontmatter('builder').permission.task)).toBe(true);
    expect(readFrontmatter('builder').permission.council_session).toBe('deny');
    expect(deniesAll(readFrontmatter('orchestrator').permission.task)).toBe(true);
  });
});
