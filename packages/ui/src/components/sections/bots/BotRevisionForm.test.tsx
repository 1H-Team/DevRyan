import React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';
import type { BotCredentialMetadata, BotModelBinding, BotModelOptions } from '@/lib/botsApi';
import { BotOperatingBrief, BotRevisionForm, BotSoulEditor } from './BotRevisionForm';
import {
  botModelOptionsFor,
  botProviderOptionsFor,
  compatibleBotCredentials,
  reorderBotModelFallbacks,
  updateBotModelProvider,
  updateBotModelSelection,
} from './botRevisionModelPresentation';
import {
  createDefaultBotRevisionContract,
  validateBotRevisionConfiguration,
} from './botManagementPresentation';

describe('BotRevisionForm', () => {
  test('renders every structured runtime-bearing revision section', () => {
    const contract = createDefaultBotRevisionContract('Operations Desk');
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <>
          <BotSoulEditor value={contract} onChange={() => {}} />
          <BotOperatingBrief value={contract} onChange={() => {}} />
          <BotRevisionForm
            value={contract}
            revisionNumber={3}
            onChange={() => {}}
            onPublish={() => {}}
          />
        </>
      </I18nProvider>,
    );

    for (const label of [
      'Soul',
      'Instructions',
      'Standing Role',
      'Objectives',
      'Model Order and Reasoning',
      'Provider',
      'Model',
      'Thinking',
      'Connection Details',
      'File Access',
      'Allowed file tools',
      'Browser and Action Policy',
      // Advanced prompt text moved onto Overview, beside the instructions.
      'Extra Instructions',
      'Maximum Output Tokens',
      'Save &amp; Publish',
    ]) expect(markup).toContain(label);
    expect(markup).not.toContain('Computer Tenancy');
    expect(markup).not.toContain('Reasoning Effort');
    // Server-derived plumbing must never appear as an editable field.
    expect(markup).not.toContain('Published Library Version IDs');
    expect(markup).not.toContain('Gateway Tool Manifest');
  });

  test('keeps published revisions read only and offers an implementation-neutral edit action', () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <BotRevisionForm
          value={createDefaultBotRevisionContract()}
          revisionNumber={1}
          readOnly
          conflict
          onChange={() => {}}
          onEditConfiguration={() => {}}
        />
      </I18nProvider>,
    );

    expect(markup).toContain('Published revision 1 · read only');
    expect(markup).toContain('Edit Configuration');
    expect(markup).toContain('409 revision conflict');
    expect(markup).not.toContain('Draft');
  });

  test('rejects incomplete activation-bearing fields before save', () => {
    const contract = createDefaultBotRevisionContract();
    const result = validateBotRevisionConfiguration({
      ...contract,
      standingRole: '',
      models: { ...contract.models, primary: { ...contract.models.primary, egressHosts: [] } },
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Standing role is required.');
    expect(result.errors).toContain('Primary model needs at least one reviewed egress host.');
  });

  test('cascades provider, model, thinking, and credential changes without replacing valid dependents', () => {
    const options: BotModelOptions = {
      available: true,
      providers: [{
        id: 'openai', name: 'OpenAI', available: true, authType: 'api', connections: [], models: [{
          id: 'shared', name: 'Shared', providerId: 'openai', available: true,
          variants: [{ id: 'high', name: 'High', available: true }],
          contextLimit: 128_000, reviewedEgressHosts: ['api.openai.com:443'], egressReviewed: true,
        }, {
          id: 'fast', name: 'Fast', providerId: 'openai', available: true,
          variants: [{ id: 'low', name: 'Low', available: true }],
          contextLimit: 32_000, reviewedEgressHosts: ['fast.openai.com:443'], egressReviewed: true,
        }],
      }, {
        id: 'anthropic', name: 'Anthropic', available: true, authType: 'api', connections: [], models: [{
          id: 'shared', name: 'Shared', providerId: 'anthropic', available: true,
          variants: [{ id: 'high', name: 'High', available: true }],
          contextLimit: 64_000, reviewedEgressHosts: ['api.anthropic.com:443'], egressReviewed: true,
        }],
      }],
    };
    const credentials: BotCredentialMetadata[] = [{
      id: 'f0000000-0000-4000-8000-000000000001', provider: 'anthropic', label: 'Production',
      kind: 'api_key', scope: 'team', maskedIdentifier: '••••1234', status: 'active', version: 1,
      createdAt: '2026-08-23T00:00:00.000Z', updatedAt: '2026-08-23T00:00:00.000Z', rotatedAt: null,
    }];
    const binding: BotModelBinding = {
      providerId: 'openai', modelId: 'shared', credentialId: '',
      variant: 'high', egressHosts: ['api.openai.com:443'],
    };
    const switched = updateBotModelProvider({
      binding,
      providerId: 'anthropic',
      providers: options.providers,
      credentials,
    });
    expect(switched.providerId).toBe('anthropic');
    expect(switched.modelId).toBe('shared');
    expect(switched.variant).toBe('high');
    expect(switched.egressHosts).toEqual(['api.anthropic.com:443']);
    expect(switched.credentialId).toBe('');

    const changedModel = updateBotModelSelection(
      binding,
      'fast',
      options.providers[0]?.models ?? [],
    );
    expect(changedModel.modelId).toBe('fast');
    expect(changedModel.variant).toBe(undefined);
    expect(changedModel.egressHosts).toEqual(['fast.openai.com:443']);

    const incompatible = updateBotModelProvider({
      binding: { ...binding, modelId: 'fast' },
      providerId: 'anthropic',
      providers: options.providers,
      credentials,
    });
    expect(incompatible.modelId).toBe('');
    expect(incompatible.credentialId).toBe('');
    expect(incompatible.egressHosts).toEqual([]);
    expect(incompatible.variant).toBe(undefined);
    expect(compatibleBotCredentials(credentials, 'anthropic')).toHaveLength(1);
  });

  test('preserves unavailable selections and reorders fallbacks deterministically', () => {
    const unavailable: BotModelBinding = {
      providerId: 'retired-provider', modelId: 'retired-model', credentialId: '',
      variant: 'deep', egressHosts: ['retired.example:443'],
    };
    const providers = botProviderOptionsFor(null, unavailable);
    expect(providers[0]?.id).toBe('retired-provider');
    expect(providers[0]?.available).toBe(false);
    expect(botModelOptionsFor(providers[0], unavailable)[0]?.id).toBe('retired-model');
    expect(botModelOptionsFor(providers[0], unavailable)[0]?.available).toBe(false);

    const second = { ...unavailable, providerId: 'second-provider' };
    expect(reorderBotModelFallbacks([unavailable, second], 1, -1)).toEqual([second, unavailable]);
    const unchanged = [unavailable];
    expect(reorderBotModelFallbacks(unchanged, 0, -1)).toBe(unchanged);
  });
});
