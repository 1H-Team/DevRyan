import React from 'react';
import type { ManagedTaskProjectedRecord } from '@/lib/orchestrationApi';
import { managedOrchestrationApi } from '@/lib/orchestrationApi';
import { useManagedOrchestrationStore } from '@/stores/useManagedOrchestrationStore';
import { useI18n } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

/** Execution can settle while the assigned verification remains incomplete. */
type Verification = NonNullable<ManagedTaskProjectedRecord['verification']>;

export function ManagedTaskVerification({ task }: { task: ManagedTaskProjectedRecord }) {
  const { t } = useI18n();
  return <VerificationDetails verification={task.verification} submitWaiver={async (checks, reason) => {
    if (!managedOrchestrationApi.waiveVerification) throw new Error(t('chat.managedTasks.verification.waiverFailed'));
    await managedOrchestrationApi.waiveVerification(task.taskId, { rootSessionId: task.rootSessionId, directory: task.directory, checks, reason });
    await useManagedOrchestrationStore.getState().loadSnapshot({ rootSessionId: task.rootSessionId });
    if (useManagedOrchestrationStore.getState().snapshotStateByScope[task.rootSessionId] !== 'confirmed') throw new Error(t('chat.managedTasks.verification.refreshFailed'));
  }} />;
}

export function VerificationDetails({ verification, submitWaiver }: { verification: Verification | null | undefined;
  submitWaiver: (checks: { name: string; contentHash: string }[], reason: string) => Promise<void> }) {
  const { t } = useI18n();
  const [open, setOpen] = React.useState(false);
  const [reason, setReason] = React.useState('');
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [waiverChecks, setWaiverChecks] = React.useState<{ name: string; contentHash: string }[]>([]);
  if (!verification || verification.checks.length === 0) return null;
  const remaining = verification.checks.filter((check) => check.status !== 'passed' && check.status !== 'waived' && check.status !== 'skipped');
  const waivable = remaining.flatMap((check) => check.coverage.contentHash
    ? [{ name: check.name, contentHash: check.coverage.contentHash }] : []);
  const submit = async () => {
    if (!reason.trim() || !waiverChecks.length || pending) return;
    setPending(true);
    setError(null);
    try {
      await submitWaiver(waiverChecks, reason.trim());
      setOpen(false);
      setReason('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t('chat.managedTasks.verification.waiverFailed'));
    } finally { setPending(false); }
  };
  return <div className="mt-1 space-y-1 typography-meta text-muted-foreground" data-task-verification={verification.status}>
    <ul className="space-y-1">
      {verification.checks.map((check) => <li key={check.name} className="break-words">
        {check.name}: {t(check.status === 'passed' ? 'chat.managedTasks.verification.passed'
          : check.status === 'waived' ? 'chat.managedTasks.verification.waived'
            : check.status === 'skipped' ? 'chat.managedTasks.verification.skipped'
              : check.status === 'failed' ? 'chat.managedTasks.verification.failed'
                : check.status === 'blocked' ? 'chat.managedTasks.verification.blocked'
                  : 'chat.managedTasks.verification.pending')}
        {check.purpose ? <span className="ml-1">({check.purpose})</span> : null}
        {check.prerequisites?.length ? <span className="block typography-micro">Prerequisites: {check.prerequisites.join('; ')}</span> : null}
        {check.environmentUnavailable ? <span className="block typography-micro">{check.environmentUnavailable.hint}</span> : null}
      </li>)}
    </ul>
    {verification.checks.some((check) => check.visual?.dataSource === 'fixture')
      ? <p>{t('chat.managedTasks.verification.fixtures')}</p> : null}
    {waivable.length > 0 ? <Button size="xs" variant="ghost" onClick={() => { setWaiverChecks(waivable); setError(null); setOpen(true); }}>
      {t('chat.managedTasks.verification.waive')}
    </Button> : null}
    <Dialog open={open} onOpenChange={(value) => { if (!pending) setOpen(value); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('chat.managedTasks.verification.waive')}</DialogTitle>
          <DialogDescription>{t('chat.managedTasks.verification.waiverDescription')}</DialogDescription>
        </DialogHeader>
        <p className="typography-meta">{waiverChecks.map((check) => check.name).join(', ')}</p>
        <Textarea aria-label={t('chat.managedTasks.verification.reason')} placeholder={t('chat.managedTasks.verification.reason')}
          value={reason} onChange={(event) => setReason(event.target.value)} maxLength={1000} disabled={pending} />
        {error ? <p role="alert" className="typography-meta text-[var(--status-error)]">{error}</p> : null}
        <DialogFooter>
          <Button variant="ghost" disabled={pending} onClick={() => setOpen(false)}>{t('chat.managedTasks.verification.cancel')}</Button>
          <Button disabled={pending || !reason.trim()} onClick={() => { void submit(); }}>{t('chat.managedTasks.verification.confirmWaiver')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}
