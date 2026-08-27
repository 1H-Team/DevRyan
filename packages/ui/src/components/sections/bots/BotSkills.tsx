import React from 'react';
import { RiRefreshLine, RiSparklingLine } from '@remixicon/react';

import { Button } from '@/components/ui/button';
import {
  botsApi,
  BotsApiError,
  type BotCapabilityBindings,
  type BotManagementDetail,
  type BotRevisionDetail,
} from '@/lib/botsApi';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { defaultBotCapabilityRevision } from './botCapabilityAssignmentsPresentation';

const hasContract = (value: BotManagementDetail['revisions'][number]): value is BotRevisionDetail => (
  Object.hasOwn(value, 'contract') && Object.hasOwn(value, 'updatedAt')
);

const currentDirectory = (): string | undefined => (
  useProjectsStore.getState().getActiveProject()?.path || undefined
);

export const BotSkills: React.FC<{
  detail: BotManagementDetail;
  onChanged?: () => void | Promise<void>;
}> = ({ detail, onChanged }) => {
  const [bindings, setBindings] = React.useState<BotCapabilityBindings | null>(null);
  const [revision, setRevision] = React.useState<BotRevisionDetail | null>(() => {
    const candidate = defaultBotCapabilityRevision(detail);
    return candidate && hasContract(candidate) ? candidate : null;
  });
  const [busy, setBusy] = React.useState<string | null>(null);
  const [feedback, setFeedback] = React.useState<string | null>(null);

  const load = React.useCallback(async (target: BotRevisionDetail | null) => {
    if (!target) return;
    setBusy((current) => current || 'load');
    try {
      setBindings(await botsApi.getBotCapabilityBindings(detail.bot.id, target.id, {
        directory: currentDirectory(),
        checkLive: false,
      }));
      setFeedback(null);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Skills could not be loaded.');
    } finally {
      setBusy((current) => current === 'load' ? null : current);
    }
  }, [detail.bot.id]);

  React.useEffect(() => {
    const candidate = defaultBotCapabilityRevision(detail);
    const next = candidate && hasContract(candidate) ? candidate : null;
    setRevision(next);
    setBindings(null);
    if (next) void load(next);
  }, [detail, load]);

  const ensureEditableRevision = async (): Promise<BotRevisionDetail> => {
    if (!revision) throw new Error('This Bot does not have a saved configuration.');
    if (revision.activatedAt === null) return revision;
    const result = await botsApi.createBotRevision(detail.bot.id, {
      basedOnRevisionId: revision.id,
      contract: revision.contract,
    });
    setRevision(result.revision);
    return result.revision;
  };

  const changeSkill = async (skillName: string, bindingId: string | null) => {
    setBusy(skillName);
    setFeedback(null);
    try {
      const editable = await ensureEditableRevision();
      const current = await botsApi.getBotCapabilityBindings(detail.bot.id, editable.id, {
        directory: currentDirectory(),
        checkLive: false,
      });
      const result = bindingId
        ? await botsApi.detachBotSkill(
            detail.bot.id,
            editable.id,
            bindingId,
            current.revision.updatedAt,
          )
        : await botsApi.attachBotSkill(detail.bot.id, editable.id, {
            skillName,
            directory: currentDirectory(),
            expectedUpdatedAt: current.revision.updatedAt,
          });
      setRevision(result.revision);
      setBindings(await botsApi.getBotCapabilityBindings(detail.bot.id, result.revision.id, {
        directory: currentDirectory(),
        checkLive: false,
      }));
      try {
        await botsApi.activateBotRevision(detail.bot.id, result.revision.id);
        setFeedback('Skill selection saved and active.');
      } catch (error) {
        setFeedback(error instanceof BotsApiError && error.code === 'bot_activation_blocked'
          ? 'Skill selection is saved and will become active after the Bot runtime is ready.'
          : 'Skill selection is saved. It could not be activated yet.');
      }
      await onChanged?.();
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'The Skill selection could not be saved.');
    } finally {
      setBusy(null);
    }
  };

  const assignedByName = new Map((bindings?.skills || []).map((binding) => [binding.name, binding]));
  const skills = bindings?.availableSkills || [];

  return (
    <section className="space-y-4 border-t border-border pt-7" aria-labelledby="bot-skills-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <RiSparklingLine className="h-5 w-5 text-muted-foreground" aria-hidden />
            <h3 id="bot-skills-heading" className="typography-ui-header font-semibold text-foreground">Skills</h3>
          </div>
          <p className="typography-ui text-muted-foreground">
            Optional SOPs for this Bot. Skill files stay out of ordinary context and are loaded when relevant.
          </p>
        </div>
        <Button type="button" size="xs" variant="ghost" disabled={busy !== null} onClick={() => void load(revision)}>
          <RiRefreshLine className="h-3.5 w-3.5" aria-hidden /> Refresh
        </Button>
      </div>

      {feedback ? (
        <p role="status" className="rounded-lg border border-border/70 px-3 py-2 typography-ui text-foreground">{feedback}</p>
      ) : null}

      {skills.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-5">
          <p className="typography-ui-label text-foreground">No installed Skills</p>
          <p className="mt-1 typography-meta text-muted-foreground">Install or create an SOP in Settings, then return here to add it to this Bot.</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border/70">
          {skills.map((skill) => {
            const assigned = assignedByName.get(skill.name) || null;
            return (
              <div key={skill.name} className="flex items-center gap-3 border-b border-border/60 p-3 last:border-b-0">
                <div className="min-w-0 flex-1">
                  <p className="truncate typography-ui-label font-medium text-foreground">{skill.name}</p>
                  <p className="truncate typography-micro text-muted-foreground">{skill.description || 'Reusable Bot instructions'}</p>
                </div>
                <Button
                  type="button"
                  size="xs"
                  variant={assigned ? 'outline' : 'default'}
                  disabled={!detail.canManage || busy !== null || !revision}
                  onClick={() => void changeSkill(skill.name, assigned?.id || null)}
                >
                  {busy === skill.name ? 'Saving…' : assigned ? 'Remove' : 'Add'}
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
};
