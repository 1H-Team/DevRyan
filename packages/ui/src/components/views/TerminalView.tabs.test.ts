import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const terminalView = readFileSync(new URL('./TerminalView.tsx', import.meta.url), 'utf8');

describe('terminal tabs', () => {
    test('matches the context-panel soft-pill tab design', () => {
        expect(terminalView).toContain('variant="soft-pill"');
        expect(terminalView).not.toContain('variant="default"');
        expect(terminalView).toContain('className="h-3.5 w-3.5"');
    });

    test('adds a fixed, non-closable Processes tab that swaps the viewport for the panel', () => {
        expect(terminalView).toContain('PROCESSES_TAB_ID');
        expect(terminalView).toContain('closable: false');
        expect(terminalView).toContain('<ProcessesPanel');
        expect(terminalView).toContain('isProcessesTabActive ? PROCESSES_TAB_ID : activeTabId');
    });
});
