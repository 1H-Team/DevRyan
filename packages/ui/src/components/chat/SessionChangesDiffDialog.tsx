import React from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { opencodeClient, ScopedRevertError, type SessionChangesDiffPage } from '@/lib/opencode/client';
import { useI18n } from '@/lib/i18n';

export function SessionChangesDiffDialog({ rootSessionID, directory, revision, file, onClose }: {
    rootSessionID: string; directory: string; revision: string; file: string; onClose: () => void;
}) {
    const { t } = useI18n();
    const identity = JSON.stringify([rootSessionID, directory, revision, file]);
    const [selection, setSelection] = React.useState<{ identity: string; cursor: string | null }>({ identity, cursor: null });
    const [result, setResult] = React.useState<{ identity: string; cursor: string | null; page: SessionChangesDiffPage } | null>(null);
    const [error, setError] = React.useState<'failed' | 'expired' | null>(null);
    const cursor = selection.identity === identity ? selection.cursor : null;
    const page = result?.identity === identity && result.cursor === cursor ? result.page : null;
    React.useEffect(() => {
        const controller = new AbortController();
        setError(null);
        void opencodeClient.getSessionChangesDiffPage(rootSessionID, directory, revision, file, cursor, controller.signal)
            .then((value) => { if (!controller.signal.aborted) setResult({ identity, cursor, page: value }); })
            .catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof ScopedRevertError && cause.code === 'summary_detail_expired' ? 'expired' : 'failed'); });
        return () => controller.abort();
    }, [rootSessionID, directory, revision, file, cursor, identity]);
    return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
        <DialogContent className="max-w-4xl">
            <DialogHeader>
                <DialogTitle>{t('chat.sessionChanges.diffTitle', { file })}</DialogTitle>
                <DialogDescription>{t('chat.sessionChanges.diffDescription')}</DialogDescription>
            </DialogHeader>
            {page ? <>
                <pre className="max-h-[65vh] overflow-auto rounded-md bg-muted p-3 font-mono text-xs" tabIndex={0}>{page.patch}</pre>
                {page.pageIndex > 0 || page.nextCursor ? <nav className="flex items-center justify-between gap-2" aria-label={t('chat.sessionChanges.diffPages')}>
                    <Button size="xs" variant="ghost" disabled={page.pageIndex === 0} onClick={() => setSelection({ identity, cursor: page.previousCursor })}>{t('chat.sessionChanges.previousPage')}</Button>
                    <span className="typography-meta text-muted-foreground">{t('chat.sessionChanges.page', { page: page.pageIndex + 1 })}</span>
                    <Button size="xs" variant="ghost" disabled={!page.nextCursor} onClick={() => setSelection({ identity, cursor: page.nextCursor })}>{t('chat.sessionChanges.nextPage')}</Button>
                </nav> : null}
            </> : <p role="status">{t(error === 'expired' ? 'chat.sessionChanges.detailExpired' : error ? 'chat.sessionChanges.loadFailed' : 'chat.sessionChanges.loading')}</p>}
        </DialogContent>
    </Dialog>;
}
