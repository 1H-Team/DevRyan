import React from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { opencodeClient, ScopedRevertError } from '@/lib/opencode/client';
import { useI18n } from '@/lib/i18n';

export function SessionChangesDiffDialog({ rootSessionID, directory, revision, file, onClose }: {
    rootSessionID: string; directory: string; revision: string; file: string; onClose: () => void;
}) {
    const { t } = useI18n();
    const [patch, setPatch] = React.useState<string | null>(null);
    const [error, setError] = React.useState<'failed' | 'expired' | null>(null);
    React.useEffect(() => {
        const controller = new AbortController();
        void opencodeClient.getSessionChangesDiff(rootSessionID, directory, revision, file, controller.signal)
            .then((value) => { if (!controller.signal.aborted) setPatch(value); })
            .catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof ScopedRevertError && cause.code === 'summary_detail_expired' ? 'expired' : 'failed'); });
        return () => controller.abort();
    }, [rootSessionID, directory, revision, file]);
    return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
        <DialogContent className="max-w-4xl">
            <DialogHeader>
                <DialogTitle>{t('chat.sessionChanges.diffTitle', { file })}</DialogTitle>
                <DialogDescription>{t('chat.sessionChanges.diffDescription')}</DialogDescription>
            </DialogHeader>
            {patch !== null ? <pre className="max-h-[65vh] overflow-auto rounded-md bg-muted p-3 font-mono text-xs" tabIndex={0}>{patch}</pre>
                : <p role="status">{t(error === 'expired' ? 'chat.sessionChanges.detailExpired' : error ? 'chat.sessionChanges.loadFailed' : 'chat.sessionChanges.loading')}</p>}
        </DialogContent>
    </Dialog>;
}
