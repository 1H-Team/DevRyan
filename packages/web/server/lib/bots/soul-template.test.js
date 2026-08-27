import { describe, expect, it } from 'vitest';

import { buildStarterSoul, SOUL_SECTION_HEADINGS } from './soul-template.js';
import { validateBotRevisionRuntimeContract } from './config-compiler.js';

const baseContract = (overrides = {}) => ({
  identity: { title: 'Research Desk', avatar: 'R' },
  objectives: ['Review requests'],
  operatingInstructions: 'Follow policy',
  prohibitedInstructions: 'Never bypass approval',
  advancedPrompt: '',
  standingRole: 'You are a research Bot.',
  models: {
    primary: {
      providerId: 'openai',
      modelId: 'gpt-5.6-sol',
      credentialId: 'f0000000-0000-4000-8000-000000000001',
      egressHosts: ['api.openai.com:443'],
    },
    fallbacks: [],
  },
  reasoning: {},
  fileTools: ['read'],
  gatewayPluginVersion: 'devryan-bot-tools@1.1.0',
  libraryVersionIds: [],
  memoryPolicy: {},
  ...overrides,
});

describe('Bot soul', () => {
  it('writes every section from whatever profile the Bot already has', () => {
    const soul = buildStarterSoul({
      name: 'Research Desk',
      title: 'a research assistant',
      summary: 'Answers deployment questions.',
    });
    for (const heading of SOUL_SECTION_HEADINGS) expect(soul).toContain(`## ${heading}`);
    expect(soul).toContain('Research Desk — a research assistant.');
    expect(soul).toContain('Answers deployment questions.');
  });

  it('carries an existing tone into the voice section', () => {
    expect(buildStarterSoul({ name: 'Desk', tone: 'Terse.' })).toContain('Terse.');
  });

  it('leads the compiled prompt so identity anchors everything after it', () => {
    const contract = validateBotRevisionRuntimeContract(baseContract({
      soul: '# Soul\n\nI am the Research Desk.',
    }));
    expect(contract.soul).toBe('# Soul\n\nI am the Research Desk.');
  });

  it('omits the key entirely when unset so pre-soul revisions keep their hash', () => {
    const withoutSoul = validateBotRevisionRuntimeContract(baseContract());
    expect(Object.hasOwn(withoutSoul, 'soul')).toBe(false);
  });

  it('collapses any submitted tenancy onto the one shared computer', () => {
    expect(validateBotRevisionRuntimeContract(baseContract({ tenancy: 'personalized' })).tenancy)
      .toBe('team');
    expect(validateBotRevisionRuntimeContract(baseContract()).tenancy).toBe('team');
  });

  it('refuses a tenancy value that was never valid', () => {
    expect(() => validateBotRevisionRuntimeContract(baseContract({ tenancy: 'solo' })))
      .toThrow('Bot revision tenancy is invalid');
  });
});
