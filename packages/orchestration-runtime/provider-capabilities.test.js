import { describe, expect, test } from 'bun:test';

import {
  MANAGED_READ_ONLY_AGENT_UNSUPPORTED,
  MANAGED_READ_ONLY_PROVIDER_UNSUPPORTED,
  supportsManagedReadOnlyAgent,
  supportsManagedReadOnlyProvider,
} from './provider-capabilities.js';

describe('managed provider capabilities', () => {
  test('marks Cursor as incompatible with managed read-only execution', () => {
    expect(supportsManagedReadOnlyProvider('cursor-acp')).toBe(false);
    expect(supportsManagedReadOnlyProvider('  CURSOR-ACP  ')).toBe(false);
  });

  test('accepts Cursor only with an explicit enforced host capability', () => {
    expect(supportsManagedReadOnlyProvider('cursor-acp', { cursorReadOnly: true })).toBe(true);
    expect(supportsManagedReadOnlyProvider('  CURSOR-ACP  ', { cursorReadOnly: true })).toBe(true);
    expect(supportsManagedReadOnlyProvider('cursor-acp', { cursorReadOnly: false })).toBe(false);
    expect(supportsManagedReadOnlyProvider('cursor-acp', { cursorReadOnly: 'true' })).toBe(false);
    expect(supportsManagedReadOnlyProvider(null, { cursorReadOnly: true })).toBe(false);
    expect(supportsManagedReadOnlyProvider('openai', { cursorReadOnly: false })).toBe(true);
  });

  test('accepts configured non-Cursor providers and rejects missing identities', () => {
    expect(supportsManagedReadOnlyProvider('openai')).toBe(true);
    expect(supportsManagedReadOnlyProvider('github-copilot')).toBe(true);
    expect(supportsManagedReadOnlyProvider('')).toBe(false);
    expect(supportsManagedReadOnlyProvider(null)).toBe(false);
  });

  test('exports the stable pre-admission error code', () => {
    expect(MANAGED_READ_ONLY_PROVIDER_UNSUPPORTED).toBe('MANAGED_READ_ONLY_PROVIDER_UNSUPPORTED');
  });

  test('keeps Designer out of managed read-only execution', () => {
    expect(supportsManagedReadOnlyAgent('designer')).toBe(false);
    expect(supportsManagedReadOnlyAgent('  Designer  ')).toBe(false);
    expect(supportsManagedReadOnlyAgent('explorer')).toBe(true);
    expect(supportsManagedReadOnlyAgent('oracle')).toBe(true);
    expect(supportsManagedReadOnlyAgent('')).toBe(false);
    expect(supportsManagedReadOnlyAgent(null)).toBe(false);
  });

  test('exports the stable read-only agent error code', () => {
    expect(MANAGED_READ_ONLY_AGENT_UNSUPPORTED).toBe('MANAGED_READ_ONLY_AGENT_UNSUPPORTED');
  });
});
