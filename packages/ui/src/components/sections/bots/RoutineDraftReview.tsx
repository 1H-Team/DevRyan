import React from 'react';
import { RiAlarmWarningLine, RiCheckboxCircleLine, RiShieldCheckLine } from '@remixicon/react';

import { Button } from '@/components/ui/button';
import type { BotRoutineContract } from '@/lib/botsApi';

export type RoutineDraftReviewProps = {
  contract: BotRoutineContract;
  title?: string;
  actionLabel: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

const triggerLabel = (contract: BotRoutineContract): string => {
  const { trigger } = contract;
  if (trigger.kind === 'daily') return `Daily at ${trigger.time}`;
  if (trigger.kind === 'weekly') {
    return `Weekly on ${trigger.weekdays.join(', ')} at ${trigger.time}`;
  }
  if (trigger.kind === 'once') return `Once at ${trigger.localDateTime}`;
  return `Cron ${trigger.expression}`;
};

export const RoutineDraftReview: React.FC<RoutineDraftReviewProps> = ({
  contract,
  title = 'Review the executable contract',
  actionLabel,
  busy = false,
  onConfirm,
  onCancel,
}) => {
  const headingId = React.useId();
  const confirmationId = React.useId();
  const [confirmed, setConfirmed] = React.useState(false);
  React.useEffect(() => setConfirmed(false), [contract]);
  const writes = contract.limits.maxExternalWrites > 0;

  return (
    <section className="space-y-4 rounded-xl border border-primary/25 bg-primary/[0.035] p-4" aria-labelledby={headingId}>
      <div className="flex items-start gap-3">
        <div className="rounded-lg border border-primary/20 bg-primary/10 p-2 text-primary">
          <RiShieldCheckLine className="h-4 w-4" aria-hidden />
        </div>
        <div>
          <h4 id={headingId} className="typography-ui-header font-semibold text-foreground">{title}</h4>
          <p className="mt-1 typography-meta text-muted-foreground">
            Check the schedule and outcome before this routine is activated.
          </p>
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {[
          ['Trigger', triggerLabel(contract)],
          ['Timezone', contract.timezone],
          ['Timeout', `${contract.timeoutSeconds} seconds`],
          ['Recovery', `${contract.missedPolicy} · cap ${contract.missedRunCap}`],
        ].map(([label, value]) => (
          <div key={label} className="rounded-lg border border-border/65 bg-background/75 px-3 py-2">
            <div className="typography-micro uppercase tracking-wide text-muted-foreground">{label}</div>
            <div className="mt-0.5 break-words typography-ui-label font-medium text-foreground">{value}</div>
          </div>
        ))}
      </div>

      <div className="space-y-3 rounded-lg border border-border/65 bg-background/75 p-3">
        <div>
          <div className="typography-micro uppercase tracking-wide text-muted-foreground">Goal</div>
          <p className="mt-1 whitespace-pre-wrap typography-ui text-foreground">{contract.goal}</p>
        </div>
        <div>
          <div className="typography-micro uppercase tracking-wide text-muted-foreground">Completion criteria</div>
          <ul className="mt-1 list-disc space-y-1 pl-4 typography-meta text-foreground">
            {contract.completionCriteria.map((criterion) => <li key={criterion}>{criterion}</li>)}
          </ul>
        </div>
      </div>

      {writes ? (
        <div className="flex items-start gap-2 rounded-lg border border-[var(--status-warning)]/35 bg-[var(--status-warning)]/10 px-3 py-2 typography-meta text-foreground">
          <RiAlarmWarningLine className="mt-0.5 h-4 w-4 shrink-0 text-[var(--status-warning)]" aria-hidden />
          Consequential actions pause and ask the requesting user for confirmation.
        </div>
      ) : (
        <div className="flex items-center gap-2 rounded-lg border border-[var(--status-success)]/25 bg-[var(--status-success)]/10 px-3 py-2 typography-meta text-foreground">
          <RiCheckboxCircleLine className="h-4 w-4 text-[var(--status-success)]" aria-hidden /> Read-only routine contract.
        </div>
      )}

      <p className="typography-meta text-muted-foreground">
        <span className="font-medium text-foreground">Rationale:</span> {contract.rationale}
      </p>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/65 pt-3">
        <div className="flex max-w-3xl items-start gap-2 typography-meta text-foreground">
          <input
            aria-labelledby={confirmationId}
            type="checkbox"
            className="mt-0.5 h-4 w-4 rounded border-input accent-primary"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          <span id={confirmationId}>I reviewed this routine's schedule, goal, and completion criteria.</span>
        </div>
        <div className="flex gap-2">
          <Button type="button" size="xs" variant="ghost" disabled={busy} onClick={onCancel}>Cancel</Button>
          <Button type="button" size="xs" disabled={busy || !confirmed} onClick={onConfirm}>{actionLabel}</Button>
        </div>
      </div>
    </section>
  );
};
