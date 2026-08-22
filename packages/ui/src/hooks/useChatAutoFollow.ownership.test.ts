import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'bun:test';

const source = readFileSync(fileURLToPath(new URL('./useChatAutoFollow.ts', import.meta.url)), 'utf8');

describe('chat automatic-follow ownership', () => {
    test('uses transcript resize as the only DOM-driven automatic-follow signal', () => {
        expect(source.match(/new ResizeObserver/g)).toHaveLength(1);
        expect(source).toContain('observer.observe(inner)');
        expect(source).not.toContain('characterData: true');
        expect(source).not.toContain('attributes: true');
    });

    test('keeps explicit content notifications as a ResizeObserver fallback only', () => {
        expect(source).toContain('if (!resizeObserverAvailableRef.current)');
        expect(source).toContain('followPinnedLatestContent();');
    });
});
