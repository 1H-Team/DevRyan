import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'bun:test';

const source = readFileSync(
  fileURLToPath(new URL('./ProgressiveGroup.tsx', import.meta.url)),
  'utf8',
);

describe('ProgressiveGroup mobile reasoning', () => {
  test('forwards mobile state to inline grouped reasoning', () => {
    expect(source).toContain('responseStyleLevel, isMobile')
    expect(source).toContain('isMobile: boolean;')
    expect(source).toContain('            isMobile={isMobile}')
    expect(source).toContain('                            isMobile={isMobile}')
  })
})
