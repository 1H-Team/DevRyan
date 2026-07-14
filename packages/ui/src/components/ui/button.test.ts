import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buttonVariants } from './button';

const testDirectory = dirname(fileURLToPath(import.meta.url));

describe('button casing', () => {
  test('preserves the authored casing for control labels', () => {
    const classNames = buttonVariants().split(/\s+/);

    expect(classNames).toContain('normal-case');
    expect(classNames).not.toContain('lowercase');
  });

  test('does not lowercase active-pill tab labels by default', () => {
    const source = readFileSync(resolve(testDirectory, 'sortable-tabs-strip.tsx'), 'utf8');

    expect(source).toContain('activePillLowercase = false');
    expect(source).not.toContain('activePillLowercase = true');
  });
});
