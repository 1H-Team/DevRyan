import React from 'react';
import { Button } from '@/components/ui/button';
import { formatBytes } from '@/lib/formatBytes';
import { useI18n } from '@/lib/i18n';
import { useSessionMessageLoader } from '@/sync/sync-context';
import { getOmittedToolOutputBytes, type OmittedToolPart } from '@/sync/tool-output';

/**
 * Shown, while expanded, for a history row whose output the page left out.
 * Mounting loads the full message; the row re-renders with real output once
 * the store holds it, so no stand-in output is ever displayed.
 */
export const OmittedToolOutput: React.FC<{ part: OmittedToolPart }> = ({ part }) => {
    const { t } = useI18n();
    const loader = useSessionMessageLoader();
    const [attempt, setAttempt] = React.useState(0);
    const [failed, setFailed] = React.useState(false);
    const bytes = getOmittedToolOutputBytes(part);

    React.useEffect(() => {
        let current = true;
        setFailed(false);
        loader.loadToolOutput({ sessionID: part.sessionID, messageID: part.messageID }).catch(() => {
            if (current) setFailed(true);
        });
        return () => { current = false; };
    }, [attempt, loader, part.messageID, part.sessionID]);

    if (failed) {
        return (
            <div className="flex items-center gap-2 typography-meta text-muted-foreground/70">
                <span>{t('chat.toolPart.outputLoadFailed')}</span>
                <Button type="button" variant="ghost" size="xs" onClick={() => setAttempt((value) => value + 1)}>
                    {t('chat.toolPart.outputLoadRetry')}
                </Button>
            </div>
        );
    }

    return (
        <div className="typography-meta text-muted-foreground/70" role="status">
            {bytes === undefined
                ? t('chat.toolPart.outputLoading')
                : t('chat.toolPart.outputLoadingSize', { size: formatBytes(bytes) })}
        </div>
    );
};
