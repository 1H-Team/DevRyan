import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, mock, test } from 'bun:test';
import { getAgentColor, getAgentIconColor } from '@/lib/agentColors';

mock.module('@/hooks/useProviderLogo', () => ({
    useProviderLogo: (providerID: string | null) => (
        providerID
            ? { src: `/logos/${providerID}.svg`, onError: () => undefined, hasLogo: true }
            : { src: null, onError: () => undefined, hasLogo: false }
    ),
}));

const { default: MessageHeader } = await import('./MessageHeader');

const render = (props: Partial<React.ComponentProps<typeof MessageHeader>> = {}) => renderToStaticMarkup(
    <MessageHeader
        isUser={false}
        providerID={null}
        agentName="orchestrator"
        modelName="GPT Fixture"
        isDarkTheme={false}
        {...props}
    />,
);

describe('MessageHeader', () => {
    test('keeps assistant agent icon colored while rendering the agent name with theme foreground text', () => {
        const html = render();
        const iconColor = getAgentIconColor('orchestrator').var;
        const modelIconColor = getAgentColor('orchestrator').var;

        expect(html).toContain(`color:var(${iconColor})`);
        // The agent name is plain foreground text, never colored inline.
        expect(html).toMatch(/<span class="[^"]*text-foreground[^"]*">Orchestrator<\/span>/);
        expect(html).not.toMatch(/<div class="[^"]*typography-ui-header[^"]*" style=/);
        expect(html).toContain('agent-badge-combined');
        expect(html).toContain('GPT Fixture');
        // Fallback model glyph (no provider logo) uses the agent color.
        expect(html).toContain(`color:var(${modelIconColor})`);
    });

    test('passes a warning-colored fast icon as separate badge metadata', () => {
        const fast = render({ fastEnabled: true });
        const normal = render();

        expect(fast).toContain('aria-label="Fast Mode"');
        expect(fast).toContain('text-[var(--status-warning)]');
        expect(normal).not.toContain('Fast Mode');
        expect(normal).not.toContain('--status-warning');
    });

    test('preserves the Claude logo brand color in every theme', () => {
        for (const isDarkTheme of [false, true]) {
            const claude = render({ providerID: 'anthropic', isDarkTheme });
            expect(claude).toContain('filter:none');
        }
        expect(render({ providerID: 'unknown-provider', isDarkTheme: true })).toContain('invert(1)');
        expect(render({ providerID: 'unknown-provider', isDarkTheme: false })).toContain('brightness(0.9) contrast(1.1)');
    });
});
