import { describe, expect, test } from 'bun:test';
import { buildWindowTitle, resolveWindowProjectLabel } from './useWindowTitle';

describe('window project title', () => {
  for (const name of ['.ssh', 'my_API-v2', 'iOSClient', 'foo__bar']) {
    test(`preserves ${name}`, () => {
      const label = resolveWindowProjectLabel({ path: `/work/${name}` });
      expect(label).toBe(name);
      expect(buildWindowTitle(label, null)).toBe(`${name} | DevRyan`);
    });
  }
});
