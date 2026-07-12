import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'bun:test';

const testDir = dirname(fileURLToPath(import.meta.url));
const source = () => readFileSync(resolve(testDir, 'TaskToolSummary.tsx'), 'utf8');
const toolPartSource = () => readFileSync(resolve(testDir, 'ToolPart.tsx'), 'utf8');

describe('TaskToolSummary output layout', () => {
    test('places output below the lined task activity block', () => {
        const code = source();

        expect(code).toContain('const hasActivityContent');
        expect(code.indexOf('{hasActivityContent ? (')).toBeLessThan(code.indexOf('{hasOutput ? ('));
        expect(code).toContain("hasActivityContent && 'pt-1'");
    });

    test('uses click expansion instead of a hover popover for output details', () => {
        const code = source();
        const outputButtonClass = code.match(/className="([^"]*inline-flex items-center gap-1\.5[^"]*)"/)?.[1] ?? '';

        expect(code).not.toContain("@base-ui/react/popover");
        expect(outputButtonClass).not.toContain('hover:');
        expect(outputButtonClass).not.toContain('w-full');
        expect(outputButtonClass).not.toContain('ml-');
        expect(code).toContain('setIsOutputExpanded((prev) => !prev)');
    });

    test('formats specialist output after stripping task metadata', () => {
        const code = source();

        expect(code).toContain('formatSpecialistTaskOutputForMarkdown');
        expect(code.indexOf('const trimmedOutput')).toBeLessThan(code.indexOf('const displayOutput'));
        expect(code).toContain('formatSpecialistTaskOutputForMarkdown(trimmedOutput)');
        expect(code).toContain('<SimpleMarkdownRenderer content={displayOutput}');
    });

    test('shows the authoritative task model as quiet metadata', () => {
        const code = source();

        expect(code).toContain('formatTaskModelLabel');
        expect(code).toContain('const taskModelLabel = formatTaskModelLabel(input?.model)');
        expect(code).toContain('typography-micro text-muted-foreground/60');
        expect(code).not.toContain('typography-micro font-mono');
        expect(code).toContain('{taskModelLabel}');
    });

    test('marks failed output partial and keeps the failure reason visible', () => {
        const code = source();

        expect(code).toContain('resolveTaskResultPresentation');
        expect(code).toContain("taskResult.outputKind === 'partial'");
        expect(code).toContain("t('chat.toolPart.partialOutput')");
        expect(code).toContain('RiErrorWarningLine');
        expect(toolPartSource()).toContain('status={stateWithData.status}');
        expect(code.match(/\{errorText \? \(/g)?.length ?? 0).toBeGreaterThan(0);
    });
});
