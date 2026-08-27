import { describe, expect, test } from 'bun:test';

import {
  BOT_SOUL_SECTIONS,
  buildStarterBotSoul,
  missingBotSoulSections,
} from './botSoulTemplate';
import { createDefaultBotRevisionContract, validateBotRevisionConfiguration } from './botManagementPresentation';

describe('Bot soul template', () => {
  test('writes every section and leads with the Bot as a person, not a config', () => {
    const soul = buildStarterBotSoul({
      name: 'Research Desk',
      title: 'a research assistant for the operations team',
      summary: 'Answers questions about deployments and incidents.',
    });

    expect(soul.startsWith('# Soul')).toBe(true);
    for (const section of BOT_SOUL_SECTIONS) expect(soul).toContain(`## ${section}`);
    expect(soul).toContain('Research Desk — a research assistant for the operations team.');
    expect(soul).toContain('Answers questions about deployments and incidents.');
    expect(missingBotSoulSections(soul)).toEqual([]);
  });

  test('folds an existing tone into the voice section rather than dropping it', () => {
    const soul = buildStarterBotSoul({ name: 'Desk', tone: 'Terse and a little dry.' });
    expect(soul).toContain('Terse and a little dry.');
    expect(soul).toContain('## Voice & Tone');
  });

  test('stays usable when the Bot has nothing but a name', () => {
    const soul = buildStarterBotSoul({ name: 'Desk' });
    expect(soul).toContain('I am Desk.');
    expect(missingBotSoulSections(soul)).toEqual([]);
  });

  test('reports the sections an edited soul has dropped', () => {
    expect(missingBotSoulSections('# Soul\n\n## Core Identity\nJust me.'))
      .toEqual(['Personality & Values', 'Voice & Tone', 'How I Respond', 'Boundaries']);
  });

  test('seeds a new Bot with a soul and one shared computer', () => {
    const contract = createDefaultBotRevisionContract('Research Desk');
    expect(contract.soul).toContain('## Core Identity');
    expect(contract.tenancy).toBe('team');
    // Memory has no scopes left to configure.
    expect(Object.keys(contract.memoryPolicy).sort())
      .toEqual(['automaticExtraction', 'retrievalLimit']);
    expect(validateBotRevisionConfiguration(contract).valid).toBe(true);
  });

  test('rejects a soul that has grown into a second instruction dump', () => {
    const contract = createDefaultBotRevisionContract('Desk');
    const result = validateBotRevisionConfiguration({ ...contract, soul: 'x'.repeat(17 * 1024) });
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('Soul is too long');
  });
});
