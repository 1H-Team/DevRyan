import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

const readAgent = (name) => fs.readFileSync(path.join(import.meta.dirname, `${name}.md`), 'utf8');

const readFrontmatter = (name) => {
  const match = readAgent(name).match(/^---\n([\s\S]*?)\n---/);
  if (!match) throw new Error(`Missing frontmatter for ${name}`);
  return YAML.parse(match[1]);
};

describe('packaged Context Mode routing', () => {
  it('gives Explorer the project-indexing read-only subset with direct and MCP aliases', () => {
    const permission = readFrontmatter('explorer').permission;

    for (const tool of [
      'ctx_index',
      'mcp__context_mode__ctx_index',
      'ctx_search',
      'mcp__context_mode__ctx_search',
      'ctx_stats',
      'mcp__context_mode__ctx_stats',
    ]) {
      expect(permission[tool]).toBe('allow');
    }
    expect(permission['*']).toBe('deny');
    expect(permission.bash).toBe('deny');
  });

  it('gives Librarian only the web-indexing read-only subset', () => {
    const permission = readFrontmatter('librarian').permission;

    for (const tool of [
      'ctx_fetch_and_index',
      'mcp__context_mode__ctx_fetch_and_index',
      'ctx_search',
      'mcp__context_mode__ctx_search',
      'ctx_stats',
      'mcp__context_mode__ctx_stats',
    ]) {
      expect(permission[tool]).toBe('allow');
    }
    expect(permission.ctx_index).toBeUndefined();
    expect(permission['*']).toBe('deny');
  });

  it('keeps Plan Context execution disabled while allowing read-only indexing', () => {
    const permission = readFrontmatter('plan').permission;

    for (const tool of [
      'ctx_execute',
      'mcp__context_mode__ctx_execute',
      'ctx_execute_file',
      'mcp__context_mode__ctx_execute_file',
      'ctx_batch_execute',
      'mcp__context_mode__ctx_batch_execute',
      'ctx_purge',
      'mcp__context_mode__ctx_purge',
      'ctx_upgrade',
      'mcp__context_mode__ctx_upgrade',
    ]) {
      expect(permission[tool]).toBe('deny');
    }
    for (const tool of [
      'ctx_index',
      'mcp__context_mode__ctx_index',
      'ctx_search',
      'mcp__context_mode__ctx_search',
      'ctx_fetch_and_index',
      'mcp__context_mode__ctx_fetch_and_index',
    ]) {
      expect(permission[tool]).toBe('allow');
    }
  });

  it.each([
    'builder',
    'designer',
    'explorer',
    'fixer',
    'librarian',
    'oracle',
    'orchestrator',
    'plan',
  ])('routes broad analysis through Context Mode with a bounded native fallback for %s', (name) => {
    const prompt = readAgent(name);
    expect(prompt).toMatch(/broad|large pages|multi-source/i);
    expect(prompt).toMatch(/Context Mode|ctx_index|ctx_fetch_and_index/);
    expect(prompt).toMatch(/bounded exact|bounded native/i);
    expect(prompt).toMatch(/without retrying Context Mode|do not retry any `ctx_\*` tool/i);
  });
});
