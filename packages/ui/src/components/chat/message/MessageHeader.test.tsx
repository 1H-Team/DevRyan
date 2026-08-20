import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'bun:test';

const testDir = dirname(fileURLToPath(import.meta.url));
const source = () => readFileSync(resolve(testDir, 'MessageHeader.tsx'), 'utf8');

describe('MessageHeader', () => {
    test('keeps assistant agent icon colored while rendering the agent name with theme foreground text', () => {
        const code = source();

        expect(code).toContain('<RiAiAgentLine');
        expect(code).toContain('style={{ color: `var(${getAgentIconColor(agentName).var})` }}');
        expect(code).toContain('style={{ color: `var(${getAgentColor(agentName).var})` }}');
        expect(code).toContain('className="min-w-0 max-w-[180px] truncate text-foreground"');
        expect(code).not.toContain(
            'className="flex min-w-0 items-center gap-1.5 typography-ui-header font-bold tracking-tight leading-none"\n                                        style={{ color: `var(${getAgentColor(agentName).var})` }}',
        );
        expect(code).toContain('className="agent-badge-combined max-w-[300px]"');
    });

    test('passes a warning-colored fast icon as separate badge metadata', () => {
        const code = source();

        expect(code).toContain('fastEnabled?: boolean');
        expect(code).toContain('RiFlashlightFill');
        expect(code).toContain('trailingIcon={fastIcon}');
        expect(code).toContain('text-[var(--status-warning)]');
    });

    test('preserves the Claude logo brand color in every theme', () => {
        const code = source();

        expect(code).toContain('shouldPreserveProviderLogoColor(displayProviderID)');
        expect(code).toContain("if (preservesBrandColor) {\n        logoFilter = 'none';");
    });
});
