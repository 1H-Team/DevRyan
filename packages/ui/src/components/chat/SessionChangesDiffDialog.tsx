import React from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { opencodeClient, ScopedRevertError, type SessionChangesDiffPage } from '@/lib/opencode/client';
import { useI18n } from '@/lib/i18n';
import { useAuthPrincipal } from '@/lib/authSession';

export function SessionChangesDiffDialog({ rootSessionID, directory, revision, file, onClose }: {
    rootSessionID: string; directory: string; revision: string; file: string; onClose: () => void;
}) {
    const { t } = useI18n();
    const principal = useAuthPrincipal();
    const identity = JSON.stringify([opencodeClient.getBaseUrl(), principal.id, rootSessionID, directory, revision, file]);
    const [selection, setSelection] = React.useState<{ identity: string; cursor: string | null; segment: number | null }>({ identity, cursor: null, segment: null });
    const cursor = selection.identity === identity ? selection.cursor : null;
    const segment = selection.identity === identity ? selection.segment : null;
    const queryKey = JSON.stringify([identity, cursor, segment]);
    const [result, setResult] = React.useState<{ key: string; page: SessionChangesDiffPage } | null>(null);
    const [failure, setFailure] = React.useState<{ key: string; kind: 'failed' | 'expired' } | null>(null);
    const page = result?.key === queryKey ? result.page : null;
    const error = failure?.key === queryKey ? failure.kind : null;
    React.useEffect(() => {
        const controller = new AbortController();
        setFailure(null);
        void opencodeClient.getSessionChangesDiffPage(rootSessionID, directory, revision, file, cursor, controller.signal, segment)
            .then((value) => { if (!controller.signal.aborted) setResult({ key: queryKey, page: value }); })
            .catch((cause) => { if (!controller.signal.aborted) setFailure({ key: queryKey, kind: cause instanceof ScopedRevertError && cause.code === 'summary_detail_expired' ? 'expired' : 'failed' }); });
        return () => controller.abort();
    }, [rootSessionID, directory, revision, file, cursor, segment, queryKey]);
    return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
        <DialogContent className="max-w-4xl">
            <DialogHeader>
                <DialogTitle>{t('chat.sessionChanges.diffTitle', { file })}</DialogTitle>
                <DialogDescription>{t('chat.sessionChanges.diffDescription')}</DialogDescription>
            </DialogHeader>
            {page ? <>
                {page.reviewMode === 'segments' ? <nav className="flex flex-wrap items-center justify-between gap-2" aria-label={t('chat.sessionChanges.segmentPages')}>
                    <Button size="xs" variant="ghost" disabled={(page.segmentIndex ?? 0) === 0} onClick={() => setSelection({ identity, cursor: null, segment: (page.segmentIndex ?? 0) - 1 })}>{t('chat.sessionChanges.previousEdit')}</Button>
                    <span className="typography-meta text-muted-foreground">{t('chat.sessionChanges.segment', { edit: (page.segmentIndex ?? 0) + 1, count: page.segmentCount ?? 1 })}</span>
                    <Button size="xs" variant="ghost" disabled={(page.segmentIndex ?? 0) + 1 >= (page.segmentCount ?? 1)} onClick={() => setSelection({ identity, cursor: null, segment: (page.segmentIndex ?? 0) + 1 })}>{t('chat.sessionChanges.nextEdit')}</Button>
                </nav> : null}
                <pre className="max-h-[65vh] overflow-auto rounded-md bg-muted p-3 font-mono text-xs" tabIndex={0}>{page.patch}</pre>
                {page.pageIndex > 0 || page.nextCursor ? <nav className="flex items-center justify-between gap-2" aria-label={t('chat.sessionChanges.diffPages')}>
                    <Button size="xs" variant="ghost" disabled={page.pageIndex === 0} onClick={() => setSelection({ identity, cursor: page.previousCursor, segment })}>{t('chat.sessionChanges.previousPage')}</Button>
                    <span className="typography-meta text-muted-foreground">{t('chat.sessionChanges.page', { page: page.pageIndex + 1 })}</span>
                    <Button size="xs" variant="ghost" disabled={!page.nextCursor} onClick={() => setSelection({ identity, cursor: page.nextCursor, segment })}>{t('chat.sessionChanges.nextPage')}</Button>
                </nav> : null}
            </> : <p role="status">{t(error === 'expired' ? 'chat.sessionChanges.detailExpired' : error ? 'chat.sessionChanges.loadFailed' : 'chat.sessionChanges.loading')}</p>}
        </DialogContent>
    </Dialog>;
}
