import React from 'react';
import type { Part } from '@opencode-ai/sdk/v2';

import UserTextPart from './parts/UserTextPart';
import ToolPart from './parts/ToolPart';
import AssistantTextPart from './parts/AssistantTextPart';
import PlanCard from './parts/PlanCard';
import ReasoningPart from './parts/ReasoningPart';
import { MessageFilesDisplay } from '../FileAttachment';
import { TurnChangedFilesDropdown } from '../TurnChangedFilesDropdown';
import type { ToolPart as ToolPartType } from '@opencode-ai/sdk/v2';
import type { StreamPhase, ToolPopupContent, AgentMentionInfo } from './types';
import type { TurnGroupingContext } from '../lib/turns/types';
import { cn } from '@/lib/utils';
import { collapseExactDuplicateAdjacentTextParts, collapseSupersededTodoWrites, isEmptyTextPart, extractTextContent } from './partUtils';
import { FadeInOnReveal } from './FadeInOnReveal';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { RiCheckLine, RiFileCopyLine, RiChatNewLine, RiArrowGoBackLine, RiGitBranchLine, RiHourglassLine, RiTimeLine, RiVolumeUpLine, RiStopLine, RiErrorWarningLine, RiGlobalLine, RiInformationLine } from '@remixicon/react';
import type { ContentChangeReason } from '@/hooks/useChatAutoFollow';

import { SimpleMarkdownRenderer } from '../MarkdownRenderer';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useUIStore } from '@/stores/useUIStore';
import { flattenAssistantTextParts } from '@/lib/messages/messageText';
import { resolveMessagePlanCard } from '@/lib/messages/actionablePlan';
import { buildPlanCardRenderSegments, shouldSuppressPostPlanText } from '@/lib/messages/planCardRender';
import { isOrphanNarrationFragment } from '@/lib/messages/orphanNarration';
import { useMessageTTS } from '@/hooks/useMessageTTS';
import { useConfigStore } from '@/stores/useConfigStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { TextSelectionMenu } from './TextSelectionMenu';
import { copyTextToClipboard } from '@/lib/clipboard';
import { useChatSurfaceMode } from '@/components/chat/useChatSurfaceMode';
import { isVSCodeRuntime } from '@/lib/desktop';
import { formatTimestampForDisplay } from './timeFormat';
import { ToolRevealOnMount } from './parts/ToolRevealOnMount';
import { GroupedToolActivityRow } from './parts/ProgressiveGroup';
import { StaticToolRow } from './parts/StaticToolRow';
import {
    collectCrossMessageFileActivityGroups,
    collectToolActivityBurst,
    isExpandableTool,
    isHiddenTool,
    isManagedTaskToolName,
    isStandaloneTool,
    normalizeToolName,
    type ToolActivityGroupInfo,
} from './parts/toolRenderUtils';
import { ManagedTaskList } from '../ManagedTaskList';
import { resolveManagedTaskDispatch } from '../managedTaskDispatch';
import {
    managedOrchestrationSelectors,
    useManagedOrchestrationStore,
} from '@/stores/useManagedOrchestrationStore';
import { isCursorProvider, shouldRenderAssistantCopyButton, shouldRenderStandaloneAssistantActionsForTextGroup } from './assistantInlineActions';
import { isToolPartFinalizedForDisplay } from './parts/toolDisplayState';
import TurnActivity from '../components/TurnActivity';
import { resolveProjectForSessionDirectory } from '@/lib/projectResolution';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useSessions } from '@/sync/sync-context';
import { useI18n } from '@/lib/i18n';
import { extractLoopbackUrls } from '@/lib/url';
import {
    filterGroupedActivityReasoning,
    getReasoningPartRenderKey,
    shouldRenderReasoning,
} from './reasoningRenderPolicy';

const CONTAIN_LAYOUT_STYLE = { contain: 'layout' as const, transform: 'translateZ(0)' };
const MESSAGE_FOOTER_CONTAINER_STYLE = { containerType: 'inline-size' as const, containerName: 'message-footer' };
const INLINE_MESSAGE_ACTIONS_CLASS_NAME = 'mt-2 mb-1 flex items-center justify-start gap-1.5';

type SubtaskPartLike = Part & {
    type: 'subtask';
    description?: unknown;
    command?: unknown;
    agent?: unknown;
    prompt?: unknown;
    taskSessionID?: unknown;
    model?: {
        providerID?: unknown;
        modelID?: unknown;
    };
};

type ShellActionPartLike = Part & {
    type: 'text';
    shellAction?: {
        command?: unknown;
        output?: unknown;
        status?: unknown;
    };
};

type MergeableTextPart = Part & {
    id?: string;
    text?: string;
    content?: string;
    value?: string;
    time?: { start?: number; end?: number };
};

const mergeConsecutiveTextParts = (parts: Part[]): Part => {
    if (parts.length <= 1) {
        return parts[0];
    }

    const displayParts = collapseExactDuplicateAdjacentTextParts(parts);
    if (displayParts.length <= 1) {
        return displayParts[0] ?? parts[0];
    }

    const firstPart = displayParts[0] as MergeableTextPart;
    const mergedText = displayParts
        .map((part) => extractTextContent(part).trim())
        .filter((text) => text.length > 0)
        .join('\n');
    const finalizedTextParts = displayParts
        .map((part) => part as MergeableTextPart)
        .filter((part) => typeof part.time?.end !== 'undefined');
    const lastFinalizedPart = finalizedTextParts[finalizedTextParts.length - 1];
    const allPartsFinalized = finalizedTextParts.length === displayParts.length;
    const mergedTime = allPartsFinalized && typeof firstPart.time?.start === 'number'
        ? { start: firstPart.time.start, end: lastFinalizedPart?.time?.end }
        : firstPart.time;

    // Decision: merge only adjacent text parts for rendering so a plan split by the
    // message transport is detected as one plan, while tool/reasoning boundaries stay intact.
    const mergedPart = {
        ...firstPart,
        id: displayParts
            .map((part, index) => (part as MergeableTextPart).id ?? `text-${index}`)
            .join(':merged:'),
        text: mergedText,
        content: undefined,
        value: undefined,
        time: mergedTime,
    };
    return mergedPart as unknown as Part;
};

const isSubtaskPart = (part: Part): part is SubtaskPartLike => {
    return part.type === 'subtask';
};

const isShellActionPart = (part: Part): part is ShellActionPartLike => {
    const textPart = part as unknown as { type?: unknown; shellAction?: unknown };
    return textPart.type === 'text' && typeof textPart.shellAction === 'object' && textPart.shellAction !== null;
};

const normalizeSubtaskModel = (model: SubtaskPartLike['model']): string | null => {
    if (!model || typeof model !== 'object') return null;
    const providerID = typeof model.providerID === 'string' ? model.providerID.trim() : '';
    const modelID = typeof model.modelID === 'string' ? model.modelID.trim() : '';
    if (!providerID || !modelID) return null;
    return `${providerID}/${modelID}`;
};


const UserSubtaskPart: React.FC<{ part: SubtaskPartLike }> = ({ part }) => {
    const [expanded, setExpanded] = React.useState(false);
    const setCurrentSession = useSessionUIStore((state) => state.setCurrentSession);
    const { t } = useI18n();

    const description = typeof part.description === 'string' ? part.description.trim() : '';
    const command = typeof part.command === 'string' ? part.command.trim() : '';
    const agent = typeof part.agent === 'string' ? part.agent.trim() : '';
    const prompt = typeof part.prompt === 'string' ? part.prompt.trim() : '';
    const taskSessionID = typeof part.taskSessionID === 'string' ? part.taskSessionID.trim() : '';
    const model = normalizeSubtaskModel(part.model);

    return (
        <div className="mt-2">
            <div className="flex items-center gap-2 flex-wrap">
                <span className="typography-meta font-semibold text-foreground">{t('chat.messageBody.subtask.title')}</span>
                {command ? (
                    <span className="inline-flex h-5 items-center rounded px-1.5 text-[11px] leading-none bg-foreground/5 text-muted-foreground">
                        /{command}
                    </span>
                ) : null}
                {agent ? (
                    <span className="inline-flex h-5 items-center rounded px-1.5 text-[11px] leading-none bg-foreground/5 text-muted-foreground">
                        @{agent}
                    </span>
                ) : null}
                {model ? (
                    <span className="inline-flex h-5 items-center rounded px-1.5 text-[11px] leading-none bg-foreground/5 text-muted-foreground">
                        {model}
                    </span>
                ) : null}
            </div>

            {description ? (
                <div className="typography-ui-label text-foreground/90 mt-1.5">
                    {description}
                </div>
            ) : null}

            {prompt ? (
                <div className="mt-2 border-t border-border/60 pt-1.5">
                    <button
                        type="button"
                        className="typography-meta text-muted-foreground hover:text-foreground transition-colors underline underline-offset-2"
                        onClick={() => setExpanded((value) => !value)}
                    >
                        {expanded ? t('chat.messageBody.subtask.hidePrompt') : t('chat.messageBody.subtask.showPrompt')}
                    </button>
                    {expanded ? (
                        <pre className="typography-meta mt-1.5 overflow-x-auto whitespace-pre-wrap break-words text-foreground/85">
                            {prompt}
                        </pre>
                    ) : null}
                </div>
            ) : null}

            {taskSessionID ? (
                <div className="mt-1.5">
                    <button
                        type="button"
                        className="typography-meta text-muted-foreground hover:text-foreground transition-colors underline underline-offset-2"
                        onClick={() => {
                            void setCurrentSession(taskSessionID);
                        }}
                    >
                        {t('chat.messageBody.subtask.openSession')}
                    </button>
                </div>
            ) : null}
        </div>
    );
};

const UserShellActionPart: React.FC<{ part: ShellActionPartLike }> = ({ part }) => {
    const [expanded, setExpanded] = React.useState(false);
    const [copiedOutput, setCopiedOutput] = React.useState(false);
    const copiedResetTimeoutRef = React.useRef<number | null>(null);
    const { t } = useI18n();

    const command = typeof part.shellAction?.command === 'string' ? part.shellAction.command.trim() : '';
    const output = typeof part.shellAction?.output === 'string' ? part.shellAction.output : '';
    const status = typeof part.shellAction?.status === 'string' ? part.shellAction.status.trim().toLowerCase() : '';
    const hasOutput = output.trim().length > 0;

    const clearCopiedResetTimeout = React.useCallback(() => {
        if (copiedResetTimeoutRef.current !== null && typeof window !== 'undefined') {
            window.clearTimeout(copiedResetTimeoutRef.current);
            copiedResetTimeoutRef.current = null;
        }
    }, []);

    React.useEffect(() => {
        return () => {
            clearCopiedResetTimeout();
        };
    }, [clearCopiedResetTimeout]);

    const copyOutputToClipboard = React.useCallback(async () => {
        if (!hasOutput) return;

        const result = await copyTextToClipboard(output);
        if (!result.ok) return;

        clearCopiedResetTimeout();
        setCopiedOutput(true);
        if (typeof window !== 'undefined') {
            copiedResetTimeoutRef.current = window.setTimeout(() => {
                setCopiedOutput(false);
                copiedResetTimeoutRef.current = null;
            }, 2000);
        }
    }, [clearCopiedResetTimeout, hasOutput, output]);

    return (
        <div className="mt-2">
            <div className="flex items-center gap-2 flex-wrap">
                <span className="typography-meta font-semibold text-foreground">{t('chat.messageBody.shellCommand.title')}</span>
                {status ? (
                    <span className={cn(
                        'inline-flex h-5 items-center rounded px-1.5 text-[11px] leading-none',
                        status === 'error'
                            ? 'bg-[var(--status-error-background)] text-[var(--status-error)]'
                            : 'bg-foreground/5 text-muted-foreground'
                    )}>
                        {status}
                    </span>
                ) : null}
            </div>

            {command ? (
                <pre className="typography-meta mt-1.5 overflow-x-auto whitespace-pre-wrap break-words text-foreground/90 font-mono">
                    {command}
                </pre>
            ) : null}

            {hasOutput ? (
                <div className="mt-2 border-t border-border/60 pt-1.5">
                    <div className="flex items-center gap-3 flex-wrap">
                        <button
                            type="button"
                            className="typography-meta text-muted-foreground hover:text-foreground transition-colors underline underline-offset-2"
                            onClick={() => setExpanded((value) => !value)}
                        >
                            {expanded ? t('chat.messageBody.shellCommand.hideOutput') : t('chat.messageBody.shellCommand.showOutput')}
                        </button>
                        <button
                            type="button"
                            className="inline-flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
                            onClick={() => {
                                void copyOutputToClipboard();
                            }}
                            aria-label={copiedOutput ? t('chat.messageBody.shellCommand.copied') : t('chat.messageBody.shellCommand.copyOutput')}
                            title={copiedOutput ? t('chat.messageBody.shellCommand.copied') : t('chat.messageBody.shellCommand.copyOutput')}
                        >
                            {copiedOutput ? <RiCheckLine className="h-3.5 w-3.5" /> : <RiFileCopyLine className="h-3.5 w-3.5" />}
                        </button>
                    </div>
                    {expanded ? (
                        <pre className="typography-meta mt-1.5 max-h-56 overflow-auto whitespace-pre-wrap break-words text-foreground/85 font-mono">
                            {output}
                        </pre>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
};

const formatTurnDuration = (durationMs: number): string => {
    const totalSeconds = durationMs / 1000;
    if (totalSeconds < 60) {
        return `${totalSeconds.toFixed(1)}s`;
    }
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = Math.round(totalSeconds % 60);
    return `${minutes}m ${seconds}s`;
};



interface MessageBodyProps {
    sessionId?: string;
    messageId: string;
    parts: Part[];
    isUser: boolean;
    isMessageCompleted: boolean;
    messageFinish?: string;
    messageCompletedAt?: number;
    messageCreatedAt?: number;
    providerID?: string | null;
    modelID?: string | null;

    syntaxTheme: { [key: string]: React.CSSProperties };

    isMobile: boolean;
    alwaysShowActions?: boolean;
    hasTouchInput?: boolean;
    copiedCode: string | null;
    onCopyCode: (code: string) => void;
    expandedTools: Set<string>;
    onToggleTool: (toolId: string) => void;
    onShowPopup: (content: ToolPopupContent) => void;
    streamPhase: StreamPhase;
    allowAnimation: boolean;
    onContentChange?: (reason?: ContentChangeReason, messageId?: string) => void;

    shouldShowHeader?: boolean;
    hasTextContent?: boolean;
    onCopyMessage?: () => void | boolean | Promise<void | boolean>;
    copiedMessage?: boolean;
    onAuxiliaryContentComplete?: () => void;
    showReasoningTraces?: boolean;
    agentMention?: AgentMentionInfo;
    turnGroupingContext?: TurnGroupingContext;
    onRevert?: () => void | Promise<void>;
    isReverting?: boolean;
    onFork?: () => void;
    errorMessage?: string;
    errorVariant?: 'error' | 'info' | 'plain';
    userActionsMode?: 'inline' | 'external-content' | 'external-actions';
    stickyUserHeaderEnabled?: boolean;
    isPlanModeSource?: boolean;
}

const TOOL_REVEAL_CACHE_MAX = 200;
const revealedToolIdsByMessage = new Map<string, Set<string>>();

const readRevealedToolIds = (messageId: string): Set<string> => {
    const cached = revealedToolIdsByMessage.get(messageId);
    return cached ? new Set(cached) : new Set<string>();
};

const writeRevealedToolIds = (messageId: string, value: Set<string>): void => {
    if (revealedToolIdsByMessage.size >= TOOL_REVEAL_CACHE_MAX && !revealedToolIdsByMessage.has(messageId)) {
        const oldest = revealedToolIdsByMessage.keys().next().value;
        if (oldest) {
            revealedToolIdsByMessage.delete(oldest);
        }
    }
    revealedToolIdsByMessage.set(messageId, new Set(value));
};


const UserMessageBody = React.memo(({ messageId, parts, isMobile, alwaysShowActions = isMobile, hasTouchInput, hasTextContent, onCopyMessage, copiedMessage, onShowPopup, agentMention, onRevert, isReverting = false, onFork, userActionsMode = 'inline', stickyUserHeaderEnabled = true }: {
    messageId: string;
    parts: Part[];
    isMobile: boolean;
    alwaysShowActions?: boolean;
    hasTouchInput?: boolean;
    hasTextContent?: boolean;
    onCopyMessage?: () => void;
    copiedMessage?: boolean;
    onShowPopup: (content: ToolPopupContent) => void;
    agentMention?: AgentMentionInfo;
    onRevert?: () => void | Promise<void>;
    isReverting?: boolean;
    onFork?: () => void;
    userActionsMode?: 'inline' | 'external-content' | 'external-actions';
    stickyUserHeaderEnabled?: boolean;
}) => {
    const { t } = useI18n();
    const chatSurfaceMode = useChatSurfaceMode();
    const [copyHintVisible, setCopyHintVisible] = React.useState(false);
    const copyHintTimeoutRef = React.useRef<number | null>(null);

    const userContentParts = React.useMemo(() => {
        return parts.filter((part) => {
            if (part.type === 'text') {
                return !isEmptyTextPart(part);
            }
            if (isSubtaskPart(part)) {
                return true;
            }
            if (isShellActionPart(part)) {
                return true;
            }
            return false;
        });
    }, [parts]);

    const mentionToken = agentMention?.token;
    let mentionInjected = false;

    const canCopyMessage = Boolean(onCopyMessage);
    const isMessageCopied = Boolean(copiedMessage);
    const isTouchContext = Boolean(hasTouchInput ?? isMobile);
    const hasCopyableText = Boolean(hasTextContent);
    const showUserContent = userActionsMode !== 'external-actions';
    const showUserActions = userActionsMode !== 'external-content';
    const useStickyScrollableUserContent = stickyUserHeaderEnabled && userActionsMode === 'inline';

    const clearCopyHintTimeout = React.useCallback(() => {
        if (copyHintTimeoutRef.current !== null && typeof window !== 'undefined') {
            window.clearTimeout(copyHintTimeoutRef.current);
            copyHintTimeoutRef.current = null;
        }
    }, []);

    const revealCopyHint = React.useCallback(() => {
        if (!isTouchContext || !canCopyMessage || !hasCopyableText || typeof window === 'undefined') {
            return;
        }

        clearCopyHintTimeout();
        setCopyHintVisible(true);
        copyHintTimeoutRef.current = window.setTimeout(() => {
            setCopyHintVisible(false);
            copyHintTimeoutRef.current = null;
        }, 1800);
    }, [canCopyMessage, clearCopyHintTimeout, hasCopyableText, isTouchContext]);

    React.useEffect(() => {
        if (!hasCopyableText) {
            setCopyHintVisible(false);
            clearCopyHintTimeout();
        }
    }, [clearCopyHintTimeout, hasCopyableText]);

    const handleCopyButtonClick = React.useCallback(
        (event: React.MouseEvent<HTMLButtonElement>) => {
            if (!onCopyMessage || !hasCopyableText) {
                return;
            }

            event.stopPropagation();
            event.preventDefault();
            onCopyMessage();

            if (isTouchContext) {
                revealCopyHint();
            }
        },
        [hasCopyableText, isTouchContext, onCopyMessage, revealCopyHint]
    );

    const effectiveOnFork = chatSurfaceMode === 'mini-chat' ? undefined : onFork;
    const actionsBlock = ((canCopyMessage && hasCopyableText) || onRevert || effectiveOnFork) && showUserActions ? (
        <div className={cn(
            'group/user-actions',
            isMobile
                ? userActionsMode === 'inline'
                    ? 'flex items-center justify-end pt-2 pb-3'
                    : stickyUserHeaderEnabled
                        ? 'flex h-9 items-start justify-end pt-0'
                        : 'flex h-11 items-start justify-end pt-0'
                : userActionsMode === 'inline'
                    ? 'absolute top-full left-0 right-0 z-10 pt-5'
                    : 'flex h-8 items-start justify-end pt-2'
        )}>
            <div
                className={cn(
                    'flex items-center justify-end gap-1',
                    isMobile
                        ? userActionsMode === 'inline'
                            ? 'translate-x-5'
                            : 'translate-x-0'
                        : userActionsMode === 'inline'
                            ? 'translate-x-5'
                            : 'translate-x-0',
                    alwaysShowActions
                        ? 'pointer-events-auto opacity-100'
                        : 'pointer-events-none opacity-0 transition-opacity duration-150 group-hover/message:pointer-events-auto group-hover/message:opacity-100 group-hover/user-actions:pointer-events-auto group-hover/user-actions:opacity-100 group-hover/user-shell:pointer-events-auto group-hover/user-shell:opacity-100'
                )}
            >
                {onRevert && (
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6 text-muted-foreground bg-transparent hover:text-foreground hover:!bg-transparent active:!bg-transparent focus-visible:!bg-transparent focus-visible:ring-2 focus-visible:ring-primary/50"
                                aria-label={t('chat.messageBody.actions.revertAria')}
                                disabled={isReverting}
                                onPointerDown={(event) => event.stopPropagation()}
                                onClick={(event) => {
                                    event.stopPropagation();
                                    void onRevert();
                                }}
                            >
                                <RiArrowGoBackLine className="h-3 w-3" />
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent sideOffset={6}>{t('chat.messageBody.actions.revert')}</TooltipContent>
                    </Tooltip>
                )}
                {effectiveOnFork && (
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6 text-muted-foreground bg-transparent hover:text-foreground hover:!bg-transparent active:!bg-transparent focus-visible:!bg-transparent focus-visible:ring-2 focus-visible:ring-primary/50"
                                aria-label={t('chat.messageBody.actions.forkAria')}
                                onPointerDown={(event) => event.stopPropagation()}
                                onClick={(event) => {
                                    event.stopPropagation();
                                    effectiveOnFork();
                                }}
                            >
                                <RiGitBranchLine className="h-3 w-3" />
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent sideOffset={6}>{t('chat.messageBody.actions.fork')}</TooltipContent>
                    </Tooltip>
                )}
                {canCopyMessage && hasCopyableText && (
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                data-visible={copyHintVisible || isMessageCopied ? 'true' : undefined}
                                className="h-6 w-6 text-muted-foreground bg-transparent hover:text-foreground hover:!bg-transparent active:!bg-transparent focus-visible:!bg-transparent focus-visible:ring-2 focus-visible:ring-primary/50"
                                aria-label={t('chat.messageBody.actions.copyMessageAria')}
                                onPointerDown={(event) => event.stopPropagation()}
                                onClick={handleCopyButtonClick}
                                onFocus={() => setCopyHintVisible(true)}
                                onBlur={() => {
                                    if (!isMessageCopied) {
                                        setCopyHintVisible(false);
                                    }
                                }}
                            >
                                {isMessageCopied ? (
                                    <RiCheckLine className="h-3 w-3 text-[color:var(--status-success)]" />
                                ) : (
                                    <RiFileCopyLine className="h-3 w-3" />
                                )}
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent sideOffset={6}>{t('chat.messageBody.actions.copyMessage')}</TooltipContent>
                    </Tooltip>
                )}
            </div>
        </div>
    ) : null;

    if (!showUserContent) {
        return <>{actionsBlock}</>;
    }

    return (
        <div
            data-chat-user-message="true"
            className="relative w-full group/message"
            style={CONTAIN_LAYOUT_STYLE}
            onTouchStart={isTouchContext && canCopyMessage && hasCopyableText ? revealCopyHint : undefined}
        >
            <div
                className={cn(
                    'leading-relaxed text-foreground/90 text-base overflow-x-hidden',
                    useStickyScrollableUserContent
                        ? 'overflow-y-auto overscroll-contain scrollbar-none'
                        : 'overflow-y-hidden'
                )}
                style={useStickyScrollableUserContent ? { maxHeight: 'calc(var(--chat-scroll-height, 100dvh) * 0.4)' } : undefined}
            >
                {userContentParts.map((part, index) => {
                    if (isSubtaskPart(part)) {
                        return (
                            <React.Fragment key={part.id ?? `user-subtask-${index}`}>
                                <UserSubtaskPart part={part} />
                            </React.Fragment>
                        );
                    }

                    if (isShellActionPart(part)) {
                        return (
                            <React.Fragment key={part.id ?? `user-shell-${index}`}>
                                <UserShellActionPart part={part} />
                            </React.Fragment>
                        );
                    }

                    let mentionForPart: AgentMentionInfo | undefined;
                    if (agentMention && mentionToken && !mentionInjected) {
                        const candidateText = extractTextContent(part);
                        if (candidateText.includes(mentionToken)) {
                            mentionForPart = agentMention;
                            mentionInjected = true;
                        }
                    }
                    return (
                        <React.Fragment key={part.id ?? `user-text-${index}`}>
                            <UserTextPart
                                part={part}
                                messageId={messageId}
                                isMobile={isMobile}
                                agentMention={mentionForPart}
                            />
                        </React.Fragment>
                    );
                })}
            </div>
            <MessageFilesDisplay files={parts} onShowPopup={onShowPopup} compact />
            {actionsBlock}
        </div>
    );
});

interface AssistantMessageActionButtonsProps {
    hasCopyableText: boolean;
    isTouchContext: boolean;
    onCopyMessage?: () => void | boolean | Promise<void | boolean>;
    ttsText: string;
}

const AssistantMessageActionButtons = React.memo(({
    hasCopyableText,
    isTouchContext,
    onCopyMessage,
    ttsText,
}: AssistantMessageActionButtonsProps) => {
    const { t } = useI18n();
    const chatSurfaceMode = useChatSurfaceMode();
    const { isPlaying: isTTSPlaying, play: playTTS, stop: stopTTS } = useMessageTTS();
    const showMessageTTSButtons = useConfigStore((state) => state.showMessageTTSButtons);
    const voiceProvider = useConfigStore((state) => state.voiceProvider);
    const [copyHintVisible, setCopyHintVisible] = React.useState(false);
    const [isMessageCopied, setIsMessageCopied] = React.useState(false);
    const copyHintTimeoutRef = React.useRef<number | null>(null);
    const copiedResetTimeoutRef = React.useRef<number | null>(null);
    const canCopyMessage = shouldRenderAssistantCopyButton({
        hasCopyableText,
        onCopyMessageConfigured: Boolean(onCopyMessage),
    });

    const clearCopyHintTimeout = React.useCallback(() => {
        if (copyHintTimeoutRef.current !== null && typeof window !== 'undefined') {
            window.clearTimeout(copyHintTimeoutRef.current);
            copyHintTimeoutRef.current = null;
        }
    }, []);

    const clearCopiedResetTimeout = React.useCallback(() => {
        if (copiedResetTimeoutRef.current !== null && typeof window !== 'undefined') {
            window.clearTimeout(copiedResetTimeoutRef.current);
            copiedResetTimeoutRef.current = null;
        }
    }, []);

    React.useEffect(() => {
        return () => {
            clearCopyHintTimeout();
            clearCopiedResetTimeout();
        };
    }, [clearCopiedResetTimeout, clearCopyHintTimeout]);

    React.useEffect(() => {
        if (!hasCopyableText || !canCopyMessage) {
            setCopyHintVisible(false);
            setIsMessageCopied(false);
            clearCopyHintTimeout();
            clearCopiedResetTimeout();
        }
    }, [canCopyMessage, clearCopiedResetTimeout, clearCopyHintTimeout, hasCopyableText]);

    const revealCopyHint = React.useCallback(() => {
        if (!isTouchContext || !canCopyMessage || !hasCopyableText || typeof window === 'undefined') {
            return;
        }

        clearCopyHintTimeout();
        setCopyHintVisible(true);
        copyHintTimeoutRef.current = window.setTimeout(() => {
            setCopyHintVisible(false);
            copyHintTimeoutRef.current = null;
        }, 1800);
    }, [canCopyMessage, clearCopyHintTimeout, hasCopyableText, isTouchContext]);

    const handleCopyButtonClick = React.useCallback(
        async (event: React.MouseEvent<HTMLButtonElement>) => {
            if (!onCopyMessage || !canCopyMessage) {
                return;
            }

            event.stopPropagation();
            event.preventDefault();

            const copied = await onCopyMessage();
            if (copied === false) {
                return;
            }

            clearCopiedResetTimeout();
            setIsMessageCopied(true);
            if (typeof window !== 'undefined') {
                copiedResetTimeoutRef.current = window.setTimeout(() => {
                    setIsMessageCopied(false);
                    copiedResetTimeoutRef.current = null;
                }, 2000);
            }

            if (isTouchContext) {
                revealCopyHint();
            }
        },
        [canCopyMessage, clearCopiedResetTimeout, isTouchContext, onCopyMessage, revealCopyHint]
    );

    const readAloudTooltip = React.useMemo(() => {
        if (isTTSPlaying) {
            return t('chat.messageBody.tts.stopSpeaking');
        }
        const providerLabel = voiceProvider === 'browser'
            ? 'Browser'
            : voiceProvider === 'openai'
                ? 'OpenAI'
                : voiceProvider === 'openai-compatible'
                    ? 'Custom'
                    : 'Say';
        return t('chat.messageBody.tts.readAloudWithProvider', { provider: providerLabel });
    }, [isTTSPlaying, t, voiceProvider]);

    const handleTTSClick = React.useCallback(
        (event: React.MouseEvent<HTMLButtonElement>) => {
            event.stopPropagation();
            event.preventDefault();

            if (isTTSPlaying) {
                stopTTS();
                return;
            }

            if (ttsText.trim()) {
                void playTTS(ttsText);
            }
        },
        [isTTSPlaying, playTTS, stopTTS, ttsText]
    );

    return (
        <>
            {canCopyMessage && (
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            data-visible={copyHintVisible || isMessageCopied ? 'true' : undefined}
                            className={cn(
                                'h-8 w-8 text-muted-foreground bg-transparent hover:text-foreground hover:!bg-transparent active:!bg-transparent focus-visible:!bg-transparent focus-visible:ring-2 focus-visible:ring-primary/50',
                            )}
                            aria-label={t('chat.messageBody.actions.copyMessageAria')}
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={(event) => {
                                void handleCopyButtonClick(event);
                            }}
                            onFocus={() => {
                                if (hasCopyableText) {
                                    setCopyHintVisible(true);
                                }
                            }}
                            onBlur={() => {
                                if (!isMessageCopied) {
                                    setCopyHintVisible(false);
                                }
                            }}
                        >
                            {isMessageCopied ? (
                                <RiCheckLine className="h-3.5 w-3.5 text-[color:var(--status-success)]" />
                            ) : (
                                <RiFileCopyLine className="h-3.5 w-3.5" />
                            )}
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent sideOffset={6}>{t('chat.messageBody.actions.copyAnswer')}</TooltipContent>
                </Tooltip>
            )}
            {chatSurfaceMode !== 'mini-chat' && showMessageTTSButtons && hasCopyableText && (
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className={cn(
                                'h-8 w-8 bg-transparent hover:!bg-transparent active:!bg-transparent focus-visible:!bg-transparent focus-visible:ring-2 focus-visible:ring-primary/50',
                                isTTSPlaying ? 'text-green-500' : 'text-muted-foreground hover:text-foreground'
                            )}
                            aria-label={isTTSPlaying ? t('chat.messageBody.tts.stopSpeaking') : t('chat.messageBody.tts.readAloud')}
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={handleTTSClick}
                        >
                            {isTTSPlaying ? (
                                <RiStopLine className="h-3.5 w-3.5" />
                            ) : (
                                <RiVolumeUpLine className="h-3.5 w-3.5" />
                            )}
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent sideOffset={6}>{readAloudTooltip}</TooltipContent>
                </Tooltip>
            )}
        </>
    );
});

const AssistantMessageBody = React.memo(({
    sessionId,
    messageId,
    parts,
    isMessageCompleted,
    messageFinish,
    messageCompletedAt,
    messageCreatedAt,
    providerID,
    syntaxTheme,
    isMobile,
    alwaysShowActions,
    hasTouchInput,
    expandedTools,
    onToggleTool,
    onShowPopup,
    streamPhase: _streamPhase,
    allowAnimation: _allowAnimation,
    onContentChange,
    hasTextContent = false,
    onCopyMessage,
    onAuxiliaryContentComplete,
    showReasoningTraces = false,
    turnGroupingContext,
    errorMessage,
    errorVariant = 'error',
    isPlanModeSource = false,
}: Omit<MessageBodyProps, 'isUser'>) => {
    const { t } = useI18n();
    const chatSurfaceMode = useChatSurfaceMode();
    const streamPhase = _streamPhase;
    void _allowAnimation;
    const messageContentRef = React.useRef<HTMLDivElement>(null);
    const toolRevealReadyRef = React.useRef(false);

    React.useEffect(() => {
        toolRevealReadyRef.current = true;
    }, []);

    const isTouchContext = Boolean(hasTouchInput ?? isMobile);
    const alwaysShowMessageActions = Boolean(alwaysShowActions ?? isMobile);
    const awaitingMessageCompletion = !isMessageCompleted;
    const animateActivityRows = awaitingMessageCompletion || Boolean(turnGroupingContext?.isWorking);
    const visibleParts = React.useMemo(() => {
        return collapseSupersededTodoWrites(parts, turnGroupingContext?.lastTodoToolPartId ?? null)
            .filter((part) => !isEmptyTextPart(part))
            .filter((part) => {
                const rawPart = part as Record<string, unknown>;
                return rawPart.type !== 'compaction';
            })
            .filter((part) => {
                // Hidden tools (e.g. create_plan, which is surfaced as the rich
                // Implementation Plan card) must never render as their own row.
                if (part.type !== 'tool') return true;
                if (isManagedTaskToolName((part as ToolPartType).tool)) return true;
                return !isHiddenTool((part as ToolPartType).tool);
            })
            .filter((part, index, arr) => {
                // Drop short mid-sentence narration fragments wedged between
                // tool/reasoning activity (composer choppy-narration noise).
                if (part.type !== 'text') return true;
                return !isOrphanNarrationFragment(
                    extractTextContent(part),
                    arr[index - 1]?.type,
                    arr[index + 1]?.type,
                );
            });
    }, [parts, turnGroupingContext?.lastTodoToolPartId]);

    const managedTaskDispatch = React.useMemo(
        () => resolveManagedTaskDispatch(visibleParts),
        [visibleParts],
    );
    const managedBarrierLocked = useManagedOrchestrationStore(React.useMemo(
        () => managedOrchestrationSelectors.hasUndispositionedTasksForRoot(sessionId ?? ''),
        [sessionId],
    ));
    const suppressLiveManagedControlReasoning = managedBarrierLocked
        && !isMessageCompleted
        && managedTaskDispatch.taskIds.length === 0
        && managedTaskDispatch.pendingDispatches.length === 0;

    const toolParts = React.useMemo(() => {
        return visibleParts.filter((part): part is ToolPartType => part.type === 'tool');
    }, [visibleParts]);

    const toolRevealStateRef = React.useRef<{
        messageId: string;
        hasCommitted: boolean;
        persistedToolIds: Set<string>;
        animatedToolIds: Set<string>;
    }>({
        messageId,
        hasCommitted: false,
        persistedToolIds: readRevealedToolIds(messageId),
        animatedToolIds: new Set<string>(),
    });

    if (toolRevealStateRef.current.messageId !== messageId) {
        toolRevealStateRef.current = {
            messageId,
            hasCommitted: false,
            persistedToolIds: readRevealedToolIds(messageId),
            animatedToolIds: new Set<string>(),
        };
    }

    const currentToolIds = React.useMemo(() => {
        const ids = new Set<string>();

        for (const toolPart of toolParts) {
            ids.add(toolPart.id);
        }

        const activitySegments = turnGroupingContext?.activityGroupSegments;
        if (Array.isArray(activitySegments)) {
            for (const segment of activitySegments) {
                if (segment.anchorMessageId !== messageId) {
                    continue;
                }
                for (const activity of segment.parts) {
                    if (activity.kind !== 'tool') {
                        continue;
                    }
                    const toolId = (activity.part as { id?: unknown }).id;
                    if (typeof toolId === 'string' && toolId.length > 0) {
                        ids.add(toolId);
                    }
                }
            }
        }

        return Array.from(ids);
    }, [messageId, toolParts, turnGroupingContext?.activityGroupSegments]);
    const shouldAnimateNewToolMount = Boolean(turnGroupingContext?.isWorking && toolRevealReadyRef.current);
    const persistedToolIds = toolRevealStateRef.current.persistedToolIds;
    const animatedToolIds = toolRevealStateRef.current.animatedToolIds;

    if (shouldAnimateNewToolMount && toolRevealStateRef.current.hasCommitted) {
        for (const toolId of currentToolIds) {
            if (!persistedToolIds.has(toolId)) {
                animatedToolIds.add(toolId);
            }
        }
    }

    const animatedToolIdsKey = Array.from(animatedToolIds).join('\u0000');
    const animatedToolIdsLookup = React.useMemo(
        () => new Set(animatedToolIdsKey ? animatedToolIdsKey.split('\u0000') : []),
        [animatedToolIdsKey]
    );

    React.useEffect(() => {
        const nextPersistedToolIds = new Set(toolRevealStateRef.current.persistedToolIds);
        for (const toolId of currentToolIds) {
            nextPersistedToolIds.add(toolId);
        }
        toolRevealStateRef.current.persistedToolIds = nextPersistedToolIds;
        toolRevealStateRef.current.hasCommitted = true;
        writeRevealedToolIds(messageId, nextPersistedToolIds);
    }, [currentToolIds, messageId]);

    const assistantTextParts = React.useMemo(() => {
        return visibleParts.filter((part) => part.type === 'text');
    }, [visibleParts]);
    const assistantPlanText = React.useMemo(() => flattenAssistantTextParts(assistantTextParts), [assistantTextParts]);

    const openContextPreview = useUIStore((state) => state.openContextPreview);

    const messagePreviewUrl = React.useMemo(() => {
        for (const part of assistantTextParts) {
            const text = (part as { text?: unknown }).text;
            if (typeof text !== 'string' || text.length === 0) {
                continue;
            }
            const url = extractLoopbackUrls(text)[0];
            if (!url) {
                continue;
            }
            return url.includes('0.0.0.0') ? url.replace('0.0.0.0', '127.0.0.1') : url;
        }
        for (const part of toolParts) {
            const state = (part as unknown as { state?: unknown }).state as Record<string, unknown> | undefined;
            const output = state && typeof state.output === 'string' ? state.output : null;
            if (!output) {
                continue;
            }
            // eslint-disable-next-line no-control-regex
            const url = extractLoopbackUrls(output.replace(/\x1b\[[0-9;]*m/g, ''))[0];
            if (!url) {
                continue;
            }
            return url.includes('0.0.0.0') ? url.replace('0.0.0.0', '127.0.0.1') : url;
        }
        return null;
    }, [assistantTextParts, toolParts]);

    const createSessionFromAssistantMessage = useSessionUIStore((state) => state.createSessionFromAssistantMessage);
    const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
    const projects = useProjectsStore((state) => state.projects);
    const effectiveDirectory = useEffectiveDirectory();
    const sessions = useSessions();
    const chatRenderMode = useUIStore((state) => state.chatRenderMode);
    const showSplitAssistantMessageActions = useUIStore((state) => state.showSplitAssistantMessageActions);
    const isSortedRenderMode = chatRenderMode === 'sorted';
    const isMiniChatSurface = chatSurfaceMode === 'mini-chat';
    const collapsedPreviewCount = 7;
    const isLastAssistantInTurn = turnGroupingContext?.isLastAssistantInTurn ?? false;
    const hasStopFinish = messageFinish === 'stop';
    const isCursorAssistantProvider = isCursorProvider(providerID);

    const currentSession = React.useMemo(() => {
        if (!currentSessionId) {
            return null;
        }
        return sessions.find((session) => session.id === currentSessionId) ?? null;
    }, [currentSessionId, sessions]);

    const messageSession = React.useMemo(() => {
        if (!sessionId) {
            return null;
        }
        return sessions.find((session) => session.id === sessionId) ?? null;
    }, [sessionId, sessions]);

    const availableWorktreesByProject = useSessionUIStore((state) => state.availableWorktreesByProject);
    const messageProjectRef = React.useMemo(() => {
        const directory = typeof messageSession?.directory === 'string'
            ? messageSession.directory
            : sessionId === currentSessionId
                ? effectiveDirectory ?? ''
                : '';
        const resolved = resolveProjectForSessionDirectory(projects, availableWorktreesByProject, directory);
        return resolved ? { id: resolved.id, path: resolved.path } : null;
    }, [availableWorktreesByProject, currentSessionId, effectiveDirectory, messageSession?.directory, projects, sessionId]);


    const hasTools = toolParts.length > 0;

    const hasPendingTools = React.useMemo(() => {
        return toolParts.some((toolPart) => {
            const state = (toolPart as Record<string, unknown>).state as Record<string, unknown> | undefined ?? {};
            const status = state?.status;
            return status === 'pending' || status === 'running' || status === 'started';
        });
    }, [toolParts]);

    const isActiveTool = React.useCallback((toolPart: ToolPartType): boolean => {
        const state = (toolPart as Record<string, unknown>).state as Record<string, unknown> | undefined ?? {};
        const status = state?.status;
        return status === 'pending' || status === 'running' || status === 'started';
    }, []);

    const isToolFinalized = React.useCallback((toolPart: ToolPartType) => isToolPartFinalizedForDisplay(toolPart), []);

    const shouldShowTool = React.useCallback((toolPart: ToolPartType): boolean => {
        return isActiveTool(toolPart) || isToolFinalized(toolPart);
    }, [isActiveTool, isToolFinalized]);

    const allToolsFinalized = React.useMemo(() => {
        if (toolParts.length === 0) {
            return true;
        }
        if (hasPendingTools) {
            return false;
        }
        return toolParts.every((toolPart) => isToolFinalized(toolPart));
    }, [toolParts, hasPendingTools, isToolFinalized]);


    const reasoningParts = React.useMemo(() => {
        return visibleParts.filter((part) => part.type === 'reasoning');
    }, [visibleParts]);

    const reasoningComplete = React.useMemo(() => {
        if (reasoningParts.length === 0) {
            return true;
        }
        return reasoningParts.every((part) => {
            const time = (part as Record<string, unknown>).time as { end?: number } | undefined;
            return typeof time?.end === 'number';
        });
    }, [reasoningParts]);

    // Message is considered to have an "open step" if info.finish is not yet present
    const hasOpenStep = typeof messageFinish !== 'string';

    const shouldHoldForReasoning =
        reasoningParts.length > 0 &&
        hasTools &&
        (hasPendingTools || hasOpenStep || !allToolsFinalized);


    const shouldHoldTools = awaitingMessageCompletion
        || (hasTools && (hasPendingTools || hasOpenStep || !allToolsFinalized));
    const shouldHoldReasoning = awaitingMessageCompletion || shouldHoldForReasoning;

    const hasAuxiliaryContent = hasTools || reasoningParts.length > 0;
    const isTextlessAssistantMessage = assistantTextParts.length === 0;
    const auxiliaryContentComplete = hasAuxiliaryContent && isTextlessAssistantMessage && !shouldHoldTools && !shouldHoldReasoning && allToolsFinalized && reasoningComplete;
    const auxiliaryCompletionAnnouncedRef = React.useRef(false);
    const soloReasoningScrollTriggeredRef = React.useRef(false);

    React.useEffect(() => {
        soloReasoningScrollTriggeredRef.current = false;
    }, [messageId]);

    React.useEffect(() => {
        if (!auxiliaryContentComplete) {
            auxiliaryCompletionAnnouncedRef.current = false;
            return;
        }
        if (auxiliaryCompletionAnnouncedRef.current) {
            return;
        }
        auxiliaryCompletionAnnouncedRef.current = true;
        onAuxiliaryContentComplete?.();
    }, [auxiliaryContentComplete, onAuxiliaryContentComplete]);

    React.useEffect(() => {
        if (awaitingMessageCompletion) {
            soloReasoningScrollTriggeredRef.current = false;
            return;
        }
        if (hasTools) {
            soloReasoningScrollTriggeredRef.current = false;
            return;
        }
        if (reasoningParts.length === 0) {
            return;
        }
        if (shouldHoldReasoning || !reasoningComplete) {
            return;
        }
        if (soloReasoningScrollTriggeredRef.current) {
            return;
        }
        soloReasoningScrollTriggeredRef.current = true;
        onContentChange?.('structural');
    }, [awaitingMessageCompletion, hasTools, onContentChange, reasoningComplete, reasoningParts.length, shouldHoldReasoning]);

    const hasCopyableText = Boolean(hasTextContent) && !awaitingMessageCompletion;

    const handleForkClick = React.useCallback(
        (event: React.MouseEvent<HTMLButtonElement>) => {
            event.stopPropagation();
            event.preventDefault();
            if (!createSessionFromAssistantMessage) {
                return;
            }
            void createSessionFromAssistantMessage(messageId);
        },
        [createSessionFromAssistantMessage, messageId]
    );

    const activityPartsForTurn = React.useMemo(() => {
        const all = turnGroupingContext?.activityParts;
        if (!isSortedRenderMode || !all) {
            return [];
        }
        return all;
    }, [isSortedRenderMode, turnGroupingContext?.activityParts]);

    const activityGroupSegmentsForMessage = React.useMemo(() => {
        const all = turnGroupingContext?.activityGroupSegments;
        if (!isSortedRenderMode || !all) {
            return [];
        }
        return all.filter((segment) => segment.anchorMessageId === messageId);
    }, [isSortedRenderMode, messageId, turnGroupingContext?.activityGroupSegments]);

    const liveFileActivityGroupByPartId = React.useMemo(() => {
        const byPartId = new Map<string, {
            ownerPartId: string;
            groupInfo: ToolActivityGroupInfo;
            activities: NonNullable<TurnGroupingContext['activityParts']>;
        }>();
        if (isSortedRenderMode) {
            return byPartId;
        }

        for (const segment of turnGroupingContext?.activityGroupSegments ?? []) {
            const groups = collectCrossMessageFileActivityGroups(segment.parts, {
                getToolName: (activity) => activity.kind === 'tool'
                    ? (activity.part as ToolPartType).tool
                    : '',
                getToolPart: (activity) => activity.kind === 'tool'
                    ? activity.part as ToolPartType
                    : undefined,
                getMessageId: (activity) => activity.messageId,
                isReasoningOrJustification: (activity) => activity.kind === 'reasoning' || activity.kind === 'justification',
                isStandalone: (activity) => activity.kind === 'tool'
                    && isStandaloneTool((activity.part as ToolPartType).tool),
            });
            groups.forEach((group) => {
                const activities = group.items.filter((activity) => activity.kind === 'tool');
                const ownerPartId = activities[0]?.id;
                if (!ownerPartId) {
                    return;
                }
                const descriptor = { ownerPartId, groupInfo: group.groupInfo, activities };
                activities.forEach((activity) => byPartId.set(activity.id, descriptor));
            });
        }

        return byPartId;
    }, [isSortedRenderMode, turnGroupingContext?.activityGroupSegments]);

    const hasAnchoredActivitySegments = activityGroupSegmentsForMessage.length > 0;

    const activityByPart = React.useMemo(() => {
        const byRef = new Map<Part, (typeof activityPartsForTurn)[number]>();
        const byId = new Map<string, (typeof activityPartsForTurn)[number]>();
        activityPartsForTurn.forEach((activity) => {
            byRef.set(activity.part, activity);
            const partId = (activity.part as { id?: unknown }).id;
            if (typeof partId === 'string' && partId.length > 0) {
                byId.set(partId, activity);
            }
        });

        return {
            get: (part: Part) => {
                const direct = byRef.get(part);
                if (direct) {
                    return direct;
                }
                const partId = (part as { id?: unknown }).id;
                if (typeof partId === 'string' && partId.length > 0) {
                    return byId.get(partId);
                }
                return undefined;
            },
        };
    }, [activityPartsForTurn]);

    const toggleActivityGroup = turnGroupingContext?.toggleGroup;
    const isActivityOwnerMessage = !isSortedRenderMode
        || !turnGroupingContext?.activityOwnerMessageId
        || turnGroupingContext.activityOwnerMessageId === messageId
        || hasAnchoredActivitySegments;

    const shouldRenderActivityGroup = isSortedRenderMode
        && isActivityOwnerMessage
        && hasAnchoredActivitySegments
        && Boolean(toggleActivityGroup);

    const shouldDeferSortedInlineText = isSortedRenderMode && !hasStopFinish;
    const showErrorMessage = Boolean(errorMessage);
    const ErrorIcon = errorVariant === 'info' ? RiInformationLine : RiErrorWarningLine;
    const shouldShowMessageActions = hasCopyableText;
    const shouldShowTurnFooter = isLastAssistantInTurn && hasTextContent && (hasStopFinish || Boolean(errorMessage));
    const shouldRenderActionsInActivity = isSortedRenderMode;
    const shouldShowStandaloneMessageActions = showSplitAssistantMessageActions
        && shouldShowMessageActions
        && !turnGroupingContext?.isTurnWorking
        && !shouldShowTurnFooter
        && !shouldRenderActionsInActivity;

    const messageActionButtons = React.useMemo(() => (
        <AssistantMessageActionButtons
            hasCopyableText={hasCopyableText}
            isTouchContext={isTouchContext}
            onCopyMessage={onCopyMessage}
            ttsText={assistantPlanText}
        />
    ), [assistantPlanText, hasCopyableText, isTouchContext, onCopyMessage]);

    const lastRenderableTextPartIndex = React.useMemo(() => {
        if (!shouldShowStandaloneMessageActions) {
            return -1;
        }

        let lastIndex = -1;
        for (let index = 0; index < managedTaskDispatch.contentParts.length; index += 1) {
            const part = managedTaskDispatch.contentParts[index];
            if (!part || part.type !== 'text') {
                continue;
            }
            if (shouldDeferSortedInlineText) {
                continue;
            }
            const activity = activityByPart.get(part);
            if (activity?.kind === 'justification') {
                continue;
            }
            lastIndex = index;
        }

        return lastIndex;
    }, [activityByPart, managedTaskDispatch.contentParts, shouldDeferSortedInlineText, shouldShowStandaloneMessageActions]);

    const shouldRenderStandaloneActionsAfterContent = shouldShowStandaloneMessageActions
        && !isCursorAssistantProvider
        && lastRenderableTextPartIndex < 0;

    const messagePlan = React.useMemo(
        () => (sessionId != null ? resolveMessagePlanCard(visibleParts, { isPlanModeSource }) : null),
        [isPlanModeSource, sessionId, visibleParts],
    );

    const renderedParts = React.useMemo(() => {
        const rendered: React.ReactNode[] = [];

        if (shouldRenderActivityGroup && toggleActivityGroup) {
            activityGroupSegmentsForMessage.forEach((segment) => {
                const visibleSegmentParts = filterGroupedActivityReasoning(segment.parts);
                if (visibleSegmentParts.length === 0) {
                    return;
                }
                rendered.push(
                    <div key={`progressive-group-${segment.id}`} className="mb-3">
                        <TurnActivity
                            parts={visibleSegmentParts}
                            isExpanded={turnGroupingContext.isGroupExpanded === true}
                            collapsedPreviewCount={collapsedPreviewCount}
                            onToggle={toggleActivityGroup}
                            syntaxTheme={syntaxTheme}
                            isMobile={isMobile}
                            expandedTools={expandedTools}
                            onToggleTool={onToggleTool}
                            onShowPopup={onShowPopup}
                            onContentChange={onContentChange}
                            streamPhase={streamPhase}
                            showHeader={true}
                            animateRows={animateActivityRows}
                            animatedToolIds={animatedToolIdsLookup}
                            diffStats={turnGroupingContext.diffStats}
                            providerID={providerID}
                            responseStyleLevel={turnGroupingContext.responseStyleLevel}
                        />
                    </div>
                );
            });
        }

        // Flat rendering: iterate parts in natural order.
        // Group consecutive static tools (read, grep, glob, etc.) into compact rows.
        // Expandable tools (bash, edit, task) get individual rows.
        // Text and reasoning retain their natural order. Managed task tools are
        // projected separately into the single Agent Dispatch tail below.
        let i = 0;
        let hasRenderedPlanCard = false;
        let globalTextGroupOffset = 0;
        let hasSeenTextGroup = false;
        while (i < managedTaskDispatch.contentParts.length) {
            const part = managedTaskDispatch.contentParts[i];

            if (part.type === 'text') {
                const activity = activityByPart.get(part);
                if (shouldDeferSortedInlineText) {
                    i += 1;
                    continue;
                }
                if (activity?.kind === 'justification') {
                    i += 1;
                    continue;
                }
                const textGroup: Part[] = [part];
                let groupEndIndex = i;
                while (groupEndIndex + 1 < managedTaskDispatch.contentParts.length) {
                    const nextPart = managedTaskDispatch.contentParts[groupEndIndex + 1];
                    if (!nextPart || nextPart.type !== 'text') {
                        break;
                    }
                    const nextActivity = activityByPart.get(nextPart);
                    if (nextActivity?.kind === 'justification') {
                        break;
                    }
                    textGroup.push(nextPart);
                    groupEndIndex += 1;
                }
                const renderPart = mergeConsecutiveTextParts(textGroup);
                const renderPartText = (renderPart as { text?: string }).text ?? '';
                if (hasSeenTextGroup) {
                    globalTextGroupOffset += 1;
                }
                const groupStart = globalTextGroupOffset;
                const groupEnd = globalTextGroupOffset + renderPartText.length;
                globalTextGroupOffset = groupEnd;
                hasSeenTextGroup = true;

                if (messagePlan && sessionId != null) {
                    const suppressPostPlanText = shouldSuppressPostPlanText(messagePlan, isPlanModeSource);
                    const { segments, planCardRendered } = buildPlanCardRenderSegments({
                        groupText: renderPartText,
                        groupStart,
                        groupEnd,
                        messagePlan,
                        planCardRendered: hasRenderedPlanCard,
                        suppressPostPlanText,
                    });
                    hasRenderedPlanCard = planCardRendered;

                    segments.forEach((segment, segmentIndex) => {
                        if (segment.kind === 'consumed-plan-text') {
                            return;
                        }

                        if (segment.kind === 'preserved-text') {
                            const preamblePart = {
                                ...renderPart,
                                id: `${(renderPart as { id?: string }).id ?? 'text'}__pre-${i}-${segmentIndex}`,
                                text: segment.text,
                            } as Part;
                            rendered.push(
                                <div key={`assistant-text-${messageId}-${i}-${groupEndIndex}-pre-${segmentIndex}`}>
                                    <AssistantTextPart
                                        part={preamblePart}
                                        sessionId={sessionId}
                                        messageId={messageId}
                                        streamPhase={streamPhase}
                                        chatRenderMode={chatRenderMode}
                                        isPlanModeSource={false}
                                        isMessageCompleted={isMessageCompleted}
                                        onContentChange={onContentChange}
                                    />
                                </div>
                            );
                            return;
                        }

                        rendered.push(
                            <div key={`assistant-text-${messageId}-${i}-${groupEndIndex}-plan`}>
                                <PlanCard
                                    sessionId={sessionId as string}
                                    sourceMessageId={messageId}
                                    streamPhase={streamPhase}
                                    planText={messagePlan.planText.trimStart()}
                                    projectPath={messageProjectRef?.path ?? null}
                                    sessionCreated={messageSession?.time?.created ?? null}
                                    sessionSlug={messageSession?.slug ?? null}
                                />
                            </div>
                        );
                    });
                } else {
                    rendered.push(
                        <div key={`assistant-text-${messageId}-${i}-${groupEndIndex}`}>
                            <AssistantTextPart
                                part={renderPart}
                                sessionId={sessionId}
                                messageId={messageId}
                                streamPhase={streamPhase}
                                chatRenderMode={chatRenderMode}
                                isPlanModeSource={isPlanModeSource}
                                isMessageCompleted={isMessageCompleted}
                                onContentChange={onContentChange}
                            />
                        </div>
                    );
                }
                const textGroupIds = textGroup
                    .map((textPart) => (textPart as { id?: unknown }).id)
                    .filter((id): id is string => typeof id === 'string' && id.length > 0);
                let hasToolAfterTextGroup = false;
                for (let partIndex = groupEndIndex + 1; partIndex < managedTaskDispatch.contentParts.length; partIndex += 1) {
                    if (managedTaskDispatch.contentParts[partIndex]?.type === 'tool') {
                        hasToolAfterTextGroup = true;
                        break;
                    }
                }
                if (shouldRenderStandaloneAssistantActionsForTextGroup({
                    providerID,
                    shouldShowStandaloneMessageActions,
                    messageId,
                    groupStartIndex: i,
                    groupEndIndex,
                    lastRenderableTextPartIndex,
                    textPartIds: textGroupIds,
                    text: renderPartText,
                    summarySourceMessageId: turnGroupingContext?.summarySourceMessageId,
                    summarySourcePartId: turnGroupingContext?.summarySourcePartId,
                    hasToolAfterTextGroup,
                })) {
                    rendered.push(
                        <div key={`message-actions-${messageId}`} className={INLINE_MESSAGE_ACTIONS_CLASS_NAME} data-message-actions="true">
                            <div className="flex items-center gap-1.5" data-message-action-group="true">
                                {messageActionButtons}
                            </div>
                        </div>
                    );
                }
                i = groupEndIndex + 1;
                continue;
            }

            if (part.type === 'reasoning') {
                if (shouldRenderReasoning(showReasoningTraces) && !suppressLiveManagedControlReasoning) {
                    rendered.push(
                        <ReasoningPart
                            key={getReasoningPartRenderKey(messageId, part.id, i)}
                            part={part}
                            messageId={messageId}
                            providerID={providerID}
                            responseStyleLevel={turnGroupingContext?.responseStyleLevel}
                            onContentChange={onContentChange}
                        />
                    );
                }
                i++;
                continue;
            }

            if (part.type === 'tool') {
                const toolPart = part as ToolPartType;
                const toolName = normalizeToolName(toolPart.tool);

                if (isSortedRenderMode && !isActivityOwnerMessage) {
                    i += 1;
                    continue;
                }

                const activity = activityByPart.get(part);
                if (activity?.kind === 'tool' && (shouldRenderActivityGroup || !isStandaloneTool(toolName))) {
                    i += 1;
                    continue;
                }

                if (!shouldShowTool(toolPart)) {
                    i++;
                    continue;
                }

                const liveFileActivityGroup = liveFileActivityGroupByPartId.get(toolPart.id);
                if (liveFileActivityGroup) {
                    if (liveFileActivityGroup.ownerPartId === toolPart.id) {
                        rendered.push(
                            <GroupedToolActivityRow
                                key={`live-file-group-${liveFileActivityGroup.groupInfo.key}-${toolPart.id}`}
                                groupInfo={liveFileActivityGroup.groupInfo}
                                activities={liveFileActivityGroup.activities}
                                syntaxTheme={syntaxTheme}
                                isMobile={isMobile}
                                expandedTools={expandedTools}
                                onToggleTool={onToggleTool}
                                onShowPopup={onShowPopup}
                                onContentChange={onContentChange}
                                animateTailText={liveFileActivityGroup.activities.some((activity) => animatedToolIdsLookup.has(activity.id))}
                                animateRows={true}
                            />
                        );
                    }
                    i += 1;
                    continue;
                }

                const makeToolActivity = (groupedToolPart: ToolPartType) => ({
                    id: groupedToolPart.id,
                    turnId: '',
                    messageId,
                    partIndex: 0,
                    part: groupedToolPart,
                    kind: 'tool' as const,
                });

                const renderSingleToolPart = (singleToolPart: ToolPartType) => {
                    const singleToolName = normalizeToolName(singleToolPart.tool);
                    if (isExpandableTool(singleToolName)) {
                        return (
                            <FadeInOnReveal key={`tool-${singleToolPart.id}`}>
                                <ToolRevealOnMount animate={animatedToolIdsLookup.has(singleToolPart.id)} wipe>
                                    <ToolPart
                                        part={singleToolPart}
                                        isExpanded={expandedTools.has(singleToolPart.id)}
                                        onToggle={onToggleTool}
                                        syntaxTheme={syntaxTheme}
                                        isMobile={isMobile}
                                        alwaysShowActions={alwaysShowMessageActions}
                                        onContentChange={onContentChange}
                                        onShowPopup={onShowPopup}
                                        animateTailText={animatedToolIdsLookup.has(singleToolPart.id)}
                                    />
                                </ToolRevealOnMount>
                            </FadeInOnReveal>
                        );
                    }

                    return (
                        <FadeInOnReveal key={`static-tools-${singleToolPart.id}`}>
                            <ToolRevealOnMount animate={animatedToolIdsLookup.has(singleToolPart.id)} wipe>
                                <StaticToolRow
                                    toolName={singleToolName}
                                    activities={[makeToolActivity(singleToolPart)]}
                                    animateTailText={animatedToolIdsLookup.has(singleToolPart.id)}
                                />
                            </ToolRevealOnMount>
                        </FadeInOnReveal>
                    );
                };

                const burst = collectToolActivityBurst(managedTaskDispatch.contentParts, i, (candidate: Part) => {
                    if (candidate.type !== 'tool') {
                        return null;
                    }

                    const candidateToolPart = candidate as ToolPartType;
                    const candidateToolName = normalizeToolName(candidateToolPart.tool);
                    if (isStandaloneTool(candidateToolName) || !shouldShowTool(candidateToolPart)) {
                        return null;
                    }

                    const candidateActivity = activityByPart.get(candidate);
                    if (candidateActivity?.kind === 'tool' && (shouldRenderActivityGroup || !isStandaloneTool(candidateToolName))) {
                        return null;
                    }

                    return candidateToolName;
                }, {
                    getToolPart: (candidate: Part) => candidate.type === 'tool' ? candidate as ToolPartType : undefined,
                    isBoundary: (candidate: Part) => candidate.type !== 'tool',
                });

                if (burst) {
                    burst.rows.forEach((row, rowIndex) => {
                        if (row.type === 'item') {
                            rendered.push(renderSingleToolPart(row.item as ToolPartType));
                            return;
                        }

                        const activities = row.items.map((groupedPart) => makeToolActivity(groupedPart as ToolPartType));
                        rendered.push(
                            <GroupedToolActivityRow
                                key={`tool-group-${row.groupInfo.key}-${activities[0]?.id ?? i}-${rowIndex}`}
                                groupInfo={row.groupInfo}
                                activities={activities}
                                syntaxTheme={syntaxTheme}
                                isMobile={isMobile}
                                expandedTools={expandedTools}
                                onToggleTool={onToggleTool}
                                onShowPopup={onShowPopup}
                                onContentChange={onContentChange}
                                animateTailText={activities.some((groupedActivity) => animatedToolIdsLookup.has(groupedActivity.id))}
                                animateRows={true}
                            />
                        );
                    });
                    i = burst.endIndex;
                    continue;
                }

                // Expandable tools: bash, edit, write, task, question — individual rows unless grouped above
                if (isExpandableTool(toolName)) {
                    rendered.push(
                        <FadeInOnReveal key={`tool-${toolPart.id}`}>
                            <ToolRevealOnMount animate={animatedToolIdsLookup.has(toolPart.id)} wipe>
                                <ToolPart
                                    part={toolPart}
                                    isExpanded={expandedTools.has(toolPart.id)}
                                    onToggle={onToggleTool}
                                    syntaxTheme={syntaxTheme}
                                    isMobile={isMobile}
                                    alwaysShowActions={alwaysShowMessageActions}
                                    onContentChange={onContentChange}
                                    onShowPopup={onShowPopup}
                                    animateTailText={animatedToolIdsLookup.has(toolPart.id)}
                                />
                            </ToolRevealOnMount>
                        </FadeInOnReveal>
                    );
                    i++;
                    continue;
                }

                // Static tools: one row per tool call (no grouping)
                rendered.push(
                    <FadeInOnReveal key={`static-tools-${toolPart.id}`}>
                        <ToolRevealOnMount animate={animatedToolIdsLookup.has(toolPart.id)} wipe>
                            <StaticToolRow
                                toolName={toolName}
                                activities={[
                                    {
                                        id: toolPart.id,
                                        turnId: '',
                                        messageId,
                                        partIndex: 0,
                                        part: toolPart,
                                        kind: 'tool' as const,
                                    },
                                ]}
                                animateTailText={animatedToolIdsLookup.has(toolPart.id)}
                            />
                        </ToolRevealOnMount>
                    </FadeInOnReveal>
                );
                i++;
                continue;
            }

            // Unknown part type — skip
            i++;
        }

        return rendered;
    }, [
        activityByPart,
        activityGroupSegmentsForMessage,
        alwaysShowMessageActions,
        animatedToolIdsLookup,
        animateActivityRows,
        chatRenderMode,
        collapsedPreviewCount,
        expandedTools,
        isMessageCompleted,
        isPlanModeSource,
        isMobile,
        isActivityOwnerMessage,
        isSortedRenderMode,
        liveFileActivityGroupByPartId,
        providerID,
        lastRenderableTextPartIndex,
        messageId,
        messageActionButtons,
        messagePlan,
        messageProjectRef?.path,
        messageSession?.slug,
        messageSession?.time?.created,
        managedTaskDispatch,
        sessionId,
        onContentChange,
        onShowPopup,
        onToggleTool,
        shouldRenderActivityGroup,
        shouldShowStandaloneMessageActions,
        shouldShowTool,
        streamPhase,
        showReasoningTraces,
        shouldDeferSortedInlineText,
        suppressLiveManagedControlReasoning,
        syntaxTheme,
        toggleActivityGroup,
        turnGroupingContext,
    ]);

    const turnDurationText = React.useMemo(() => {
        if (!isLastAssistantInTurn || !hasStopFinish) return undefined;
        const userCreatedAt = turnGroupingContext?.userMessageCreatedAt;
        if (typeof userCreatedAt !== 'number' || typeof messageCompletedAt !== 'number') return undefined;
        if (messageCompletedAt <= userCreatedAt) return undefined;
        return formatTurnDuration(messageCompletedAt - userCreatedAt);
    }, [isLastAssistantInTurn, hasStopFinish, turnGroupingContext?.userMessageCreatedAt, messageCompletedAt]);

    const footerTimestamp = React.useMemo(() => {
        const timestamp = typeof messageCompletedAt === 'number' && messageCompletedAt > 0
            ? messageCompletedAt
            : (typeof messageCreatedAt === 'number' && messageCreatedAt > 0 ? messageCreatedAt : null);
        if (timestamp === null) return null;

        const formatted = formatTimestampForDisplay(timestamp);
        return formatted.length > 0 ? formatted : null;
    }, [messageCompletedAt, messageCreatedAt]);

    const footerTimestampClassName = 'text-sm text-muted-foreground/60 tabular-nums flex items-center gap-1';
    const isVSCode = isVSCodeRuntime();
    const canOpenMessagePreview = !isMiniChatSurface && !isMobile && !isVSCode;

    const finalTurnActionButtons = (
        <>
            {canOpenMessagePreview && messagePreviewUrl ? (
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-muted-foreground bg-transparent hover:text-foreground hover:!bg-transparent active:!bg-transparent focus-visible:!bg-transparent focus-visible:ring-2 focus-visible:ring-primary/50"
                            aria-label={t('chat.messageBody.actions.openPreviewAria')}
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={() => {
                                const directory = effectiveDirectory
                                    ?? (typeof currentSession?.directory === 'string' ? currentSession.directory : null);
                                if (!directory) {
                                    return;
                                }
                                openContextPreview(directory, messagePreviewUrl);
                            }}
                        >
                            <RiGlobalLine className="h-4 w-4" />
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent sideOffset={6}>{t('chat.messageBody.actions.openPreview')}</TooltipContent>
                </Tooltip>
            ) : null}
            {!isMiniChatSurface ? <Tooltip>
                <TooltipTrigger asChild>
                    <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8 text-muted-foreground bg-transparent hover:text-foreground hover:!bg-transparent active:!bg-transparent focus-visible:!bg-transparent focus-visible:ring-2 focus-visible:ring-primary/50"
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={handleForkClick}
                    >
                        <RiChatNewLine className="h-4 w-4" />
                    </Button>
                </TooltipTrigger>
                <TooltipContent sideOffset={6}>{t('chat.messageBody.actions.startNewSession')}</TooltipContent>
            </Tooltip> : null}
        </>
    );
 
      return (

         <div
              ref={messageContentRef}
              className={cn(
                 'relative w-full group/message'
             )}
              style={CONTAIN_LAYOUT_STYLE}
          >
              <TextSelectionMenu containerRef={messageContentRef} />
              <div>
                 <div
                     className="message-content-text leading-relaxed overflow-hidden text-foreground/90 [&_p:last-child]:mb-0 [&_ul:last-child]:mb-0 [&_ol:last-child]:mb-0"
                 >
                    {renderedParts}
                     {showErrorMessage && (
                         <FadeInOnReveal key="assistant-error">
                             <div className={cn(
                                 'group/assistant-text relative mt-3 break-words max-w-full',
                                 errorVariant === 'plain'
                                     ? 'text-muted-foreground'
                                     : cn(
                                         'p-3 rounded-lg border',
                                         errorVariant === 'info'
                                             ? 'bg-[var(--status-info-background)] border-[var(--status-info-border)]'
                                             : 'bg-[var(--status-error-background)] border-[var(--status-error-border)]',
                                     ),
                             )}>
                                 <div className={cn(errorVariant !== 'plain' && 'flex items-start gap-2')}>
                                     {errorVariant !== 'plain' && (
                                         <ErrorIcon className={cn(
                                             'mt-0.5 h-4 w-4 shrink-0',
                                             errorVariant === 'info' ? 'text-[var(--status-info)]' : 'text-[var(--status-error)]',
                                         )} />
                                     )}
                                     <div className={cn('min-w-0 break-words', errorVariant !== 'plain' && 'flex-1')}>
                                         <SimpleMarkdownRenderer
                                             content={errorMessage ?? ''}
                                             onShowPopup={onShowPopup}
                                             className="[&_.markdown-content>*:first-child]:mt-0 [&_.markdown-content>*:last-child]:mb-0"
                                        />
                                    </div>
                                </div>
                            </div>
                        </FadeInOnReveal>
                    )}
                </div>
                <MessageFilesDisplay files={parts} onShowPopup={onShowPopup} />
                {shouldRenderStandaloneActionsAfterContent && (
                    <div className={INLINE_MESSAGE_ACTIONS_CLASS_NAME} data-message-actions="true">
                        <div className="flex items-center gap-1.5" data-message-action-group="true">
                            {messageActionButtons}
                        </div>
                    </div>
                )}
                {shouldShowTurnFooter && (
                    <div
                        className="mt-2 mb-1 flex items-center justify-start gap-1.5"
                        style={MESSAGE_FOOTER_CONTAINER_STYLE}
                    >
                        <div className="flex items-center gap-1.5" data-message-action-group="true">
                            {messageActionButtons}
                            {finalTurnActionButtons}
                        </div>
                        <div className="flex items-center gap-1.5">
                            {footerTimestamp ? (
                                <Tooltip>
                                    <TooltipTrigger asChild>
                                        <span
                                            className={footerTimestampClassName}
                                            aria-label={`Message time: ${footerTimestamp}`}
                                        >
                                            <RiTimeLine className="h-3.5 w-3.5" />
                                            <span className="message-footer__label">{footerTimestamp}</span>
                                        </span>
                                    </TooltipTrigger>
                                    <TooltipContent>{footerTimestamp}</TooltipContent>
                                </Tooltip>
                            ) : null}
                            {turnDurationText ? (
                                <Tooltip>
                                    <TooltipTrigger asChild>
                                        <span className="text-sm text-muted-foreground/60 tabular-nums flex items-center gap-1">
                                            <RiHourglassLine className="h-3.5 w-3.5" />
                                            <span className="message-footer__label">{turnDurationText}</span>
                                        </span>
                                    </TooltipTrigger>
                                    <TooltipContent>{turnDurationText}</TooltipContent>
                                </Tooltip>
                            ) : null}
                            {!isMiniChatSurface && isLastAssistantInTurn && hasStopFinish ? (
                                <TurnChangedFilesDropdown activityParts={turnGroupingContext?.activityParts} />
                            ) : null}
                        </div>
                    </div>
                )}
                {(managedTaskDispatch.taskIds.length > 0 || managedTaskDispatch.pendingDispatches.length > 0) ? (
                    <ManagedTaskList
                        taskIds={managedTaskDispatch.taskIds}
                        pendingDispatches={managedTaskDispatch.pendingDispatches}
                        onContentChange={onContentChange}
                    />
                ) : null}

            </div>
        </div>
    );
});

const MessageBody = React.memo(({ isUser, ...props }: MessageBodyProps) => {

    if (isUser) {
        return (
            <UserMessageBody
                messageId={props.messageId}
                parts={props.parts}
                isMobile={props.isMobile}
                alwaysShowActions={props.alwaysShowActions}
                hasTouchInput={props.hasTouchInput}
                hasTextContent={props.hasTextContent}
                onCopyMessage={props.onCopyMessage}
                copiedMessage={props.copiedMessage}
                onShowPopup={props.onShowPopup}
                agentMention={props.agentMention}
                onRevert={props.onRevert}
                isReverting={props.isReverting}
                onFork={props.onFork}
                userActionsMode={props.userActionsMode}
                stickyUserHeaderEnabled={props.stickyUserHeaderEnabled}
            />
        );
    }

    return <AssistantMessageBody {...props} />;
});

export default MessageBody;
