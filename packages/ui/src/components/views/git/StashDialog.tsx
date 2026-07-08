import React from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { toast } from '@/components/ui';
import { RiAlertLine, RiLoader4Line } from '@remixicon/react';
import { useI18n } from '@/lib/i18n';

interface StashDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  operation: 'merge' | 'rebase' | 'checkout';
  targetBranch: string;
  onConfirm: (restoreAfter: boolean) => Promise<void>;
  finishBranchAction?: {
    onConfirm: (restoreAfter: boolean) => Promise<void>;
    disabled?: boolean;
  };
}

export const StashDialog: React.FC<StashDialogProps> = ({
  open,
  onOpenChange,
  operation,
  targetBranch,
  onConfirm,
  finishBranchAction,
}) => {
  const { t } = useI18n();
  const [restoreAfter, setRestoreAfter] = React.useState(true);
  const [processingAction, setProcessingAction] = React.useState<'primary' | 'finish' | null>(null);
  const isProcessing = processingAction !== null;

  const operationLabel = operation === 'merge'
    ? t('gitView.operation.merge')
    : operation === 'rebase'
      ? t('gitView.operation.rebase')
      : t('gitView.operation.checkout');

  const handleConfirm = async () => {
    setProcessingAction('primary');
    try {
      await onConfirm(restoreAfter);
      onOpenChange(false);
    } catch (err) {
      // Show error to user - parent may also handle it but user should see feedback
      const message = err instanceof Error ? err.message : t('gitView.stash.failed', { operation: operationLabel });
      toast.error(message);
    } finally {
      setProcessingAction(null);
    }
  };

  const handleFinishBranch = async () => {
    if (!finishBranchAction) return;
    setProcessingAction('finish');
    try {
      await finishBranchAction.onConfirm(restoreAfter);
      onOpenChange(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : t('gitView.stash.finishIntoMainFailed');
      toast.error(message);
    } finally {
      setProcessingAction(null);
    }
  };

  const handleCancel = () => {
    if (!isProcessing) {
      onOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={isProcessing ? undefined : onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <RiAlertLine className="size-5 text-[var(--status-warning)]" />
            <DialogTitle>{t('gitView.stash.title')}</DialogTitle>
          </div>
          <DialogDescription>
            {t('gitView.stash.description', { operation })}
          </DialogDescription>
        </DialogHeader>

        <div className="py-2">
          <p className="typography-meta text-muted-foreground mb-3">
            {t('gitView.stash.thisWill')}
          </p>
          <ol className="list-decimal list-inside space-y-1 typography-meta text-foreground">
            <li>{t('gitView.stash.stepStash')}</li>
            <li>
              {operation === 'merge'
                ? t('gitView.stash.stepMerge')
                : operation === 'rebase'
                  ? t('gitView.stash.stepRebase')
                  : t('gitView.stash.stepCheckout')}{' '}
              <span className="font-mono text-primary">{targetBranch}</span>
            </li>
            {restoreAfter && <li>{t('gitView.stash.stepRestore')}</li>}
          </ol>
        </div>

        {finishBranchAction ? (
          <div className="rounded-md border border-border/60 bg-interactive-hover/30 px-3 py-2">
            <p className="typography-meta text-foreground">
              {t('gitView.stash.finishIntoMainDescription')}
            </p>
          </div>
        ) : null}

        <div className="flex items-center gap-2 py-2">
          <Checkbox
            checked={restoreAfter}
            onChange={setRestoreAfter}
            disabled={isProcessing}
            ariaLabel={finishBranchAction ? t('gitView.stash.restoreAfterSelectedActionAria') : t('gitView.stash.restoreAria')}
          />
          <span
            className="typography-ui-label text-foreground cursor-pointer select-none"
            onClick={() => !isProcessing && setRestoreAfter(!restoreAfter)}
          >
            {finishBranchAction
              ? t('gitView.stash.restoreAfterSelectedAction')
              : t('gitView.stash.restoreAfterOperation', { operation })}
          </span>
        </div>

        <DialogFooter className="gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleCancel}
            disabled={isProcessing}
          >
            {t('gitView.common.cancel')}
          </Button>
          {finishBranchAction ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={handleFinishBranch}
              disabled={isProcessing || finishBranchAction.disabled}
              className="gap-1.5"
            >
              {processingAction === 'finish' ? (
                <>
                  <RiLoader4Line className="size-4 animate-spin" />
                  {t('gitView.common.processing')}
                </>
              ) : (
                t('gitView.stash.finishIntoMainButton')
              )}
            </Button>
          ) : null}
          <Button
            variant="default"
            size="sm"
            onClick={handleConfirm}
            disabled={isProcessing}
            className="gap-1.5"
          >
            {processingAction === 'primary' ? (
              <>
                <RiLoader4Line className="size-4 animate-spin" />
                {t('gitView.common.processing')}
              </>
            ) : (
              t('gitView.stash.confirmButton', { operation: operationLabel })
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
