import React from 'react';
import { cn } from '@/lib/utils';
import type { Part } from '@opencode-ai/sdk/v2';
import type { AgentMentionInfo } from '../types';
import { ExactUserPromptText } from './ExactUserPromptText';
import { useUIStore } from '@/stores/useUIStore';
import { useI18n } from '@/lib/i18n';
import { RiArrowUpSLine } from '@remixicon/react';

type PartWithText = Part & { text?: string; content?: string; value?: string };

type UserTextPartProps = {
    part: Part;
    messageId: string;
    isMobile: boolean;
    agentMention?: AgentMentionInfo;
};

const UserTextPart: React.FC<UserTextPartProps> = ({ part, messageId, agentMention }) => {
    const partWithText = part as PartWithText;
    const rawText = partWithText.text;
    const textContent = typeof rawText === 'string' ? rawText : partWithText.content || partWithText.value || '';

    const [isExpanded, setIsExpanded] = React.useState(false);
    const [isTruncated, setIsTruncated] = React.useState(false);
    const collapsibleUserMessages = useUIStore((state) => state.collapsibleUserMessages);
    const { t } = useI18n();
    const textRef = React.useRef<HTMLDivElement>(null);

    const hasActiveSelectionInElement = React.useCallback((element: HTMLElement): boolean => {
        if (typeof window === 'undefined') {
            return false;
        }

        const selection = window.getSelection();
        if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
            return false;
        }

        const range = selection.getRangeAt(0);
        return element.contains(range.startContainer) || element.contains(range.endContainer);
    }, []);

    React.useEffect(() => {
        const el = textRef.current;
        if (!el) return;

        const checkTruncation = () => {
            if (collapsibleUserMessages && !isExpanded) {
                setIsTruncated(el.scrollHeight > el.clientHeight);
            }
        };

        checkTruncation();

        const resizeObserver = new ResizeObserver(checkTruncation);
        resizeObserver.observe(el);

        return () => resizeObserver.disconnect();
    }, [collapsibleUserMessages, textContent, isExpanded]);

    React.useEffect(() => {
        if (!collapsibleUserMessages) {
            setIsExpanded(false);
            setIsTruncated(false);
        }
    }, [collapsibleUserMessages]);

    const handleClick = React.useCallback(() => {
        const element = textRef.current;
        if (!element) {
            return;
        }

        if (hasActiveSelectionInElement(element)) {
            return;
        }

        if (collapsibleUserMessages && !isExpanded && isTruncated) {
            setIsExpanded(true);
        }
    }, [collapsibleUserMessages, hasActiveSelectionInElement, isExpanded, isTruncated]);

    const handleCollapse = React.useCallback((event: React.MouseEvent) => {
        event.stopPropagation();
        setIsExpanded(false);
    }, []);

    if (!textContent || textContent.trim().length === 0) {
        return null;
    }

    return (
        <div className="relative" key={part.id || `${messageId}-user-text`}>
            {collapsibleUserMessages && isExpanded && (
                <button
                    type="button"
                    onClick={handleCollapse}
                    className="absolute bottom-1 right-1 z-10 flex items-center justify-center rounded-sm bg-[var(--surface-elevated)] p-0.5 text-[var(--surface-mutedForeground)] hover:text-[var(--surface-foreground)] hover:bg-[var(--interactive-hover)] transition-colors"
                    aria-label={t('chat.message.userText.collapseAria')}
                >
                    <RiArrowUpSLine className="h-3.5 w-3.5" />
                </button>
            )}
            <div
                className={cn(
                    "break-words font-sans typography-markdown",
                    isExpanded && "pb-4 [&_p:last-child]:mb-0 [&>*:last-child]:mb-0",
                    'whitespace-pre-wrap',
                    collapsibleUserMessages && !isExpanded && "line-clamp-2",
                    collapsibleUserMessages && isTruncated && !isExpanded && "cursor-pointer"
                )}
                ref={textRef}
                onClick={handleClick}
            >
                <ExactUserPromptText text={textContent} agentMention={agentMention} />
            </div>
        </div>
    );
};

export default React.memo(UserTextPart);
