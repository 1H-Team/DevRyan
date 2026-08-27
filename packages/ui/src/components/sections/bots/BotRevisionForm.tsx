import React from 'react';
import {
  RiAddLine,
  RiArrowDownLine,
  RiArrowUpLine,
  RiDeleteBinLine,
  RiRefreshLine,
  RiRocketLine,
} from '@remixicon/react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { NumberInput } from '@/components/ui/number-input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import type {
  BotCredentialMetadata,
  BotModelBinding,
  BotModelOptions,
  BotRevisionContract,
} from '@/lib/botsApi';
import {
  botRevisionModelPolicy,
  withBotRevisionAgent,
  withBotRevisionModelPolicy,
} from '@/lib/botsApi';
import { cn } from '@/lib/utils';
import { validateBotRevisionConfiguration } from './botManagementPresentation';
import { BotPolicyEditor } from './BotPolicyEditor';
import { buildStarterBotSoul, missingBotSoulSections } from './botSoulTemplate';
import {
  BOT_MODEL_UNSELECTED,
  botModelOptionsFor,
  botProviderOptionsFor,
  compatibleBotCredentials,
  reorderBotModelFallbacks,
  updateBotModelProvider,
  updateBotModelSelection,
} from './botRevisionModelPresentation';

const FILE_TOOLS = ['read', 'glob', 'grep', 'edit', 'write'] as const;
const RUNTIME_TOOLS = ['bash', 'terminal', 'git', 'task'] as const;
const RUNTIME_TOOL_LABELS = Object.freeze({
  bash: 'Shell',
  terminal: 'Terminal',
  git: 'Git',
  task: 'Task',
});
const PROVIDER_DEFAULT = '__provider_default__';

const splitLines = (value: string): string[] => value
  .split('\n')
  .map((entry) => entry.trim())
  .filter(Boolean);

type ModelBindingRowProps = {
  label: string;
  value: BotModelBinding;
  modelOptions: BotModelOptions | null;
  credentials: readonly BotCredentialMetadata[];
  readOnly: boolean;
  legacyEffort?: string;
  onChange: (value: BotModelBinding) => void;
  onThinkingChange: (variant: string | undefined) => void;
  onNavigateCredentials?: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onRemove?: () => void;
};

const ModelBindingRow: React.FC<ModelBindingRowProps> = ({
  label,
  value,
  modelOptions,
  credentials,
  readOnly,
  legacyEffort,
  onChange,
  onThinkingChange,
  onNavigateCredentials,
  onMoveUp,
  onMoveDown,
  onRemove,
}) => {
  const providers = botProviderOptionsFor(modelOptions, value);
  const selectedProvider = providers.find((provider) => provider.id === value.providerId);
  const models = botModelOptionsFor(selectedProvider, value);
  const selectedModel = models.find((model) => model.id === value.modelId);
  const compatibleCredentials = compatibleBotCredentials(credentials, value.providerId);
  const autoCredentialId = !value.credentialId && compatibleCredentials.length === 1
    ? compatibleCredentials[0]?.id ?? null
    : null;
  const selectedCredential = credentials.find((credential) => credential.id === value.credentialId);
  const imageGenerationAvailable = value.providerId.toLowerCase() === 'openai'
    && selectedCredential?.kind === 'oauth'
    && selectedCredential.status === 'active';
  const credentialOptions = selectedCredential
    && !compatibleCredentials.some((credential) => credential.id === selectedCredential.id)
    ? [selectedCredential, ...compatibleCredentials]
    : compatibleCredentials;
  const variants = [...(selectedModel?.variants ?? [])];
  if (value.variant && !variants.some((variant) => variant.id === value.variant)) {
    variants.unshift({ id: value.variant, name: value.variant, available: false });
  }

  React.useEffect(() => {
    if (readOnly || !autoCredentialId) return;
    onChange({ ...value, credentialId: autoCredentialId });
  }, [autoCredentialId, onChange, readOnly, value]);

  const supportedLegacyEffort = !value.variant
    && legacyEffort
    && selectedModel?.variants.some((variant) => variant.id === legacyEffort)
    ? legacyEffort
    : null;

  const updateProvider = (providerId: string) => {
    if (providerId === BOT_MODEL_UNSELECTED) return;
    onChange(updateBotModelProvider({
      binding: value,
      providerId,
      providers,
      credentials,
    }));
  };

  const updateSelectedModel = (modelId: string) => {
    if (modelId === BOT_MODEL_UNSELECTED) return;
    onChange(updateBotModelSelection(value, modelId, models));
  };

  return (
    <fieldset disabled={readOnly} className="rounded-xl border border-border/70 bg-[var(--surface-elevated)]/35 p-3">
      <legend className="px-1 typography-ui-label font-semibold text-foreground">{label}</legend>
      <div className="grid gap-3 md:grid-cols-3">
        <label className="space-y-1.5 typography-meta text-muted-foreground">
          <span>Provider</span>
          <Select value={value.providerId || BOT_MODEL_UNSELECTED} onValueChange={updateProvider} disabled={readOnly}>
            <SelectTrigger size="lg" className="w-full"><SelectValue placeholder="Select provider" /></SelectTrigger>
            <SelectContent>
              {providers.length === 0 ? <SelectItem value={BOT_MODEL_UNSELECTED} disabled>Catalog Unavailable</SelectItem> : null}
              {providers.map((provider) => (
                <SelectItem key={provider.id} value={provider.id}>
                  {provider.name}{provider.available ? '' : ' · Unavailable'}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <label className="space-y-1.5 typography-meta text-muted-foreground">
          <span>Model</span>
          <Select value={value.modelId || BOT_MODEL_UNSELECTED} onValueChange={updateSelectedModel} disabled={readOnly || !value.providerId}>
            <SelectTrigger size="lg" className="w-full"><SelectValue placeholder="Select model" /></SelectTrigger>
            <SelectContent>
              {models.length === 0 ? <SelectItem value={BOT_MODEL_UNSELECTED} disabled>Select a Provider First</SelectItem> : null}
              {models.map((model) => (
                <SelectItem key={model.id} value={model.id}>
                  {model.name}{model.available ? '' : ' · Unavailable'}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <label className="space-y-1.5 typography-meta text-muted-foreground">
          <span>Thinking</span>
          <Select
            value={value.variant || supportedLegacyEffort || PROVIDER_DEFAULT}
            onValueChange={(variant) => onThinkingChange(
              variant === PROVIDER_DEFAULT ? undefined : variant,
            )}
            disabled={readOnly || !value.modelId}
          >
            <SelectTrigger size="lg" className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={PROVIDER_DEFAULT}>Provider Default</SelectItem>
              {variants.map((variant) => (
                <SelectItem key={variant.id} value={variant.id}>
                  {variant.name}{variant.available ? '' : ' · Unavailable'}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
      </div>

      <details className="mt-3 rounded-lg border border-border/60 bg-background/55 px-3 py-2">
        <summary className="cursor-pointer typography-ui-label font-medium text-foreground">Connection Details</summary>
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          <label className="space-y-1.5 typography-meta text-muted-foreground">
            <span>Credential</span>
            <Select
              value={value.credentialId || BOT_MODEL_UNSELECTED}
              onValueChange={(credentialId) => {
                if (credentialId !== BOT_MODEL_UNSELECTED) onChange({ ...value, credentialId });
              }}
              disabled={readOnly || !value.providerId}
            >
              <SelectTrigger size="lg" className="w-full"><SelectValue placeholder="Select credential" /></SelectTrigger>
              <SelectContent>
                {credentialOptions.length === 0 ? <SelectItem value={BOT_MODEL_UNSELECTED} disabled>No Compatible Credential</SelectItem> : null}
                {credentialOptions.map((credential) => (
                  <SelectItem key={credential.id} value={credential.id}>
                    {credential.label} · {credential.scope}
                    {credential.status === 'active' ? '' : ' · Unavailable'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!value.credentialId || !compatibleCredentials.some((credential) => credential.id === value.credentialId) ? (
              <span className="block typography-micro text-[var(--status-warning)]">
                Select an active {value.providerId || 'provider'} credential.
                {onNavigateCredentials ? (
                  <button type="button" className="ml-1 underline underline-offset-2" onClick={onNavigateCredentials}>Open Credentials</button>
                ) : null}
              </span>
            ) : null}
          </label>
          <div className="space-y-1.5 typography-meta text-muted-foreground">
            <span>Reviewed HTTPS egress</span>
            {value.egressHosts.length > 0 ? (
              <div className="flex min-h-8 flex-wrap gap-1.5 rounded-lg border border-border/60 bg-background px-2 py-1.5">
                {value.egressHosts.map((host) => (
                  <span key={host} className="rounded-md bg-muted px-1.5 py-0.5 typography-micro text-foreground">{host}</span>
                ))}
              </div>
            ) : (
              <p className="rounded-lg border border-[var(--status-warning)]/35 bg-[var(--status-warning)]/8 px-2 py-1.5 typography-micro text-foreground">
                No reviewed HTTPS authority is available for this selection.
              </p>
            )}
          </div>
          <div className="space-y-1.5 typography-meta text-muted-foreground lg:col-span-2">
            <span>ChatGPT image generation</span>
            <p className={cn(
              'rounded-lg border px-2 py-1.5 typography-micro text-foreground',
              imageGenerationAvailable
                ? 'border-[var(--status-success)]/35 bg-[var(--status-success)]/8'
                : 'border-border/60 bg-background',
            )}>
              {imageGenerationAvailable
                ? 'Available for new runs through this OpenAI ChatGPT OAuth connection.'
                : 'Unavailable. Image generation requires an active OpenAI ChatGPT OAuth connection.'}
            </p>
          </div>
        </div>
      </details>

      {!readOnly && (onMoveUp || onMoveDown || onRemove) ? (
        <div className="mt-3 flex justify-end gap-1">
          {onMoveUp ? <Button type="button" size="icon" variant="ghost" className="h-7 w-7" aria-label={`Move ${label} up`} onClick={onMoveUp}><RiArrowUpLine className="h-3.5 w-3.5" /></Button> : null}
          {onMoveDown ? <Button type="button" size="icon" variant="ghost" className="h-7 w-7" aria-label={`Move ${label} down`} onClick={onMoveDown}><RiArrowDownLine className="h-3.5 w-3.5" /></Button> : null}
          {onRemove ? <Button type="button" size="icon" variant="ghost" className="h-7 w-7" aria-label={`Remove ${label}`} onClick={onRemove}><RiDeleteBinLine className="h-3.5 w-3.5" /></Button> : null}
        </div>
      ) : null}
    </fieldset>
  );
};

/**
 * The Bot's identity file. It leads the system prompt, so this is the first
 * thing the model reads and the first thing shown on Overview.
 */
export const BotSoulEditor: React.FC<{
  value: BotRevisionContract;
  botName?: string;
  readOnly?: boolean;
  onChange: (value: BotRevisionContract) => void;
}> = ({ value, botName, readOnly = false, onChange }) => {
  const soul = value.soul ?? '';
  const missing = missingBotSoulSections(soul);
  const empty = soul.trim().length === 0;

  return (
    <section className="space-y-3" aria-labelledby="bot-overview-soul">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 id="bot-overview-soul" className="typography-ui-header font-semibold text-foreground">Soul</h3>
          <p className="typography-ui text-muted-foreground">
            Who this Bot is and how it talks. This is written as <code className="rounded bg-[var(--surface-subtle)] px-1 py-0.5 typography-micro">soul.md</code> and read before any other instruction.
          </p>
        </div>
        {!readOnly && empty ? (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => onChange({
              ...value,
              soul: buildStarterBotSoul({
                name: botName,
                title: value.identity.title,
                tone: value.tone,
              }),
            })}
          >
            Start from a Template
          </Button>
        ) : null}
      </div>
      <fieldset disabled={readOnly} className="space-y-2">
        <label className="space-y-1 typography-meta text-muted-foreground">
          <span className="sr-only">Soul</span>
          <Textarea
            rows={18}
            className="font-mono typography-micro"
            spellCheck={false}
            placeholder={'# Soul\n\nOne line on who this Bot is.\n\n## Core Identity\n…'}
            value={soul}
            onChange={(event) => onChange({ ...value, soul: event.target.value })}
          />
        </label>
        {!empty && missing.length > 0 ? (
          <p className="typography-micro text-muted-foreground">
            Consider adding: {missing.join(', ')}.
          </p>
        ) : (
          <p className="typography-micro text-muted-foreground">
            Keep it to identity, voice, and behavioral limits. Task instructions belong below.
          </p>
        )}
      </fieldset>
    </section>
  );
};

export const BotOperatingBrief: React.FC<{
  value: BotRevisionContract;
  readOnly?: boolean;
  statusSummary?: React.ReactNode;
  onChange: (value: BotRevisionContract) => void;
}> = ({ value, readOnly = false, statusSummary, onChange }) => {
  const update = <Key extends keyof BotRevisionContract>(
    key: Key,
    next: BotRevisionContract[Key],
  ) => onChange({ ...value, [key]: next });
  const reasoning = value.reasoning as { maxOutputTokens?: unknown };
  const maxOutputTokens = typeof reasoning?.maxOutputTokens === 'number'
    ? reasoning.maxOutputTokens
    : 16_384;

  return (
    <section className="space-y-3" aria-labelledby="bot-overview-operating-brief">
      <div>
        <h3 id="bot-overview-operating-brief" className="typography-ui-header font-semibold text-foreground">Instructions</h3>
        <p className="typography-ui text-muted-foreground">What this Bot is here to do, and what it must never do.</p>
      </div>
      <fieldset disabled={readOnly} className="grid gap-3 md:grid-cols-2">
        <label className="space-y-1 typography-meta text-muted-foreground md:col-span-2">
          <span>Standing Role</span>
          <Textarea rows={3} value={value.standingRole} onChange={(event) => update('standingRole', event.target.value)} />
        </label>
        <label className="space-y-1 typography-meta text-muted-foreground md:col-span-2">
          <span>Objectives · One per Line</span>
          <Textarea rows={4} value={value.objectives.join('\n')} onChange={(event) => update('objectives', splitLines(event.target.value))} />
        </label>
        <label className="space-y-1 typography-meta text-muted-foreground">
          <span>Operating Instructions</span>
          <Textarea rows={6} value={value.operatingInstructions} onChange={(event) => update('operatingInstructions', event.target.value)} />
        </label>
        <label className="space-y-1 typography-meta text-muted-foreground">
          <span>Prohibited Instructions</span>
          <Textarea rows={6} value={value.prohibitedInstructions} onChange={(event) => update('prohibitedInstructions', event.target.value)} />
        </label>
      </fieldset>

      {statusSummary}

      {/* Moved out of Permissions: this is prompt text, not an access control. */}
      <details className="rounded-lg border border-border/70 p-3">
        <summary className="cursor-pointer typography-ui-label text-foreground">Advanced</summary>
        <fieldset disabled={readOnly} className="mt-3 grid gap-3 md:grid-cols-2">
          <label className="space-y-1 typography-meta text-muted-foreground md:col-span-2">
            <span>Extra Instructions</span>
            <Textarea rows={6} value={value.advancedPrompt} onChange={(event) => update('advancedPrompt', event.target.value)} />
            <span className="block typography-micro text-muted-foreground">Appended After Everything Above. Most Bots Leave This Empty.</span>
          </label>
          <label className="space-y-1 typography-meta text-muted-foreground">
            <span>Maximum Output Tokens</span>
            <NumberInput
              min={256}
              max={131_072}
              step={256}
              value={maxOutputTokens}
              onValueChange={(next) => update('reasoning', { ...value.reasoning, maxOutputTokens: next })}
            />
          </label>
        </fieldset>
      </details>
    </section>
  );
};

export type BotRevisionFormProps = {
  value: BotRevisionContract;
  revisionNumber: number;
  readOnly?: boolean;
  publishing?: boolean;
  conflict?: boolean;
  showActions?: boolean;
  modelOptions?: BotModelOptions | null;
  modelOptionsLoading?: boolean;
  modelOptionsError?: string | null;
  credentials?: readonly BotCredentialMetadata[];
  onChange: (value: BotRevisionContract) => void;
  onPublish?: () => void;
  onEditConfiguration?: () => void;
  onReloadModelOptions?: () => void;
  onNavigateCredentials?: () => void;
};

export const BotRevisionForm: React.FC<BotRevisionFormProps> = ({
  value,
  revisionNumber,
  readOnly = false,
  publishing = false,
  conflict = false,
  showActions = true,
  modelOptions = null,
  modelOptionsLoading = false,
  modelOptionsError = null,
  credentials = [],
  onChange,
  onPublish,
  onEditConfiguration,
  onReloadModelOptions,
  onNavigateCredentials,
}) => {
  const validation = validateBotRevisionConfiguration(value);
  const reasoning = value.reasoning as { effort?: string; maxOutputTokens?: number };
  const models = botRevisionModelPolicy(value);
  const update = <Key extends keyof BotRevisionContract>(
    key: Key,
    next: BotRevisionContract[Key],
  ) => onChange({ ...value, [key]: next });
  const updateModels = (next: NonNullable<typeof models>) => {
    onChange(withBotRevisionModelPolicy(value, next));
  };
  const updateFallback = (index: number, next: BotModelBinding) => {
    if (!models) return;
    const fallbacks = [...models.fallbacks];
    fallbacks[index] = next;
    updateModels({ ...models, fallbacks });
  };
  const moveFallback = (index: number, offset: -1 | 1) => {
    if (!models) return;
    const fallbacks = reorderBotModelFallbacks(models.fallbacks, index, offset);
    if (fallbacks === models.fallbacks) return;
    updateModels({ ...models, fallbacks });
  };
  const reasoningWithoutLegacyEffort = (): Readonly<Record<string, unknown>> => {
    const nextReasoning = { ...value.reasoning } as Record<string, unknown>;
    delete nextReasoning.effort;
    return nextReasoning;
  };

  return (
    <form
      className="space-y-7"
      aria-label={`Bot revision ${revisionNumber}`}
      onSubmit={(event) => {
        event.preventDefault();
        if (!readOnly && validation.valid) onPublish?.();
      }}
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-3">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="typography-ui-header font-semibold text-foreground">Permissions</h3>
            <span className="rounded-full border border-border px-2 py-0.5 typography-micro text-muted-foreground">
              {readOnly ? `Published revision ${revisionNumber} · read only` : 'Setup configuration'}
            </span>
          </div>
          <p className="typography-ui text-muted-foreground">
            Publishing affects future runs only; active and in-flight runs remain pinned to their revision.
          </p>
        </div>
      </div>

      {conflict ? (
        <div role="alert" className="rounded-lg border border-[var(--status-warning)]/40 bg-[var(--status-warning)]/10 p-3 typography-ui text-foreground">
          This configuration changed on the server. Reload it before saving again (409 revision conflict).
        </div>
      ) : null}

      {models ? <section className="space-y-3" aria-labelledby="bot-revision-models">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h4 id="bot-revision-models" className="typography-ui-label font-semibold text-foreground">Model Order and Reasoning</h4>
            <p className="typography-micro text-muted-foreground">Provider, Model, and Thinking stay aligned in one row; fallbacks run in the order shown.</p>
          </div>
          {!readOnly ? (
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={() => updateModels({
                ...models,
                fallbacks: [...models.fallbacks, {
                  providerId: models.primary.providerId,
                  modelId: '',
                  credentialId: '',
                  egressHosts: [],
                }],
              })}
            >
              <RiAddLine className="h-3.5 w-3.5" aria-hidden /> Add Fallback
            </Button>
          ) : null}
        </div>
        {modelOptionsLoading ? <p role="status" className="typography-ui text-muted-foreground">Loading provider catalog…</p> : null}
        {modelOptionsError ? (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-[var(--status-warning)]/35 bg-[var(--status-warning)]/8 p-3">
            <p className="typography-ui text-foreground">{modelOptionsError} Existing selections are preserved.</p>
            {onReloadModelOptions ? <Button type="button" size="xs" variant="ghost" onClick={onReloadModelOptions}><RiRefreshLine className="h-3.5 w-3.5" /> Retry</Button> : null}
          </div>
        ) : null}
        <ModelBindingRow
          label="Primary"
          value={models.primary}
          modelOptions={modelOptions}
          credentials={credentials}
          readOnly={readOnly}
          legacyEffort={reasoning.effort}
          onChange={(primary) => updateModels({ ...models, primary })}
          onThinkingChange={(variant) => onChange({
            ...withBotRevisionModelPolicy(value, {
              ...models,
              primary: { ...models.primary, variant },
            }),
            reasoning: reasoningWithoutLegacyEffort(),
          })}
          onNavigateCredentials={onNavigateCredentials}
        />
        {models.fallbacks.map((fallback, index) => (
          <ModelBindingRow
            key={`${index}-${fallback.providerId}-${fallback.modelId}`}
            label={`Fallback ${index + 1}`}
            value={fallback}
            modelOptions={modelOptions}
            credentials={credentials}
            readOnly={readOnly}
            legacyEffort={reasoning.effort}
            onChange={(next) => updateFallback(index, next)}
            onThinkingChange={(variant) => {
              const fallbacks = [...models.fallbacks];
              fallbacks[index] = { ...fallback, variant };
              onChange({
                ...withBotRevisionModelPolicy(value, { ...models, fallbacks }),
                reasoning: reasoningWithoutLegacyEffort(),
              });
            }}
            onNavigateCredentials={onNavigateCredentials}
            onMoveUp={index > 0 ? () => moveFallback(index, -1) : undefined}
            onMoveDown={index < models.fallbacks.length - 1 ? () => moveFallback(index, 1) : undefined}
            onRemove={() => updateModels({
              ...models,
              fallbacks: models.fallbacks.filter((_, rowIndex) => rowIndex !== index),
            })}
          />
        ))}
      </section> : (
        <section className="rounded-xl border border-border/70 bg-[var(--surface-elevated)]/35 p-4" aria-labelledby="bot-revision-agent-model">
          <h4 id="bot-revision-agent-model" className="typography-ui-label font-semibold text-foreground">Endpoint-managed model</h4>
          <p className="mt-1 typography-micro text-muted-foreground">
            This AG-UI connection chooses the model. DevRyan sends only conversation state and the governed <code className="rounded bg-[var(--surface-subtle)] px-1">devryan_bot</code> tool.
          </p>
          {value.contractVersion === 3 && value.agent.kind === 'ag_ui' && value.agent.modelHint ? (
            <p className="mt-2 typography-ui-label text-foreground">Model hint: {value.agent.modelHint}</p>
          ) : null}
        </section>
      )}

      <section className="space-y-3" aria-labelledby="bot-revision-tools">
        <div>
          <h4 id="bot-revision-tools" className="typography-ui-label font-semibold text-foreground">File Access</h4>
          <p className="typography-micro text-muted-foreground">Which file operations this Bot may perform on its computer.</p>
        </div>
        <fieldset disabled={readOnly} className="flex flex-wrap gap-x-5 gap-y-2 rounded-lg border border-border/70 p-3">
          <legend className="px-1 typography-meta text-muted-foreground">Allowed file tools</legend>
          {FILE_TOOLS.map((tool) => (
            <label key={tool} className="inline-flex items-center gap-2 typography-ui-label text-foreground">
              <Checkbox
                checked={value.fileTools.includes(tool)}
                onChange={(checked) => {
                  const tools = new Set(value.fileTools);
                  if (checked) tools.add(tool); else tools.delete(tool);
                  update('fileTools', FILE_TOOLS.filter((entry) => tools.has(entry)));
                }}
              />
              {tool}
            </label>
          ))}
        </fieldset>
        <fieldset disabled={readOnly} className="flex flex-wrap gap-x-5 gap-y-2 rounded-lg border border-border/70 p-3">
          <legend className="px-1 typography-meta text-muted-foreground">Allowed runtime tools</legend>
          {RUNTIME_TOOLS.map((tool) => (
            <label key={tool} className="inline-flex items-center gap-2 typography-ui-label text-foreground">
              <Checkbox
                checked={value.runtimeTools?.includes(tool) === true}
                onChange={(checked) => {
                  const tools = new Set(value.runtimeTools ?? []);
                  if (checked) tools.add(tool); else tools.delete(tool);
                  update('runtimeTools', RUNTIME_TOOLS.filter((entry) => tools.has(entry)));
                }}
              />
              {RUNTIME_TOOL_LABELS[tool]}
            </label>
          ))}
        </fieldset>
        <p className="typography-micro text-muted-foreground">
          Runtime tools stay inside the Bot container and managed workspace. Host files, Docker, secrets, raw browser/CDP, and host task orchestration remain unavailable.
        </p>
      </section>

      <section className="space-y-3" aria-labelledby="bot-revision-policy">
        <div>
          <h4 id="bot-revision-policy" className="typography-ui-label font-semibold text-foreground">Browser and Action Policy</h4>
          <p className="typography-micro text-muted-foreground">Every external action receives a durable decision before execution.</p>
        </div>
        <BotPolicyEditor
          value={{
            actionPolicy: value.actionPolicy,
            browserPolicy: value.browserPolicy,
            computerPolicy: value.computerPolicy,
            memoryPolicy: value.memoryPolicy,
          }}
          readOnly={readOnly}
          onChange={(next) => {
            const requiresV3 = next.actionPolicy.matcherVersion === 2
              || Boolean(next.browserPolicy.networkAccess)
              || Boolean(next.computerPolicy);
            if (value.contractVersion !== 3 && requiresV3 && models) {
              onChange({
                ...withBotRevisionAgent(value, { kind: 'opencode', models }),
                ...next,
              });
              return;
            }
            if (value.contractVersion === 3) {
              onChange({ ...value, ...next });
              return;
            }
            onChange({
              ...value,
              actionPolicy: next.actionPolicy,
              browserPolicy: next.browserPolicy,
              memoryPolicy: next.memoryPolicy,
            });
          }}
        />
      </section>

      {!validation.valid ? (
        <ul role="alert" className="list-disc space-y-1 pl-5 typography-ui text-[var(--status-error)]">
          {validation.errors.map((error) => <li key={error}>{error}</li>)}
        </ul>
      ) : null}

      {showActions ? <div className={cn(
        'sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center justify-end gap-2 border-t border-border bg-background/95 px-4 py-3 backdrop-blur-sm',
        'supports-[backdrop-filter]:bg-background/85',
      )}>
        {readOnly ? (
          onEditConfiguration ? (
            <Button type="button" size="sm" variant="outline" onClick={onEditConfiguration}>
              Edit Configuration
            </Button>
          ) : null
        ) : (
          onPublish ? (
            <Button type="submit" size="sm" disabled={publishing || !validation.valid}>
              <RiRocketLine className="h-4 w-4" aria-hidden /> {publishing ? 'Saving & Publishing…' : 'Save & Publish'}
            </Button>
          ) : null
        )}
      </div> : null}
    </form>
  );
};
