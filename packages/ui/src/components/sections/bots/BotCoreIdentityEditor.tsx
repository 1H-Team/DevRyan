import React from 'react';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  botRevisionModelPolicy,
  type BotCredentialMetadata,
  type BotModelOptions,
  type BotRevisionContract,
} from '@/lib/botsApi';
import {
  BOT_MODEL_UNSELECTED,
  botModelOptionsFor,
  botProviderOptionsFor,
  compatibleBotCredentials,
} from './botRevisionModelPresentation';
import {
  updateBotOverviewPrimaryModel,
  updateBotOverviewProvider,
  updateBotOverviewThinking,
} from './botCoreIdentityPresentation';
import { BOT_SOUL_MAX_BYTES } from './botSoulTemplate';
import { BotSoulEditor } from './BotRevisionForm';

const PROVIDER_DEFAULT = '__provider_default__';

const splitLines = (value: string): string[] => value
  .split('\n')
  .map((entry) => entry.trim())
  .filter(Boolean);

export const BotCoreIdentityEditor: React.FC<{
  botName: string;
  value: BotRevisionContract;
  modelOptions?: BotModelOptions | null;
  credentials?: readonly BotCredentialMetadata[];
  readOnly?: boolean;
  onChange: (value: BotRevisionContract) => void;
  onNavigateCredentials?: () => void;
}> = ({
  botName,
  value,
  modelOptions = null,
  credentials = [],
  readOnly = false,
  onChange,
  onNavigateCredentials,
}) => {
  const soulTooLong = new TextEncoder().encode(value.soul || '').length > BOT_SOUL_MAX_BYTES;
  const standingRoleMissing = value.standingRole.trim().length === 0;
  const objectivesMissing = value.objectives.length === 0;
  const models = botRevisionModelPolicy(value);
  const primary = models?.primary;
  const providers = primary ? botProviderOptionsFor(modelOptions, primary) : [];
  const selectedProvider = providers.find((provider) => provider.id === primary?.providerId);
  const modelChoices = primary ? botModelOptionsFor(selectedProvider, primary) : [];
  const selectedModel = modelChoices.find((model) => model.id === primary?.modelId);
  const variants = [...(selectedModel?.variants ?? [])];
  if (primary?.variant && !variants.some((variant) => variant.id === primary.variant)) {
    variants.unshift({ id: primary.variant, name: primary.variant, available: false });
  }
  const reasoning = value.reasoning as { effort?: unknown };
  const legacyEffort = !primary?.variant
    && typeof reasoning.effort === 'string'
    && selectedModel?.variants.some((variant) => variant.id === reasoning.effort)
    ? reasoning.effort
    : null;
  const selectedVariant = variants.find((variant) => variant.id === (primary?.variant || legacyEffort));
  const compatibleCredentials = primary
    ? compatibleBotCredentials(credentials, primary.providerId)
    : [];
  const credentialAvailable = Boolean(
    primary?.credentialId
    && compatibleCredentials.some((credential) => credential.id === primary.credentialId),
  );
  const providerCatalogAvailable = Boolean(modelOptions?.available);
  const modelCatalogAvailable = Boolean(modelOptions?.available && selectedProvider?.available);

  const updateProvider = (providerId: string) => {
    if (!models || !primary || providerId === BOT_MODEL_UNSELECTED) return;
    onChange(updateBotOverviewProvider(value, providerId, providers, credentials));
  };

  const updatePrimaryModel = (modelId: string) => {
    if (!models || !primary || modelId === BOT_MODEL_UNSELECTED) return;
    onChange(updateBotOverviewPrimaryModel(value, modelId, modelChoices));
  };

  const updateThinking = (next: string) => {
    if (!models || !primary) return;
    onChange(updateBotOverviewThinking(
      value,
      next === PROVIDER_DEFAULT ? undefined : next,
    ));
  };

  return (
    <div className="space-y-7">
      <BotSoulEditor
        botName={botName}
        value={value}
        readOnly={readOnly}
        onChange={onChange}
      />
      {soulTooLong ? (
        <p role="alert" className="typography-micro text-[var(--status-error)]">
          Soul must be 16 KiB or smaller.
        </p>
      ) : null}

      <section className="space-y-3" aria-labelledby="bot-overview-core-identity">
        <div>
          <h3 id="bot-overview-core-identity" className="typography-ui-header font-semibold text-foreground">Role and Objectives</h3>
          <p className="typography-ui text-muted-foreground">Define the Bot's standing responsibility and the outcomes it should work toward.</p>
        </div>
        <fieldset disabled={readOnly} className="grid gap-3">
          <label className="space-y-1 typography-meta text-muted-foreground">
            <span>Standing Role</span>
            <Textarea
              rows={3}
              value={value.standingRole}
              aria-invalid={standingRoleMissing || undefined}
              onChange={(event) => onChange({ ...value, standingRole: event.target.value })}
            />
            {standingRoleMissing ? <span className="block typography-micro text-[var(--status-error)]">Standing Role is required.</span> : null}
          </label>
          <label className="space-y-1 typography-meta text-muted-foreground">
            <span>Objectives · One per Line</span>
            <Textarea
              rows={4}
              value={value.objectives.join('\n')}
              aria-invalid={objectivesMissing || undefined}
              onChange={(event) => onChange({ ...value, objectives: splitLines(event.target.value) })}
            />
            {objectivesMissing ? <span className="block typography-micro text-[var(--status-error)]">Add at least one Objective.</span> : null}
          </label>

          {models && primary ? (
            <div className="grid gap-3 border-t border-border/70 pt-3 sm:grid-cols-3">
              <label className="space-y-1.5 typography-meta text-muted-foreground">
                <span>Provider</span>
                <Select
                  value={primary.providerId || BOT_MODEL_UNSELECTED}
                  onValueChange={updateProvider}
                  disabled={readOnly || !providerCatalogAvailable}
                >
                  <SelectTrigger size="lg" className="w-full">
                    <SelectValue placeholder="Select provider">
                      {selectedProvider
                        ? `${selectedProvider.name}${selectedProvider.available ? '' : ' · Unavailable'}`
                        : primary.providerId}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {providers.length === 0 ? <SelectItem value={BOT_MODEL_UNSELECTED} disabled>No Providers Available</SelectItem> : null}
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
                <Select
                  value={primary.modelId || BOT_MODEL_UNSELECTED}
                  onValueChange={updatePrimaryModel}
                  disabled={readOnly || !modelCatalogAvailable}
                >
                  <SelectTrigger size="lg" className="w-full">
                    <SelectValue placeholder="Select model">
                      {selectedModel
                        ? `${selectedModel.name}${selectedModel.available ? '' : ' · Unavailable'}`
                        : primary.modelId}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {modelChoices.length === 0 ? <SelectItem value={BOT_MODEL_UNSELECTED} disabled>No Models Available</SelectItem> : null}
                    {modelChoices.map((model) => (
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
                  value={primary.variant || legacyEffort || PROVIDER_DEFAULT}
                  onValueChange={updateThinking}
                  disabled={readOnly || !modelCatalogAvailable || !primary.modelId}
                >
                  <SelectTrigger size="lg" className="w-full">
                    <SelectValue>
                      {primary.variant || legacyEffort
                        ? `${selectedVariant?.name || primary.variant || legacyEffort}${selectedVariant?.available === false ? ' · Unavailable' : ''}`
                        : 'Provider Default'}
                    </SelectValue>
                  </SelectTrigger>
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
              {primary.providerId && !credentialAvailable && !readOnly ? (
                <p className="typography-micro text-[var(--status-warning)] sm:col-span-3">
                  Select an active {primary.providerId} credential in Resources.
                  {onNavigateCredentials ? (
                    <button
                      type="button"
                      className="ml-1 underline underline-offset-2"
                      onClick={onNavigateCredentials}
                    >
                      Open Credentials
                    </button>
                  ) : null}
                </p>
              ) : null}
              {!modelCatalogAvailable && !readOnly ? (
                <p className="typography-micro text-muted-foreground sm:col-span-3">
                  The model catalog is unavailable. The current selection is preserved.
                </p>
              ) : null}
            </div>
          ) : (
            <div className="border-t border-border/70 pt-3">
              <p className="typography-meta text-muted-foreground">Model</p>
              <p className="mt-1 typography-ui-label text-foreground">Endpoint-managed model</p>
              <p className="mt-1 typography-micro text-muted-foreground">
                The connected agent chooses the model and Thinking level.
              </p>
              {value.contractVersion === 3 && value.agent.kind === 'ag_ui' && value.agent.modelHint ? (
                <p className="mt-1 typography-micro text-muted-foreground">Model hint: {value.agent.modelHint}</p>
              ) : null}
            </div>
          )}
        </fieldset>
      </section>
    </div>
  );
};
