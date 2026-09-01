import {
  botRevisionModelPolicy,
  type BotCredentialMetadata,
  type BotModelOption,
  type BotProviderOption,
  type BotRevisionContract,
  withBotRevisionModelPolicy,
} from '@/lib/botsApi';
import {
  compatibleBotCredentials,
  updateBotModelProvider,
  updateBotModelSelection,
} from './botRevisionModelPresentation';

const sameStringList = (left: readonly string[], right: readonly string[]): boolean => (
  left.length === right.length && left.every((value, index) => value === right[index])
);

const primaryModelChanged = (
  current: BotRevisionContract,
  original: BotRevisionContract,
): boolean => {
  const currentPrimary = botRevisionModelPolicy(current)?.primary;
  const originalPrimary = botRevisionModelPolicy(original)?.primary;
  if (!currentPrimary || !originalPrimary) return currentPrimary !== originalPrimary;
  const currentLegacyEffort = typeof current.reasoning.effort === 'string' ? current.reasoning.effort : undefined;
  const originalLegacyEffort = typeof original.reasoning.effort === 'string' ? original.reasoning.effort : undefined;
  return currentPrimary.providerId !== originalPrimary.providerId
    || currentPrimary.modelId !== originalPrimary.modelId
    || currentPrimary.credentialId !== originalPrimary.credentialId
    || currentPrimary.variant !== originalPrimary.variant
    || currentLegacyEffort !== originalLegacyEffort
    || !sameStringList(currentPrimary.egressHosts, originalPrimary.egressHosts);
};

export const botCoreIdentityChanged = (
  current: BotRevisionContract,
  original: BotRevisionContract,
): boolean => (
  current.soul !== original.soul
  || current.standingRole !== original.standingRole
  || current.objectives.length !== original.objectives.length
  || current.objectives.some((objective, index) => objective !== original.objectives[index])
  || primaryModelChanged(current, original)
);

export const updateBotOverviewPrimaryModel = (
  value: BotRevisionContract,
  modelId: string,
  modelChoices: readonly BotModelOption[],
): BotRevisionContract => {
  const models = botRevisionModelPolicy(value);
  if (!models) return value;
  return withBotRevisionModelPolicy(value, {
    ...models,
    primary: updateBotModelSelection(models.primary, modelId, modelChoices),
  });
};

export const updateBotOverviewProvider = (
  value: BotRevisionContract,
  providerId: string,
  providers: readonly BotProviderOption[],
  credentials: readonly BotCredentialMetadata[],
): BotRevisionContract => {
  const models = botRevisionModelPolicy(value);
  if (!models) return value;

  const updatedPrimary = updateBotModelProvider({
    binding: models.primary,
    providerId,
    providers,
    credentials,
  });
  const compatibleCredentials = compatibleBotCredentials(credentials, providerId);
  const primary = {
    ...updatedPrimary,
    credentialId: updatedPrimary.credentialId
      || (compatibleCredentials.length === 1 ? compatibleCredentials[0]?.id ?? '' : ''),
  };
  const selectedProvider = providers.find((provider) => provider.id === providerId);
  const selectedModel = selectedProvider?.models.find((model) => model.id === primary.modelId);
  const reasoning = { ...value.reasoning } as Record<string, unknown>;
  const legacyEffort = typeof reasoning.effort === 'string' ? reasoning.effort : null;
  if (legacyEffort && !selectedModel?.variants.some((variant) => variant.id === legacyEffort)) {
    delete reasoning.effort;
  }

  return {
    ...withBotRevisionModelPolicy(value, {
      ...models,
      primary,
    }),
    reasoning,
  };
};

export const updateBotOverviewThinking = (
  value: BotRevisionContract,
  variant: string | undefined,
): BotRevisionContract => {
  const models = botRevisionModelPolicy(value);
  if (!models) return value;
  const reasoning = { ...value.reasoning } as Record<string, unknown>;
  delete reasoning.effort;
  return {
    ...withBotRevisionModelPolicy(value, {
      ...models,
      primary: { ...models.primary, variant },
    }),
    reasoning,
  };
};
