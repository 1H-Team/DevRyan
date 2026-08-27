import React from 'react';
import { RiErrorWarningLine, RiShieldCheckLine } from '@remixicon/react';
import { useShallow } from 'zustand/react/shallow';

import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { useBotOperationsStore, type BotOperationsStore } from '@/stores/useBotOperationsStore';
import { useBotOperationsNavigationStore } from '@/stores/useBotOperationsNavigationStore';
import { cn } from '@/lib/utils';
import { describeBotActionTarget, resolveBotApprovalAccess } from '../botPresentation';

type BotApprovalsTabProps = {
  botId: string;
  active?: boolean;
  canOperate: boolean;
  principalId: string | null;
  operationsStore?: BotOperationsStore;
};

const ApprovalRow: React.FC<{
  actionId: string;
  active: boolean;
  canOperate: boolean;
  principalId: string | null;
  operationsStore: BotOperationsStore;
}> = ({ actionId, active, canOperate, principalId, operationsStore }) => {
  const { t } = useI18n();
  const action = operationsStore((state) => state.actionsById[actionId]);
  const pending = operationsStore((state) => state.decisionPendingByActionId[actionId] === true);
  const error = operationsStore((state) => state.actionErrorCodeById[actionId]);
  const focused = useBotOperationsNavigationStore((state) => (
    state.tab === 'approvals' && state.focusedActionId === actionId
  ));
  const rowRef = React.useRef<HTMLLIElement>(null);
  React.useLayoutEffect(() => {
    if (!active || !focused || !rowRef.current) return;
    rowRef.current.scrollIntoView({ block: 'nearest' });
    rowRef.current.focus({ preventScroll: true });
  }, [active, focused]);
  if (!action) return null;

  const reconcile = action.unknownOutcome || action.state === 'needs_reconciliation';
  const expired = !reconcile && Date.parse(action.decisionExpiresAt) <= Date.now();
  const approvalAccess = resolveBotApprovalAccess({ action, principalId, isMember: canOperate });
  const canDecide = reconcile ? canOperate : approvalAccess.allowed;
  const blockedMessageKey = reconcile
    ? 'bots.operations.approvals.membershipRequired'
    : approvalAccess.blockedMessageKey;
  const decide = async (decision: 'approved' | 'denied') => {
    await operationsStore.getState().decideAction(action.id, {
      actionHash: action.actionHash,
      revisionId: action.revisionId,
      argsDigest: action.argsDigest,
      decision,
    });
  };
  const reconcileAs = async (decision: 'complete' | 'retry_new' | 'abandon') => {
    await operationsStore.getState().reconcileAction(action.id, {
      actionHash: action.actionHash,
      revisionId: action.revisionId,
      argsDigest: action.argsDigest,
      decision,
    });
  };

  return (
    <li
      ref={rowRef}
      tabIndex={-1}
      className={cn(
        'border-b border-border/50 py-3 outline-none last:border-b-0',
        focused && 'rounded-md bg-interactive-selection px-2 ring-2 ring-primary/60',
      )}
      data-bot-approval-action-id={action.id}
      aria-current={focused ? 'true' : undefined}
    >
      <div className="flex items-start gap-2">
        {reconcile ? (
          <RiErrorWarningLine className="mt-0.5 h-4 w-4 shrink-0 text-[var(--status-warning)]" aria-hidden />
        ) : (
          <RiShieldCheckLine className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate typography-ui-label font-medium text-foreground">
            {action.tool} · {action.action}
          </p>
          <p className="mt-0.5 break-words typography-micro text-muted-foreground">
            {describeBotActionTarget(action)} · {t(`bots.operations.risk.${action.risk}`)}
          </p>
          {expired ? (
            <p className="mt-1 typography-micro text-[var(--status-warning)]">{t('bots.operations.approvals.expired')}</p>
          ) : null}
          {error ? (
            <p className="mt-1 typography-micro text-[var(--status-error)]" role="alert">{t('bots.operations.approvals.failed')}</p>
          ) : null}
        </div>
      </div>
      {canDecide ? (
        <div className="mt-2 flex flex-wrap justify-end gap-1.5">
          {reconcile ? (
            <>
              <Button type="button" variant="outline" size="xs" onClick={() => void reconcileAs('complete').catch(() => undefined)}>{t('bots.operations.reconcile.complete')}</Button>
              <Button type="button" variant="outline" size="xs" onClick={() => void reconcileAs('retry_new').catch(() => undefined)}>{t('bots.operations.reconcile.retry')}</Button>
              <Button type="button" variant="destructive" size="xs" onClick={() => void reconcileAs('abandon').catch(() => undefined)}>{t('bots.operations.reconcile.abandon')}</Button>
            </>
          ) : (
            <>
              <Button type="button" variant="outline" size="xs" disabled={pending || expired} onClick={() => void decide('denied').catch(() => undefined)}>{t('bots.operations.approvals.deny')}</Button>
              <Button type="button" size="xs" disabled={pending || expired} onClick={() => void decide('approved').catch(() => undefined)}>{pending ? t('bots.operations.approvals.deciding') : t('bots.operations.approvals.approve')}</Button>
            </>
          )}
        </div>
      ) : (
        <p className="mt-2 typography-micro text-muted-foreground">
          {t(blockedMessageKey ?? 'bots.operations.approvals.unavailable')}
        </p>
      )}
    </li>
  );
};

export const BotApprovalsTab: React.FC<BotApprovalsTabProps> = ({
  botId,
  active = true,
  canOperate,
  principalId,
  operationsStore = useBotOperationsStore,
}) => {
  const { t } = useI18n();
  const actionIds = operationsStore(useShallow((state) => Object.values(state.actionsById)
    .filter((action) => action.botId === botId && (
      action.state === 'pending_approval'
      || action.state === 'needs_reconciliation'
      || action.unknownOutcome
    ))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .map((action) => action.id)));

  if (actionIds.length === 0) {
    return (
      <div className="px-4 py-10 text-center">
        <p className="typography-ui-label text-foreground">{t('bots.operations.approvals.emptyTitle')}</p>
        <p className="mt-1 typography-meta text-muted-foreground">{t('bots.operations.approvals.emptyDescription')}</p>
      </div>
    );
  }

  return (
    <ul className="px-4" aria-label={t('bots.operations.approvals.listAria')}>
      {actionIds.map((actionId) => (
        <ApprovalRow
          key={actionId}
          actionId={actionId}
          active={active}
          canOperate={canOperate}
          principalId={principalId}
          operationsStore={operationsStore}
        />
      ))}
    </ul>
  );
};
