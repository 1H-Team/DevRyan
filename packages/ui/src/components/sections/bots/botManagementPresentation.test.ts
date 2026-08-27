import { describe, expect, test } from 'bun:test';

import {
  applyAutonomousBotDefaults,
  createDefaultBotRevisionContract,
  usesAutonomousBotDefaults,
} from './botManagementPresentation';

describe('Bot autonomous management defaults', () => {
  test('gives every newly created Bot the complete scoped autonomous tool set', () => {
    const contract = createDefaultBotRevisionContract('Research Desk');

    expect(contract.fileTools).toEqual(['read', 'glob', 'grep', 'edit', 'write']);
    expect(contract.runtimeTools).toEqual(['bash', 'terminal', 'git', 'task']);
    expect(contract.actionPolicy.defaultEffect).toBe('allow');
    expect(contract.actionPolicy.defaultRisk).toBe('low');
    expect(contract.browserPolicy).toEqual({ allowedOrigins: [], deniedOrigins: [] });
    expect(contract.operatingInstructions).toBe('');
    expect(contract.prohibitedInstructions).toBe('');
    expect(contract.advancedPrompt).toBe('');
    expect(contract.mcpBindings).toEqual([]);
    expect(usesAutonomousBotDefaults(contract)).toBe(true);
  });

  test('migrates runtime policy without replacing identity, models, memory, Library, skills, or MCP bindings', () => {
    const current = {
      ...createDefaultBotRevisionContract('Release Steward'),
      fileTools: ['read'] as const,
      runtimeTools: undefined,
      actionPolicy: { defaultEffect: 'prompt' as const, defaultRisk: 'sensitive' as const, rules: [] },
      libraryVersionIds: ['f0000000-0000-4000-8000-000000000001'],
      skillBindings: [{ id: 'f0000000-0000-4000-8000-000000000002', digest: 'a'.repeat(64) }],
      mcpBindings: [{
        id: 'f0000000-0000-4000-8000-000000000003',
        descriptorDigest: 'b'.repeat(64),
        manifestDigest: 'c'.repeat(64),
      }],
    };
    const migrated = applyAutonomousBotDefaults(current);

    expect(usesAutonomousBotDefaults(migrated)).toBe(true);
    expect(migrated.identity).toBe(current.identity);
    expect(migrated.models).toBe(current.models);
    expect(migrated.memoryPolicy).toBe(current.memoryPolicy);
    expect(migrated.libraryVersionIds).toBe(current.libraryVersionIds);
    expect(migrated.skillBindings).toBe(current.skillBindings);
    expect(migrated.mcpBindings).toBe(current.mcpBindings);
  });
});
