import React from 'react';
import {
  RiCalendarScheduleLine,
  RiEditLine,
  RiPauseCircleLine,
  RiPlayCircleLine,
  RiRefreshLine,
  RiStopLine,
} from '@remixicon/react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  botsApi,
  type BotRoutine,
  type BotRoutineContract,
  type BotsApi,
} from '@/lib/botsApi';
import { RoutineDraftReview } from './RoutineDraftReview';
import { RoutineEditor } from './RoutineEditor';

type RoutineApi = Pick<BotsApi,
  | 'listBotRoutines'
  | 'draftBotRoutine'
  | 'createBotRoutineDraft'
  | 'updateBotRoutineDraft'
  | 'transitionBotRoutine'
>;

export type BotRoutinesProps = {
  botId: string;
  api?: RoutineApi;
};

type EditorState = {
  key: string;
  name: string;
  contract: BotRoutineContract;
  routineId: string | null;
  expectedUpdatedAt: string | null;
};

const statusTone: Record<BotRoutine['status'], string> = {
  draft: 'border-border text-muted-foreground',
  active: 'border-[var(--status-success)]/35 text-[var(--status-success)]',
  paused: 'border-[var(--status-warning)]/35 text-[var(--status-warning)]',
  retired: 'border-border/60 text-muted-foreground',
};

const scheduleLabel = (routine: BotRoutine): string => {
  const { trigger } = routine.contract;
  if (trigger.kind === 'daily') return `Daily ${trigger.time}`;
  if (trigger.kind === 'weekly') return `Weekly ${trigger.time}`;
  if (trigger.kind === 'once') return `Once ${trigger.localDateTime}`;
  return `Cron ${trigger.expression}`;
};

export const BotRoutines: React.FC<BotRoutinesProps> = ({ botId, api = botsApi }) => {
  const [routines, setRoutines] = React.useState<BotRoutine[]>([]);
  const [nextCursor, setNextCursor] = React.useState<string | null>(null);
  const [name, setName] = React.useState('');
  const [rationale, setRationale] = React.useState('');
  const [timezone, setTimezone] = React.useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  const [candidate, setCandidate] = React.useState<BotRoutineContract | null>(null);
  const [reviewRoutine, setReviewRoutine] = React.useState<BotRoutine | null>(null);
  const [editor, setEditor] = React.useState<EditorState | null>(null);
  const [busy, setBusy] = React.useState<string | null>('load');
  const [feedback, setFeedback] = React.useState<string | null>(null);

  const load = React.useCallback(async (cursor: string | null = null) => {
    setBusy('load');
    try {
      const page = await api.listBotRoutines(botId, { cursor, limit: 100 });
      const visibleRoutines = page.routines.filter((routine) => routine.status !== 'retired');
      setRoutines((current) => cursor ? [...current, ...visibleRoutines] : visibleRoutines);
      setNextCursor(page.nextCursor);
      setFeedback(null);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Unable to load Bot routines.');
    } finally {
      setBusy(null);
    }
  }, [api, botId]);

  React.useEffect(() => { void load(); }, [load]);

  const generate = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy('draft');
    try {
      const result = await api.draftBotRoutine(botId, {
        rationale: rationale.trim(),
        timezone: timezone.trim(),
      });
      setCandidate(result.contract);
      setEditor(null);
      setReviewRoutine(null);
      setFeedback('Draft ready. Review it before saving.');
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Routine drafting failed.');
    } finally {
      setBusy(null);
    }
  };

  const save = async (editorState: EditorState, nextName: string, nextContract: BotRoutineContract) => {
    setBusy('save');
    try {
      if (editorState.routineId && editorState.expectedUpdatedAt) {
        await api.updateBotRoutineDraft(botId, editorState.routineId, {
          name: nextName,
          contract: nextContract,
          expectedUpdatedAt: editorState.expectedUpdatedAt,
        });
      } else {
        await api.createBotRoutineDraft(botId, { name: nextName, contract: nextContract });
      }
      setEditor(null);
      setCandidate(null);
      await load();
      setFeedback('Structured routine saved for review before activation.');
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Unable to save the routine proposal.');
    } finally {
      setBusy(null);
    }
  };

  const transition = async (
    routine: BotRoutine,
    target: 'active' | 'paused' | 'retired',
    reviewed = false,
  ) => {
    setBusy(`${target}:${routine.id}`);
    try {
      await api.transitionBotRoutine(botId, routine.id, {
        target,
        expectedUpdatedAt: routine.updatedAt,
        ...(reviewed ? { reviewed: true } : {}),
      });
      setReviewRoutine(null);
      await load();
      setFeedback(target === 'active'
        ? 'Routine activated. Each occurrence uses the Bot settings active at run time.'
        : target === 'retired' ? 'Routine deleted.' : 'Routine paused.');
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : `Unable to mark the routine ${target}.`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="space-y-5" aria-labelledby="bot-routines-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <RiCalendarScheduleLine className="h-5 w-5 text-muted-foreground" aria-hidden />
            <h3 id="bot-routines-heading" className="typography-ui-header font-semibold text-foreground">Scheduled routines</h3>
          </div>
          <p className="mt-1 typography-ui text-muted-foreground">
            Run recurring or one-time tasks even after this window closes.
          </p>
        </div>
        <Button type="button" size="xs" variant="ghost" disabled={busy !== null} onClick={() => void load()}>
          <RiRefreshLine className="h-3.5 w-3.5" aria-hidden /> Refresh
        </Button>
      </div>

      {feedback ? (
        <p role="status" className="rounded-lg border border-border/70 bg-[var(--surface-subtle)]/45 px-3 py-2 typography-ui text-foreground">{feedback}</p>
      ) : null}

      <form className="grid gap-3 rounded-xl border border-border/70 bg-[var(--surface-subtle)]/20 p-4 md:grid-cols-[minmax(10rem,0.6fr)_minmax(12rem,0.7fr)_minmax(16rem,1.7fr)_auto]" onSubmit={(event) => void generate(event)}>
        <label className="space-y-1 typography-meta text-muted-foreground">
          <span className="font-medium text-foreground">Routine Name</span>
          <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Morning queue review" maxLength={160} />
        </label>
        <label className="space-y-1 typography-meta text-muted-foreground">
          <span className="font-medium text-foreground">Timezone</span>
          <Input value={timezone} onChange={(event) => setTimezone(event.target.value)} placeholder="UTC" />
        </label>
        <label className="space-y-1 typography-meta text-muted-foreground">
          <span className="font-medium text-foreground">Describe the Routine</span>
          <Input value={rationale} onChange={(event) => setRationale(event.target.value)} placeholder="Every weekday morning, summarize approved priority tickets without changing them." />
        </label>
        <div className="flex items-end">
          <Button type="submit" size="xs" disabled={busy !== null || !name.trim() || !timezone.trim() || !rationale.trim()}>
            Draft Routine
          </Button>
        </div>
      </form>

      {candidate && !editor ? (
        <RoutineDraftReview
          contract={candidate}
          title="Review Routine"
          actionLabel="Edit Details"
          busy={busy !== null}
          onCancel={() => setCandidate(null)}
          onConfirm={() => setEditor({
            key: `candidate:${Date.now()}`,
            name: name.trim(),
            contract: candidate,
            routineId: null,
            expectedUpdatedAt: null,
          })}
        />
      ) : null}

      {editor ? (
        <RoutineEditor
          key={editor.key}
          initialName={editor.name}
          initialContract={editor.contract}
          busy={busy !== null}
          onCancel={() => setEditor(null)}
          onSave={(nextName, nextContract) => void save(editor, nextName, nextContract)}
        />
      ) : null}

      {reviewRoutine ? (
        <RoutineDraftReview
          contract={reviewRoutine.contract}
          title={`Activate “${reviewRoutine.name}”`}
          actionLabel="Activate Reviewed Routine"
          busy={busy !== null}
          onCancel={() => setReviewRoutine(null)}
          onConfirm={() => void transition(reviewRoutine, 'active', true)}
        />
      ) : null}

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <h4 className="typography-ui-label font-semibold text-foreground">Saved routines</h4>
          <span className="typography-micro text-muted-foreground">{routines.length} loaded</span>
        </div>
        {routines.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border p-6 text-center">
            <p className="typography-ui-label text-foreground">No routines yet</p>
            <p className="mt-1 typography-meta text-muted-foreground">Describe one above, review it, then save and activate it.</p>
          </div>
        ) : routines.map((routine) => (
          <article key={routine.id} className="rounded-xl border border-border/70 bg-background p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h5 className="truncate typography-ui-label font-semibold text-foreground">{routine.name}</h5>
                  <span className={`rounded-full border px-1.5 py-0.5 typography-micro capitalize ${statusTone[routine.status]}`}>{routine.status}</span>
                </div>
                <p className="mt-1 typography-meta text-muted-foreground">
                  {scheduleLabel(routine)} · {routine.timezone} · {routine.contract.limits.maxActions} actions · {routine.contract.limits.maxExternalWrites} writes
                </p>
                <p className="mt-1 line-clamp-2 typography-ui text-foreground">{routine.contract.goal}</p>
                <p className="mt-2 typography-micro text-muted-foreground">
                  {routine.nextOccurrenceAt ? `Next ${new Date(routine.nextOccurrenceAt).toLocaleString()}` : 'No future occurrence'}
                  {routine.lastOccurrenceAt ? ` · Last ${new Date(routine.lastOccurrenceAt).toLocaleString()}` : ''}
                  {' · '}uses the Bot's current settings
                </p>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {routine.status === 'draft' || routine.status === 'paused' ? (
                  <>
                    <Button type="button" size="xs" variant="ghost" disabled={busy !== null} onClick={() => {
                      setEditor({
                        key: `${routine.id}:${routine.updatedAt}`,
                        name: routine.name,
                        contract: routine.contract,
                        routineId: routine.id,
                        expectedUpdatedAt: routine.updatedAt,
                      });
                      setCandidate(null);
                      setReviewRoutine(null);
                    }}>
                      <RiEditLine className="h-3.5 w-3.5" aria-hidden /> Edit
                    </Button>
                    <Button type="button" size="xs" variant="outline" disabled={busy !== null} onClick={() => {
                      setReviewRoutine(routine);
                      setEditor(null);
                    }}>
                      <RiPlayCircleLine className="h-3.5 w-3.5" aria-hidden /> Review & Activate
                    </Button>
                  </>
                ) : null}
                {routine.status === 'active' ? (
                  <Button type="button" size="xs" variant="outline" disabled={busy !== null} onClick={() => void transition(routine, 'paused')}>
                    <RiPauseCircleLine className="h-3.5 w-3.5" aria-hidden /> Pause
                  </Button>
                ) : null}
                {routine.status !== 'retired' ? (
                  <Button type="button" size="xs" variant="ghost" disabled={busy !== null} onClick={() => void transition(routine, 'retired')}>
                    <RiStopLine className="h-3.5 w-3.5" aria-hidden /> Delete
                  </Button>
                ) : null}
              </div>
            </div>
          </article>
        ))}
        {nextCursor ? <Button type="button" size="xs" variant="ghost" disabled={busy !== null} onClick={() => void load(nextCursor)}>Load More Routines</Button> : null}
      </div>
    </section>
  );
};
