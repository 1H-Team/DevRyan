import * as React from 'react';

import { ContextUsageDisplay } from '@/components/ui/ContextUsageDisplay';
import { useProviderBackedContextUsage } from '@/hooks/useProviderBackedContextUsage';
import { useStableSessionContextUsage } from '@/hooks/useStableSessionContextUsage';
import { resolveContextUsageAvailability } from '@/lib/contextUsagePresentation';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores/useConfigStore';
import { getProviderContextUsageFromMessages } from '@/stores/utils/contextUsageUtils';
import {
    useDirectorySync,
    useEnsureSessionChildren,
    useSessionChildren,
    useSessionMessageRecords,
    useSessionMessagesResolved,
    useSyncResyncSession,
} from '@/sync/sync-context';
import { useSessionUIStore } from '@/sync/session-ui-store';

import { ContextUsageWindow } from './ContextUsageWindow';

interface ComposerContextUsageControlProps {
    sessionId: string | null;
    directory: string | null;
    footerIconButtonClass: string;
    iconSizeClass: string;
    onCompact: (sessionId: string) => void;
}

export const ComposerContextUsageControl = React.memo<ComposerContextUsageControlProps>(({
    sessionId,
    directory,
    footerIconButtonClass,
    iconSizeClass,
    onCompact,
}) => {
    const [open, setOpen] = React.useState(false);
    const triggerRef = React.useRef<HTMLButtonElement>(null);
    const providers = useConfigStore((state) => state.providers);
    const getContextUsageForSession = useSessionUIStore((state) => state.getContextUsageForSession);
    const messages = useSessionMessageRecords(
        sessionId ?? '',
        directory ?? undefined,
        { contextUsagePartsOnly: true },
    );
    const messagesResolved = useSessionMessagesResolved(sessionId ?? '', directory ?? undefined);
    const childSessionsSnapshot = useSessionChildren(
        open ? sessionId : null,
        directory ?? undefined,
    );
    const childMessagesSnapshot = useDirectorySync(
        React.useCallback((state) => (open ? state.message : null), [open]),
        directory ?? undefined,
    );

    const messageUsage = React.useMemo(() => (
        getProviderContextUsageFromMessages(messages, providers)
    ), [messages, providers]);
    const fallbackUsage = React.useMemo(() => {
        if (!open) return messageUsage;
        void childSessionsSnapshot;
        void childMessagesSnapshot;
        return getContextUsageForSession(sessionId, directory) ?? messageUsage;
    }, [
        childMessagesSnapshot,
        childSessionsSnapshot,
        directory,
        getContextUsageForSession,
        messageUsage,
        open,
        sessionId,
    ]);
    const providerBackedUsage = useProviderBackedContextUsage({
        sessionID: sessionId,
        directory,
        fallback: fallbackUsage,
    });
    const resolved = !sessionId || messagesResolved;
    const usage = useStableSessionContextUsage({
        directory,
        sessionId,
        usage: providerBackedUsage,
        resolved,
    });
    const availability = resolveContextUsageAvailability({
        sessionId,
        usage,
        resolved,
    });

    useEnsureSessionChildren(
        sessionId ?? undefined,
        directory ?? undefined,
        open && Boolean(sessionId),
    );
    // Child sessions and their messages are loaded only while the panel is
    // open. These subscriptions stay in this leaf so unrelated composer
    // controls do not repaint as subagent data arrives.
    React.useEffect(() => {
        if (!sessionId) setOpen(false);
    }, [sessionId]);

    const resyncSession = useSyncResyncSession();
    const handleExpandSubagentSession = React.useCallback((childSessionId: string) => {
        void resyncSession(childSessionId, { reason: 'manual' }).catch(() => undefined);
    }, [resyncSession]);
    const handleCompact = React.useCallback(() => {
        if (!sessionId || availability !== 'available') return;
        setOpen(false);
        onCompact(sessionId);
    }, [availability, onCompact, sessionId]);

    return (
        <>
            {open ? (
                <ContextUsageWindow
                    usage={usage}
                    availability={availability}
                    onClose={() => setOpen(false)}
                    onCompact={availability === 'available' && sessionId ? handleCompact : undefined}
                    onExpandSession={handleExpandSubagentSession}
                    triggerRef={triggerRef}
                />
            ) : null}
            <ContextUsageDisplay
                buttonRef={triggerRef}
                usage={usage}
                availability={availability}
                size="compact"
                hideIcon
                hideValue
                showPercentIcon
                onClick={() => setOpen((previous) => !previous)}
                pressed={open}
                className={cn(footerIconButtonClass, 'rounded-md gap-0 p-0')}
                percentIconClassName={cn(iconSizeClass, 'text-[var(--status-info)]')}
            />
        </>
    );
});

ComposerContextUsageControl.displayName = 'ComposerContextUsageControl';
