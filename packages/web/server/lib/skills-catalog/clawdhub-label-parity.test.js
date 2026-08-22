import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');

const extractLabel = (relativePath) => {
  const source = fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8');
  const match = source.match(/(?:id|source):\s*['"]clawdhub['"][\s\S]{0,240}?label:\s*['"]([^'"]+)['"]/);
  if (!match) throw new Error(`ClawdHub label not found in ${relativePath}`);
  return match[1];
};

describe('ClawdHub label parity', () => {
  it('keeps the existing public label aligned across every runtime', () => {
    const labels = [
      extractLabel('packages/web/server/lib/skills-catalog/curated-sources.js'),
      extractLabel('packages/ui/src/stores/useSkillsCatalogStore.ts'),
      extractLabel('packages/vscode/src/skillsCatalog.ts'),
    ];
    expect(labels).toEqual(['ClawdHub', 'ClawdHub', 'ClawdHub']);
  });
});
