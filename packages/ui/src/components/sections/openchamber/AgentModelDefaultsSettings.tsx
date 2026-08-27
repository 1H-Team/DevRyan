import React from 'react';
import { RiInformationLine } from '@remixicon/react';

import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  findAgentDefaultOverride,
  isSingleModelAgentDefault,
  resolveAgentDefaultSelection,
} from '@/lib/agentDefaultResolution';
import { formatAgentDisplayName } from '@/lib/agentDisplay';
import { canEditPersonalAgentModels, useAuthPrincipal } from '@/lib/authSession';
import { getOrderedThinkingVariants, resolveProviderModelVariant } from '@/lib/providers/variantControls';
import { isProviderModelAvailable } from '@/lib/providers/modelAvailability';
import { useConfigStore } from '@/stores/useConfigStore';
import { filterVisibleAgentSelectorOptions } from '@/stores/useAgentsStore';

const DEFAULT_VARIANT = '__default__';

type DraftSelection = {
  providerId: string;
  modelId: string;
  variant?: string;
};

const sameSelection = (left: DraftSelection | null, right: DraftSelection | null) => (
  left?.providerId === right?.providerId
  && left?.modelId === right?.modelId
  && left?.variant === right?.variant
);

const AgentDefaultRow: React.FC<{
  agent: ReturnType<typeof useConfigStore.getState>['agents'][number];
}> = ({ agent }) => {
  const providers = useConfigStore((state) => state.providers);
  const selections = useConfigStore((state) => state.agentModelSelections);
  const persistSelection = useConfigStore((state) => state.persistAgentModelSelection);
  const resetSelection = useConfigStore((state) => state.resetAgentModelSelection);
  const applyDefaultsToCurrent = useConfigStore((state) => state.applyDefaultsToCurrent);
  const personal = findAgentDefaultOverride(selections, agent.name);
  const inherited = resolveAgentDefaultSelection({
    agentName: agent.name,
    agents: [agent],
    providers,
  });
  const effective = resolveAgentDefaultSelection({
    agentName: agent.name,
    agents: [agent],
    providers,
    personalSelections: selections,
  });
  const saved = personal ?? inherited;
  const savedProviderId = saved?.providerId;
  const savedModelId = saved?.modelId;
  const savedVariant = saved?.variant;
  const [draft, setDraft] = React.useState<DraftSelection | null>(saved);
  const [busy, setBusy] = React.useState<'save' | 'reset' | null>(null);

  React.useEffect(() => {
    setDraft(savedProviderId && savedModelId ? {
      providerId: savedProviderId,
      modelId: savedModelId,
      ...(savedVariant ? { variant: savedVariant } : {}),
    } : null);
  }, [savedModelId, savedProviderId, savedVariant]);

  if (!draft || !inherited) return null;

  const provider = providers.find((entry) => entry.id === draft.providerId);
  const model = provider?.models.find((entry) => entry.id === draft.modelId);
  const thinkingOptions = getOrderedThinkingVariants(
    model && 'variants' in model ? model.variants : undefined,
    { providerId: draft.providerId },
  );
  const selectionAvailable = Boolean(model && isProviderModelAvailable(model));
  const changed = !sameSelection(draft, saved);
  const personalUnavailable = Boolean(personal) && !selectionAvailable;

  const handleModelChange = (providerId: string, modelId: string) => {
    const nextProvider = providers.find((entry) => entry.id === providerId);
    const variant = resolveProviderModelVariant(nextProvider, modelId, draft.variant);
    setDraft({
      providerId,
      modelId,
      ...(variant ? { variant } : {}),
    });
  };

  const handleSave = async () => {
    setBusy('save');
    try {
      await persistSelection(agent.name, draft.providerId, draft.modelId, draft.variant);
      applyDefaultsToCurrent();
      toast.success(`${formatAgentDisplayName(agent.name)} default saved`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to save agent default');
    } finally {
      setBusy(null);
    }
  };

  const handleReset = async () => {
    setBusy('reset');
    try {
      await resetSelection(agent.name);
      applyDefaultsToCurrent();
      toast.success(`${formatAgentDisplayName(agent.name)} now inherits the host default`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to reset agent default');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="rounded-lg border border-border/60 bg-background/35 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="typography-ui-label font-medium text-foreground">{formatAgentDisplayName(agent.name)}</span>
            <span className={personal
              ? 'rounded-full bg-primary/10 px-2 py-0.5 typography-micro text-primary'
              : 'rounded-full bg-muted px-2 py-0.5 typography-micro text-muted-foreground'}>
              {personal ? 'Personal' : 'Inherited'}
            </span>
          </div>
          <p className="mt-0.5 typography-meta text-muted-foreground">
            {personal
              ? `Host default: ${inherited.providerId}/${inherited.modelId}${inherited.variant ? ` · ${inherited.variant}` : ''}`
              : 'Follows the live host agent configuration.'}
          </p>
          {personalUnavailable ? (
            <p className="mt-1 typography-meta text-[var(--status-warning)]">
              This personal model is unavailable. New sessions currently fall back to the host default.
            </p>
          ) : null}
          {personal && effective?.source !== 'personal' && !personalUnavailable ? (
            <p className="mt-1 typography-meta text-muted-foreground">The effective default is using an availability fallback.</p>
          ) : null}
        </div>
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_150px_auto] sm:items-end">
        <div className="min-w-0">
          <span className="mb-1 block typography-meta text-muted-foreground">Model</span>
          <ModelSelector
            providerId={draft.providerId}
            modelId={draft.modelId}
            onChange={handleModelChange}
            className="w-full"
          />
        </div>
        <div className="min-w-0">
          <span className="mb-1 block typography-meta text-muted-foreground">Thinking level</span>
          <Select
            value={draft.variant ?? DEFAULT_VARIANT}
            onValueChange={(value: string) => setDraft((current) => current ? {
              ...current,
              ...(value === DEFAULT_VARIANT ? { variant: undefined } : { variant: value }),
            } : current)}
            disabled={thinkingOptions.length === 0}
          >
            <SelectTrigger className="w-full">
              <SelectValue>{draft.variant ?? 'Default'}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DEFAULT_VARIANT}>Default</SelectItem>
              {thinkingOptions.map((variant) => (
                <SelectItem key={variant} value={variant}>{variant}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex gap-2 sm:justify-end">
          <Button size="sm" onClick={handleSave} disabled={!changed || !selectionAvailable || busy !== null}>
            {busy === 'save' ? 'Saving…' : 'Save'}
          </Button>
          <Button size="sm" variant="outline" onClick={handleReset} disabled={!personal || busy !== null}>
            {busy === 'reset' ? 'Resetting…' : 'Reset'}
          </Button>
        </div>
      </div>
    </div>
  );
};

export const AgentModelDefaultsSettings: React.FC = () => {
  const principal = useAuthPrincipal();
  const allAgents = useConfigStore((state) => state.agents);
  const agents = React.useMemo(() => filterVisibleAgentSelectorOptions(allAgents), [allAgents]);

  if (!canEditPersonalAgentModels(principal)) return null;

  const editableAgents = agents.filter((agent) => isSingleModelAgentDefault(agent));
  const hostManagedAgents = agents.filter((agent) => !isSingleModelAgentDefault(agent));

  return (
    <section className="space-y-3 border-t border-border/40 pt-6">
      <div className="px-1">
        <h3 className="typography-ui-header font-medium text-foreground">Agent model defaults</h3>
        <p className="mt-0.5 typography-meta text-muted-foreground">
          New sessions inherit these defaults. Model changes made in the composer stay with that session.
        </p>
      </div>

      <div className="space-y-2 px-1">
        {editableAgents.map((agent) => <AgentDefaultRow key={agent.name} agent={agent} />)}
        {hostManagedAgents.some((agent) => agent.name.trim().toLowerCase() === 'council') ? (
          <div className="flex gap-2 rounded-lg border border-border/50 bg-muted/25 p-3 text-muted-foreground">
            <RiInformationLine className="mt-0.5 h-4 w-4 shrink-0" />
            <p className="typography-meta">
              Council is host-managed. Its ordered multi-model roster is shared and cannot be overridden per account.
            </p>
          </div>
        ) : null}
      </div>
    </section>
  );
};
