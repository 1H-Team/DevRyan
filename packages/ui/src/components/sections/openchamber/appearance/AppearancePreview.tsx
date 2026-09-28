import React from 'react';
import { RiArrowDownSLine } from '@remixicon/react';

import { Button } from '@/components/ui/button';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import { formatThemeLabel } from './appearanceOptions';
import { PreviewInlineText } from './optionIllustrations';
import { getChatWidthRatio } from './previewModel';

// Static sample; theme, fonts, text size and density reach it through the app's CSS variables.
const CODE_SAMPLE: ReadonlyArray<ReadonlyArray<{ text: string; token?: 'keyword' | 'function' | 'comment' | 'string' }>> = [
    [{ text: 'export ', token: 'keyword' }, { text: 'function ', token: 'keyword' }, { text: 'useAuth', token: 'function' }, { text: '() {' }],
    [{ text: '  return ', token: 'keyword' }, { text: 'session.user; ' }, { text: '// cached', token: 'comment' }],
    [{ text: '}' }],
];

const TOKEN_COLORS = {
    keyword: 'var(--syntax-keyword)',
    function: 'var(--syntax-function)',
    comment: 'var(--syntax-comment)',
    string: 'var(--syntax-string)',
} as const;

const ChatWidthMinimap: React.FC = () => {
    const { t } = useI18n();
    const chatWidth = useUIStore((state) => state.chatWidth);
    const ratio = getChatWidthRatio(chatWidth);

    return (
        <div className="space-y-1">
            <div className="flex items-center justify-between gap-2 typography-micro text-muted-foreground">
                <span className="truncate">{t('settings.openchamber.visual.field.chatWidth')}</span>
                <span className="shrink-0 [font-variant-numeric:tabular-nums]">{chatWidth}px</span>
            </div>
            <div className="flex h-4 items-center justify-center rounded-sm border border-[var(--interactive-border)] bg-[var(--surface-elevated)]">
                <div
                    className="h-2 rounded-[2px] bg-[var(--primary-base)] opacity-60 motion-safe:transition-[width] motion-safe:duration-200"
                    style={{ width: `${Math.round(ratio * 100)}%` }}
                />
            </div>
        </div>
    );
};

const PreviewUserMessage: React.FC = () => {
    const { t } = useI18n();
    const mode = useUIStore((state) => state.userMessageRenderingMode);
    const source = t('settings.openchamber.visual.preview.userMessage');

    return (
        <div className="flex justify-end">
            <div
                className="max-w-[85%] border border-primary/5 px-3 py-2 typography-markdown text-foreground"
                style={{
                    backgroundColor: 'var(--chat-user-message-bg)',
                    borderRadius: 'var(--radius-xl)',
                    borderBottomRightRadius: 'var(--radius-sm)',
                }}
            >
                {mode === 'markdown' ? <PreviewInlineText source={source} /> : <span className="whitespace-pre-wrap">{source}</span>}
            </div>
        </div>
    );
};

const PreviewAssistantReply: React.FC = () => {
    const { t } = useI18n();

    return (
        <div className="space-y-2">
            <p className="typography-markdown text-foreground">{t('settings.openchamber.visual.preview.assistantMessage')}</p>
            <div
                className="overflow-hidden whitespace-pre rounded-md border border-[var(--interactive-border)] px-2.5 py-2 font-mono typography-code leading-relaxed"
                style={{ backgroundColor: 'var(--syntax-background)', color: 'var(--syntax-foreground)' }}
            >
                {CODE_SAMPLE.map((line, lineIndex) => (
                    <div key={lineIndex} className="truncate">
                        {line.map((part, partIndex) => (
                            <span key={partIndex} style={part.token ? { color: TOKEN_COLORS[part.token] } : undefined}>{part.text}</span>
                        ))}
                    </div>
                ))}
            </div>
            <div className="overflow-hidden rounded-md border border-[var(--interactive-border)] font-mono typography-code">
                <div className="flex items-center justify-between gap-2 bg-[var(--surface-muted)] px-2.5 py-1 text-muted-foreground">
                    <span className="truncate">src/auth.ts</span>
                    <span className="shrink-0">
                        <span className="text-[var(--status-success)]">+1</span>{' '}
                        <span className="text-[var(--status-error)]">−1</span>
                    </span>
                </div>
                <div className="truncate bg-[var(--status-error-background)] px-2.5 py-0.5 text-foreground">- const user = await load();</div>
                <div className="truncate bg-[var(--status-success-background)] px-2.5 py-0.5 text-foreground">+ const user = session.user;</div>
            </div>
        </div>
    );
};

interface AppearancePreviewProps {
    showChatWidth: boolean;
    className?: string;
}

/**
 * Compact mock conversation that reflects the live Appearance settings. It sits
 * beside the settings on wide layouts and collapses behind a toggle otherwise.
 */
export const AppearancePreview = React.memo(function AppearancePreview({ showChatWidth, className }: AppearancePreviewProps) {
    const { t } = useI18n();
    const { currentTheme } = useThemeSystem();
    const [expanded, setExpanded] = React.useState(false);
    const contentId = React.useId();
    const captionId = React.useId();
    const variant = currentTheme.metadata.variant;

    return (
        <aside
            aria-label={t('settings.openchamber.visual.preview.regionAria')}
            aria-describedby={captionId}
            className={cn('min-w-0', className)}
            data-appearance-preview
        >
            <Button
                type="button"
                size="sm"
                variant="outline"
                aria-expanded={expanded}
                aria-controls={contentId}
                onClick={() => setExpanded((value) => !value)}
                className="w-full justify-between @4xl:hidden"
            >
                {expanded ? t('settings.openchamber.visual.actions.hidePreview') : t('settings.openchamber.visual.actions.showPreview')}
                <RiArrowDownSLine className={cn('h-4 w-4 transition-transform', expanded && 'rotate-180')} aria-hidden="true" />
            </Button>
            <div
                id={contentId}
                className={cn(
                    'mt-2 overflow-hidden rounded-lg border border-[var(--interactive-border)] bg-[var(--surface-elevated)] @4xl:mt-0 @4xl:block',
                    !expanded && 'hidden',
                )}
            >
                <div className="flex items-center justify-between gap-2 border-b border-[var(--interactive-border)] px-3 py-2">
                    <span className="typography-ui-label font-medium text-foreground">{t('settings.openchamber.visual.preview.title')}</span>
                    <span className="min-w-0 truncate typography-micro text-muted-foreground">
                        {formatThemeLabel(currentTheme.metadata.name, variant)} · {t(variant === 'dark'
                            ? 'settings.openchamber.visual.option.themeMode.dark'
                            : 'settings.openchamber.visual.option.themeMode.light')}
                    </span>
                </div>
                <div className="space-y-3 bg-[var(--surface-background)] p-3" aria-hidden="true">
                    {showChatWidth ? <ChatWidthMinimap /> : null}
                    <PreviewUserMessage />
                    <PreviewAssistantReply />
                </div>
                <p id={captionId} className="border-t border-[var(--interactive-border)] px-3 py-2 typography-micro text-muted-foreground">
                    {t('settings.openchamber.visual.preview.caption')}
                </p>
            </div>
        </aside>
    );
});
