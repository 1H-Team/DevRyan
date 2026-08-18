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

describe('packaged document-reader permissions', () => {
  it.each(['explorer', 'librarian'])('allows %s to read task-scoped documents despite wildcard deny', (name) => {
    const frontmatter = readFrontmatter(name);
    expect(frontmatter.permission['*']).toBe('deny');
    expect(frontmatter.permission.devryan_document).toBe('allow');
  });
});
