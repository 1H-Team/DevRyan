import React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';
import {
  botRevisionModelPolicy,
  type BotCredentialMetadata,
  type BotModelOptions,
  withBotRevisionAgent,
} from '@/lib/botsApi';
import { BotCoreIdentityEditor } from './BotCoreIdentityEditor';
import {
  botCoreIdentityChanged,
  updateBotOverviewPrimaryModel,
  updateBotOverviewProvider,
  updateBotOverviewThinking,
} from './botCoreIdentityPresentation';
import { createDefaultBotRevisionContract } from './botManagementPresentation';

describe('BotCoreIdentityEditor', () => {
  const credential = (
    id: string,
    provider: string,
    status = 'active',
  ): BotCredentialMetadata => ({
    id,
    provider,
    label: `${provider} credential`,
    kind: 'api_key',
    scope: 'team',
    maskedIdentifier: null,
    status,
    version: 1,
    createdAt: '2026-08-30T00:00:00.000Z',
    updatedAt: '2026-08-30T00:00:00.000Z',
    rotatedAt: null,
  });
  const modelOptions: BotModelOptions = {
    available: true,
    providers: [
      {
        id: 'openai',
        name: 'OpenAI',
        available: true,
        authType: 'api',
        connections: [],
        models: [{
          id: 'gpt-5.6-sol',
          name: 'GPT-5.6 Sol',
          providerId: 'openai',
          available: true,
          variants: [
            { id: 'medium', name: 'Medium', available: true },
            { id: 'high', name: 'High', available: true },
          ],
          contextLimit: 128_000,
          reviewedEgressHosts: ['api.openai.com'],
          egressReviewed: true,
        }],
      },
      {
        id: 'anthropic',
        name: 'Anthropic',
        available: true,
        authType: 'api',
        connections: [],
        models: [{
          id: 'claude-opus',
          name: 'Claude Opus',
          providerId: 'anthropic',
          available: true,
          variants: [{ id: 'low', name: 'Low', available: true }],
          contextLimit: 200_000,
          reviewedEgressHosts: ['api.anthropic.com'],
          egressReviewed: true,
        }],
      },
    ],
  };

  test('renders only the restored core revision fields', () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <BotCoreIdentityEditor
          botName="Research Desk"
          value={createDefaultBotRevisionContract('Research Desk')}
          modelOptions={modelOptions}
          onChange={() => {}}
        />
      </I18nProvider>,
    );

    expect(markup).toContain('Soul');
    expect(markup).toContain('Personality &amp; Values');
    expect(markup).toContain('Standing Role');
    expect(markup).toContain('Objectives · One per Line');
    expect(markup).toContain('Provider');
    expect(markup).toContain('OpenAI');
    expect(markup).toContain('Model');
    expect(markup).toContain('GPT-5.6 Sol');
    expect(markup).toContain('Thinking');
    expect(markup).toContain('Provider Default');
    expect(markup).not.toContain('Operating Instructions');
    expect(markup).not.toContain('Prohibited Instructions');
    expect(markup).not.toContain('Extra Instructions');
    expect(markup).not.toContain('Maximum Output Tokens');
    expect(markup.indexOf('<span>Provider</span>')).toBeLessThan(markup.indexOf('<span>Model</span>'));
    expect(markup.indexOf('<span>Model</span>')).toBeLessThan(markup.indexOf('<span>Thinking</span>'));
  });

  test('offers a direct path to Resources when the provider needs a credential', () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <BotCoreIdentityEditor
          botName="Research Desk"
          value={createDefaultBotRevisionContract('Research Desk')}
          modelOptions={modelOptions}
          onChange={() => {}}
          onNavigateCredentials={() => {}}
        />
      </I18nProvider>,
    );

    expect(markup).toContain('Select an active openai credential in Resources.');
    expect(markup).toContain('Open Credentials');
  });

  test('detects core identity and primary model edits without mutating the authoritative contract', () => {
    const original = createDefaultBotRevisionContract('Research Desk');
    const unrelatedEdit = {
      ...original,
      reasoning: { maxOutputTokens: 8_192 },
    };
    const edited = {
      ...original,
      soul: `${original.soul}\nBe curious.`,
      standingRole: 'Own research outcomes.',
      objectives: ['Answer accurately.', 'Cite evidence.'],
    };
    const modelEdited = {
      ...original,
      models: {
        ...original.models,
        primary: { ...original.models.primary, variant: 'high' },
      },
    };

    expect(botCoreIdentityChanged(original, original)).toBe(false);
    expect(botCoreIdentityChanged(unrelatedEdit, original)).toBe(false);
    expect(botCoreIdentityChanged(edited, original)).toBe(true);
    expect(botCoreIdentityChanged(modelEdited, original)).toBe(true);
    expect(original.standingRole).toBe('You are a capable DevRyan Bot.');
    expect(original.objectives).toEqual(['Help people complete their requests.']);
  });

  test('shows required-field errors and disables editing in read-only mode', () => {
    const contract = {
      ...createDefaultBotRevisionContract(),
      standingRole: '',
      objectives: [],
    };
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <BotCoreIdentityEditor botName="Reader" value={contract} readOnly onChange={() => {}} />
      </I18nProvider>,
    );

    expect(markup).toContain('Standing Role is required.');
    expect(markup).toContain('Add at least one Objective.');
    expect(markup).toContain('<fieldset disabled=""');
  });

  test('shows the existing Soul size limit', () => {
    const contract = {
      ...createDefaultBotRevisionContract(),
      soul: 'x'.repeat((16 * 1024) + 1),
    };
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <BotCoreIdentityEditor botName="Large Soul" value={contract} onChange={() => {}} />
      </I18nProvider>,
    );

    expect(markup).toContain('Soul must be 16 KiB or smaller.');
  });

  test('preserves unavailable model selections and disables their controls', () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <BotCoreIdentityEditor
          botName="Offline Bot"
          value={createDefaultBotRevisionContract('Offline Bot')}
          onChange={() => {}}
        />
      </I18nProvider>,
    );

    expect(markup).toContain('gpt-5.6-sol · Unavailable');
    expect(markup).toContain('The model catalog is unavailable. The current selection is preserved.');
    expect(markup).toContain('disabled=""');
  });

  test('shows endpoint-managed model details for AG-UI Bots', () => {
    const original = createDefaultBotRevisionContract('Remote Bot');
    const contract = withBotRevisionAgent(original, {
        kind: 'ag_ui',
        connectionRef: 'connection-1',
        connectionDigest: 'a'.repeat(64),
        modelHint: 'remote-research-model',
      });
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <BotCoreIdentityEditor botName="Remote Bot" value={contract} onChange={() => {}} />
      </I18nProvider>,
    );

    expect(markup).toContain('Endpoint-managed model');
    expect(markup).toContain('The connected agent chooses the model and Thinking level.');
    expect(markup).toContain('Model hint: remote-research-model');
  });

  test('changes only the primary model and its model-dependent fields', () => {
    const original = createDefaultBotRevisionContract('Research Desk');
    const fallback = {
      ...original.models.primary,
      modelId: 'fallback-model',
    };
    const value = {
      ...original,
      models: {
        primary: {
          ...original.models.primary,
          credentialId: 'credential-1',
          variant: 'high',
        },
        fallbacks: [fallback],
      },
    };
    const next = updateBotOverviewPrimaryModel(value, 'gpt-5.6-fast', [{
      ...modelOptions.providers[0]!.models[0]!,
      id: 'gpt-5.6-fast',
      name: 'GPT-5.6 Fast',
      variants: [{ id: 'low', name: 'Low', available: true }],
      reviewedEgressHosts: ['fast.openai.com'],
    }]);
    const nextModels = botRevisionModelPolicy(next)!;

    expect(nextModels.primary.providerId).toBe(value.models.primary.providerId);
    expect(nextModels.primary.credentialId).toBe('credential-1');
    expect(nextModels.primary.modelId).toBe('gpt-5.6-fast');
    expect(nextModels.primary.egressHosts).toEqual(['fast.openai.com']);
    expect(nextModels.primary.variant).toBe(undefined);
    expect(nextModels.fallbacks[0]).toBe(fallback);
  });

  test('changes provider without touching fallbacks or unrelated identity fields', () => {
    const original = createDefaultBotRevisionContract('Research Desk');
    const fallback = { ...original.models.primary, modelId: 'fallback-model' };
    const value = {
      ...original,
      reasoning: { ...original.reasoning, effort: 'high' },
      models: {
        primary: {
          ...original.models.primary,
          credentialId: 'openai-credential',
          variant: 'high',
        },
        fallbacks: [fallback],
      },
    };
    const next = updateBotOverviewProvider(
      value,
      'anthropic',
      modelOptions.providers,
      [credential('anthropic-credential', 'anthropic')],
    );
    const nextModels = botRevisionModelPolicy(next)!;

    expect(nextModels.primary).toEqual({
      providerId: 'anthropic',
      modelId: '',
      credentialId: 'anthropic-credential',
      egressHosts: [],
      variant: undefined,
    });
    expect(nextModels.fallbacks[0]).toBe(fallback);
    expect('effort' in next.reasoning).toBe(false);
    expect(next.soul).toBe(value.soul);
    expect(next.standingRole).toBe(value.standingRole);
    expect(next.objectives).toBe(value.objectives);
  });

  test('preserves a compatible selection and clears ambiguous credentials', () => {
    const original = createDefaultBotRevisionContract('Research Desk');
    const fallback = { ...original.models.primary, modelId: 'fallback-model' };
    const anthropicModel = modelOptions.providers[1]!.models[0]!;
    const value = {
      ...original,
      models: {
        primary: {
          providerId: 'anthropic',
          modelId: anthropicModel.id,
          credentialId: 'anthropic-credential',
          egressHosts: anthropicModel.reviewedEgressHosts,
          variant: 'low',
        },
        fallbacks: [fallback],
      },
    };
    const preserved = updateBotOverviewProvider(
      value,
      'anthropic',
      modelOptions.providers,
      [credential('anthropic-credential', 'anthropic')],
    );
    const ambiguous = updateBotOverviewProvider(
      { ...value, models: { ...value.models, primary: { ...value.models.primary, credentialId: 'revoked' } } },
      'anthropic',
      modelOptions.providers,
      [
        credential('anthropic-a', 'anthropic'),
        credential('anthropic-b', 'anthropic'),
        credential('revoked', 'anthropic', 'revoked'),
      ],
    );

    expect(botRevisionModelPolicy(preserved)!.primary).toEqual(value.models.primary);
    expect(botRevisionModelPolicy(preserved)!.fallbacks[0]).toBe(fallback);
    expect(botRevisionModelPolicy(ambiguous)!.primary.credentialId).toBe('');
  });

  test('changes primary Thinking and removes the legacy effort without touching fallbacks', () => {
    const original = createDefaultBotRevisionContract('Research Desk');
    const fallback = { ...original.models.primary, modelId: 'fallback-model' };
    const value = {
      ...original,
      reasoning: { ...original.reasoning, effort: 'medium' },
      models: { ...original.models, fallbacks: [fallback] },
    };
    const next = updateBotOverviewThinking(value, 'high');
    const nextModels = botRevisionModelPolicy(next)!;

    expect(nextModels.primary.variant).toBe('high');
    expect('effort' in next.reasoning).toBe(false);
    expect(nextModels.fallbacks[0]).toBe(fallback);
  });
});
