import React from 'react';

import { cn } from '@/lib/utils';
import type { DiffLayoutPreference, DiffViewMode, MermaidRenderingMode, UserMessageRenderingMode } from './appearanceOptions';
import { parsePreviewMarkdown } from './previewModel';

// Decorative option drawings. Colors come from theme variables so they follow the active theme.

const Frame: React.FC<{ className?: string; children: React.ReactNode }> = ({ className, children }) => (
    <span className={cn('flex h-14 w-full gap-1.5 rounded-md border border-[var(--interactive-border)] bg-[var(--surface-background)] p-1.5', className)}>
        {children}
    </span>
);

const Line: React.FC<{ width: string }> = ({ width }) => (
    <span className="h-1 shrink-0 rounded-full bg-[var(--surface-muted-foreground)] opacity-40" style={{ width }} />
);

const ChangedRow: React.FC<{ kind: 'added' | 'removed'; width: string }> = ({ kind, width }) => (
    <span
        className={cn(
            'flex h-2 shrink-0 items-center rounded-sm px-0.5',
            kind === 'added' ? 'bg-[var(--status-success-background)]' : 'bg-[var(--status-error-background)]',
        )}
    >
        <span
            className={cn('h-0.5 rounded-full', kind === 'added' ? 'bg-[var(--status-success)]' : 'bg-[var(--status-error)]')}
            style={{ width }}
        />
    </span>
);

const Column: React.FC<{ className?: string; children: React.ReactNode }> = ({ className, children }) => (
    <span className={cn('flex min-w-0 flex-1 flex-col justify-center gap-1', className)}>{children}</span>
);

const Divider: React.FC = () => <span className="w-px shrink-0 self-stretch bg-[var(--interactive-border)]" />;

const DIFF_LAYOUT_ILLUSTRATIONS: Record<DiffLayoutPreference, React.ReactNode> = {
    dynamic: (
        <Frame>
            <Column className="max-w-[35%]">
                <ChangedRow kind="added" width="80%" />
                <ChangedRow kind="added" width="60%" />
                <ChangedRow kind="added" width="70%" />
            </Column>
            <Divider />
            <Column>
                <Line width="70%" />
                <ChangedRow kind="removed" width="60%" />
                <Line width="50%" />
            </Column>
            <Column>
                <Line width="70%" />
                <ChangedRow kind="added" width="75%" />
                <Line width="50%" />
            </Column>
        </Frame>
    ),
    inline: (
        <Frame>
            <Column>
                <Line width="55%" />
                <ChangedRow kind="removed" width="60%" />
                <ChangedRow kind="added" width="70%" />
                <Line width="40%" />
            </Column>
        </Frame>
    ),
    'side-by-side': (
        <Frame>
            <Column>
                <Line width="70%" />
                <ChangedRow kind="removed" width="60%" />
                <Line width="50%" />
            </Column>
            <Divider />
            <Column>
                <Line width="70%" />
                <ChangedRow kind="added" width="75%" />
                <Line width="50%" />
            </Column>
        </Frame>
    ),
};

const FileHeader: React.FC<{ active?: boolean }> = ({ active = false }) => (
    <span className="flex h-2 shrink-0 items-center gap-1 rounded-sm bg-[var(--surface-muted)] px-0.5">
        <span className={cn('h-1 w-1 rounded-full', active ? 'bg-[var(--primary-base)]' : 'bg-[var(--surface-muted-foreground)] opacity-60')} />
        <span className="h-0.5 w-1/3 rounded-full bg-[var(--surface-muted-foreground)] opacity-60" />
    </span>
);

const DIFF_VIEW_MODE_ILLUSTRATIONS: Record<DiffViewMode, React.ReactNode> = {
    single: (
        <Frame>
            <Column className="max-w-[30%] justify-start">
                <span className="h-1.5 shrink-0 rounded-sm bg-[var(--primary-base)] opacity-70" />
                <Line width="80%" />
                <Line width="65%" />
                <Line width="75%" />
            </Column>
            <Divider />
            <Column className="justify-start">
                <FileHeader active />
                <Line width="60%" />
                <ChangedRow kind="removed" width="55%" />
                <ChangedRow kind="added" width="70%" />
            </Column>
        </Frame>
    ),
    stacked: (
        <Frame>
            <Column className="justify-start">
                <FileHeader />
                <ChangedRow kind="added" width="60%" />
                <FileHeader />
                <ChangedRow kind="removed" width="50%" />
                <FileHeader />
            </Column>
        </Frame>
    ),
};

const DiagramNode: React.FC = () => (
    <span className="h-5 w-7 shrink-0 rounded-md border border-[var(--primary-base)] bg-[var(--interactive-selection)]" />
);

const DiagramEdge: React.FC = () => (
    <span className="flex min-w-2 flex-1 items-center">
        <span className="h-px flex-1 bg-[var(--surface-foreground)] opacity-50" />
        <span className="h-0 w-0 border-y-[3px] border-l-[4px] border-y-transparent border-l-[var(--surface-foreground)] opacity-50" />
    </span>
);

const MERMAID_ILLUSTRATIONS: Record<MermaidRenderingMode, React.ReactNode> = {
    svg: (
        <Frame className="items-center px-3">
            <DiagramNode />
            <DiagramEdge />
            <DiagramNode />
            <DiagramEdge />
            <DiagramNode />
        </Frame>
    ),
    ascii: (
        <Frame className="items-center justify-center">
            <span className="whitespace-pre font-mono text-[10px] leading-[1.15] text-[var(--surface-foreground)] opacity-80">
                {'┌───┐   ┌───┐\n│ A ├──▶│ B │\n└───┘   └───┘'}
            </span>
        </Frame>
    ),
};

export const DiffLayoutIllustration: React.FC<{ layout: DiffLayoutPreference }> = ({ layout }) => <>{DIFF_LAYOUT_ILLUSTRATIONS[layout]}</>;

export const DiffViewModeIllustration: React.FC<{ mode: DiffViewMode }> = ({ mode }) => <>{DIFF_VIEW_MODE_ILLUSTRATIONS[mode]}</>;

export const MermaidIllustration: React.FC<{ mode: MermaidRenderingMode }> = ({ mode }) => <>{MERMAID_ILLUSTRATIONS[mode]}</>;

/** Renders sample text with `**strong**` and `` `code` `` runs formatted. */
export const PreviewInlineText: React.FC<{ source: string }> = ({ source }) => (
    <>
        {parsePreviewMarkdown(source).map((segment, index) => {
            if (segment.kind === 'strong') return <strong key={index} className="font-semibold">{segment.text}</strong>;
            if (segment.kind === 'code') {
                return (
                    <code key={index} className="rounded bg-[var(--surface-muted)] px-1 font-mono text-[0.9em]">
                        {segment.text}
                    </code>
                );
            }
            return <React.Fragment key={index}>{segment.text}</React.Fragment>;
        })}
    </>
);

export const UserMessageIllustration: React.FC<{ mode: UserMessageRenderingMode; sample: string }> = ({ mode, sample }) => (
    <Frame className="items-center justify-end">
        <span
            className={cn(
                'max-w-full truncate rounded-lg rounded-br-sm px-2 py-1 typography-micro text-foreground',
                mode === 'plain' && 'whitespace-pre',
            )}
            style={{ backgroundColor: 'var(--chat-user-message-bg)' }}
        >
            {mode === 'markdown' ? <PreviewInlineText source={sample} /> : sample}
        </span>
    </Frame>
);
