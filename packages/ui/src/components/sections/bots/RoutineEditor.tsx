import React from 'react';
import { RiCalendarScheduleLine } from '@remixicon/react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { BotRoutineContract, BotRoutineTrigger } from '@/lib/botsApi';

export type RoutineEditorProps = {
  initialName: string;
  initialContract: BotRoutineContract;
  busy?: boolean;
  onSave: (name: string, contract: BotRoutineContract) => void;
  onCancel: () => void;
};

const textareaClass = 'min-h-24 w-full resize-y rounded-lg border border-input bg-background px-2.5 py-2 typography-ui text-foreground outline-none transition-shadow placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-primary/40';
const selectClass = 'h-8 w-full rounded-lg border border-input bg-background px-2 typography-ui-label text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary/40';

const listText = (values: readonly string[]): string => values.join('\n');
const parseList = (value: string): string[] => [...new Set(value
  .split(/[\n,]/u)
  .map((item) => item.trim())
  .filter(Boolean))];

const tomorrowAtNine = (): string => {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  date.setHours(9, 0, 0, 0);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T09:00`;
};

const defaultTrigger = (kind: BotRoutineTrigger['kind']): BotRoutineTrigger => {
  if (kind === 'daily') return { kind, time: '09:00' };
  if (kind === 'weekly') return { kind, time: '09:00', weekdays: [1] };
  if (kind === 'once') return { kind, localDateTime: tomorrowAtNine() };
  return { kind, expression: '0 9 * * 1-5' };
};

const Field: React.FC<React.PropsWithChildren<{ label: string; hint?: string }>> = ({
  label,
  hint,
  children,
}) => (
  <label className="space-y-1 typography-meta text-muted-foreground">
    <span className="font-medium text-foreground">{label}</span>
    {children}
    {hint ? <span className="block typography-micro text-muted-foreground">{hint}</span> : null}
  </label>
);

export const RoutineEditor: React.FC<RoutineEditorProps> = ({
  initialName,
  initialContract,
  busy = false,
  onSave,
  onCancel,
}) => {
  const [name, setName] = React.useState(initialName);
  const [value, setValue] = React.useState<BotRoutineContract>(() => structuredClone(initialContract));
  const [feedback, setFeedback] = React.useState<string | null>(null);

  const update = <K extends keyof BotRoutineContract,>(key: K, next: BotRoutineContract[K]) => {
    setValue((current) => ({ ...current, [key]: next }));
  };

  const updateTrigger = (next: BotRoutineTrigger) => update('trigger', next);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim() || !value.goal.trim() || value.completionCriteria.length === 0) {
      setFeedback('Name, goal, and at least one completion criterion are required.');
      return;
    }
    setFeedback(null);
    onSave(name.trim(), {
      ...value,
      approvalClass: value.limits.maxExternalWrites > 0 ? 'requester' : 'none',
    });
  };

  return (
    <form className="space-y-5 rounded-xl border border-border/70 bg-background p-4" onSubmit={submit} aria-labelledby="routine-editor-heading">
      <div className="flex items-start gap-3">
        <div className="rounded-lg border border-border/70 bg-[var(--surface-subtle)]/50 p-2 text-muted-foreground">
          <RiCalendarScheduleLine className="h-4 w-4" aria-hidden />
        </div>
        <div>
          <h4 id="routine-editor-heading" className="typography-ui-header font-semibold text-foreground">Routine details</h4>
          <p className="mt-1 typography-meta text-muted-foreground">Choose when it runs, what it should do, and what success looks like.</p>
        </div>
      </div>

      {feedback ? <p role="alert" className="rounded-lg border border-[var(--status-error)]/35 bg-[var(--status-error)]/10 px-3 py-2 typography-ui text-foreground">{feedback}</p> : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Routine name"><Input value={name} onChange={(event) => setName(event.target.value)} maxLength={160} /></Field>
        <Field label="IANA timezone" hint="For example: Africa/Casablanca or America/New_York">
          <Input value={value.timezone} onChange={(event) => update('timezone', event.target.value)} maxLength={120} />
        </Field>
      </div>

      <div className="grid gap-3 rounded-lg border border-border/65 bg-[var(--surface-subtle)]/20 p-3 sm:grid-cols-3">
        <Field label="Trigger type">
          <select
            className={selectClass}
            value={value.trigger.kind}
            onChange={(event) => updateTrigger(defaultTrigger(event.target.value as BotRoutineTrigger['kind']))}
          >
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="cron">Five-field cron</option>
            <option value="once">Once</option>
          </select>
        </Field>
        {value.trigger.kind === 'daily' || value.trigger.kind === 'weekly' ? (
          <Field label="Local time">
            <Input
              type="time"
              value={value.trigger.time}
              onChange={(event) => updateTrigger(value.trigger.kind === 'weekly'
                ? { kind: 'weekly', time: event.target.value, weekdays: value.trigger.weekdays }
                : { kind: 'daily', time: event.target.value })}
            />
          </Field>
        ) : null}
        {value.trigger.kind === 'cron' ? (
          <Field label="Cron expression" hint="Minute hour day month weekday">
            <Input value={value.trigger.expression} onChange={(event) => updateTrigger({ kind: 'cron', expression: event.target.value })} />
          </Field>
        ) : null}
        {value.trigger.kind === 'once' ? (
          <Field label="Local date and time">
            <Input type="datetime-local" value={value.trigger.localDateTime} onChange={(event) => updateTrigger({ kind: 'once', localDateTime: event.target.value })} />
          </Field>
        ) : null}
        <Field label="Timeout (seconds)"><Input type="number" min={60} max={3600} value={value.timeoutSeconds} onChange={(event) => update('timeoutSeconds', Number(event.target.value))} /></Field>
        {value.trigger.kind === 'weekly' ? (
          <div className="sm:col-span-3">
            <span className="typography-meta font-medium text-foreground">Weekdays</span>
            <div className="mt-1 flex flex-wrap gap-2">
              {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((label, index) => {
                const day = index + 1;
                const checked = value.trigger.kind === 'weekly' && value.trigger.weekdays.includes(day);
                return (
                  <label key={label} className="flex items-center gap-1.5 rounded-md border border-border/70 px-2 py-1 typography-meta text-foreground">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(event) => {
                        if (value.trigger.kind !== 'weekly') return;
                        const weekdays = event.target.checked
                          ? [...value.trigger.weekdays, day].sort((left, right) => left - right)
                          : value.trigger.weekdays.filter((weekday) => weekday !== day);
                        updateTrigger({ ...value.trigger, weekdays });
                      }}
                    />
                    {label}
                  </label>
                );
              })}
            </div>
          </div>
        ) : null}
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <Field label="Goal"><textarea className={textareaClass} value={value.goal} onChange={(event) => update('goal', event.target.value)} /></Field>
        <Field label="Rationale" hint="Context only; this field never grants authority."><textarea className={textareaClass} value={value.rationale} onChange={(event) => update('rationale', event.target.value)} /></Field>
        <Field label="Completion criteria" hint="One measurable criterion per line.">
          <textarea className={textareaClass} value={listText(value.completionCriteria)} onChange={(event) => update('completionCriteria', parseList(event.target.value))} />
        </Field>
      </div>

      <div className="flex justify-end gap-2 border-t border-border/65 pt-3">
        <Button type="button" size="xs" variant="ghost" disabled={busy} onClick={onCancel}>Cancel</Button>
        <Button type="submit" size="xs" disabled={busy}>Save Routine</Button>
      </div>
    </form>
  );
};
