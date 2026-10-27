import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { settingsDict } from '@/lib/i18n/messages/en.settings';

const source = readFileSync(
  fileURLToPath(new URL('./AgentBrowserControlSettings.tsx', import.meta.url)),
  'utf8',
);
const dict: Record<string, string> = settingsDict;

// Static key audit. Behaviour lives in AgentBrowserControlSettings.mounted.test.tsx.
describe('AgentBrowserControlSettings', () => {
  test('has en strings for every referenced i18n key', () => {
    const keys = [...source.matchAll(/t\('([^']+)'\)/g)].map((match) => match[1]);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of new Set(keys)) {
      expect(dict[key as string]).toBeTruthy();
    }
  });
});
