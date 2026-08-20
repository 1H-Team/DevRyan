import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

describe('composer account-default isolation', () => {
  test('does not persist composer model changes as managed account defaults', () => {
    const source = readFileSync(new URL('./ModelControls.tsx', import.meta.url), 'utf8');

    expect(source).not.toContain('persistAgentModelSelection');
    expect(source).not.toContain('/agent-defaults/');
  });

  test('keeps explicit account persistence in the Sessions settings editor', () => {
    const source = readFileSync(
      new URL('../sections/openchamber/AgentModelDefaultsSettings.tsx', import.meta.url),
      'utf8',
    );

    expect(source).toContain('persistAgentModelSelection');
    expect(source).toContain('resetAgentModelSelection');
  });
});
