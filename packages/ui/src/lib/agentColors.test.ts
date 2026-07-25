import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'bun:test';
import { getAgentColor, getAgentIconColor } from './agentColors';

const designSystemSource = () => readFileSync(
  fileURLToPath(new URL('../styles/design-system.css', import.meta.url)),
  'utf8',
);
const cssGeneratorSource = () => readFileSync(
  fileURLToPath(new URL('./theme/cssGenerator.ts', import.meta.url)),
  'utf8',
);

const FIXED_ICON_COLORS = {
  builder: { variable: '--agent-icon-builder-color', value: '#9AA1AD' },
  council: { variable: '--agent-icon-council-color', value: '#92400E' },
  designer: { variable: '--agent-icon-designer-color', value: '#9333EA' },
  fixer: { variable: '--agent-icon-fixer-color', value: '#DC2626' },
  explorer: { variable: '--agent-icon-explorer-color', value: '#16A34A' },
  librarian: { variable: '--agent-icon-librarian-color', value: '#2563EB' },
  oracle: { variable: '--agent-icon-oracle-color', value: '#0EA5E9' },
} as const;

describe('agent icon colors', () => {
  test('maps built-in agent glyphs to distinct fixed variables', () => {
    const resolvedVariables = Object.entries(FIXED_ICON_COLORS).map(([agentName, expected]) => {
      expect(getAgentIconColor(agentName).var).toBe(expected.variable);
      expect(getAgentIconColor(`  ${agentName.toUpperCase()}  `).var).toBe(expected.variable);
      return expected.variable;
    });

    expect(new Set(resolvedVariables).size).toBe(resolvedVariables.length);
  });

  test('maps the legacy build name to the Builder icon color', () => {
    expect(getAgentIconColor('build').var).toBe(FIXED_ICON_COLORS.builder.variable);
    expect(getAgentIconColor('  BUILD  ').var).toBe(FIXED_ICON_COLORS.builder.variable);
  });

  test('defines each fixed color once outside generated theme variables', () => {
    const designSystem = designSystemSource();
    const cssGenerator = cssGeneratorSource();

    for (const { variable, value } of Object.values(FIXED_ICON_COLORS)) {
      expect(designSystem).toContain(`${variable}: ${value};`);
      expect(designSystem.match(new RegExp(variable, 'g'))).toHaveLength(1);
      expect(cssGenerator).not.toContain(variable);
    }
  });

  test('preserves the existing palette for non-glyph indicators and fallback agents', () => {
    expect(getAgentColor('fixer').var).toBe('--syntax-type');
    expect(getAgentColor('explorer').var).toBe('--syntax-type');

    for (const agentName of [undefined, 'orchestrator', 'custom-agent']) {
      expect(getAgentIconColor(agentName).var).toBe(getAgentColor(agentName).var);
    }
  });
});
