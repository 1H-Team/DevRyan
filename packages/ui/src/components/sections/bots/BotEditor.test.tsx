import React from 'react';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';
import { BotEditor } from './BotEditor';
import { managementDetail } from './botManagementTestFixtures';

const source = readFileSync(new URL('./BotEditor.tsx', import.meta.url), 'utf8');
const credentialsSource = readFileSync(new URL('./BotCredentials.tsx', import.meta.url), 'utf8');

const editor = () => renderToStaticMarkup(
  <I18nProvider>
    <BotEditor
      detail={managementDetail()}
      activationHealth={null}
      onAssignMembership={() => {}}
      onRevokeMembership={() => {}}
      onSaveCredential={() => {}}
      onTransition={() => {}}
      onPublishRevision={() => {}}
    />
  </I18nProvider>,
);

describe('BotEditor information architecture', () => {
  test('uses the simplified Overview-first settings order', () => {
    const labels = ['Overview', 'Resources', 'Memory', 'Members', 'Routines', 'Lifecycle'];
    let previousIndex = -1;
    for (const label of labels) {
      const nextIndex = source.indexOf(`label: '${label}'`);
      expect(nextIndex).toBeGreaterThan(previousIndex);
      previousIndex = nextIndex;
    }
    for (const removed of ['Files', 'Permissions', 'Advanced', 'Credentials', 'Test Lab']) {
      expect(source).not.toContain(`label: '${removed}'`);
    }
  });

  test('restores the core identity fields without the removed advanced fields', () => {
    const markup = editor();
    expect(markup).toContain('Overview</button>');
    expect(markup).toContain('Profile');
    expect(markup).toContain('Description');
    expect(markup).toContain('Soul');
    expect(markup).toContain('Personality &amp; Values');
    expect(markup).toContain('Standing Role');
    expect(markup).toContain('Objectives · One per Line');
    expect(markup).toContain('Provider');
    expect(markup).toContain('Model');
    expect(markup).toContain('Thinking');
    expect(markup).toContain('Status');
    expect(markup).not.toContain('Short Summary');
    expect(markup).not.toContain('Operating Instructions');
    expect(markup).not.toContain('Prohibited Instructions');
    expect(markup).not.toContain('Extra Instructions');
    expect(markup).not.toContain('Maximum Output Tokens');
    expect(markup).toContain('Apply Changes');
  });

  test('consolidates computer files, Skills, credentials, and secrets in Resources', () => {
    const resourcesStart = source.indexOf("tab === 'resources'");
    const resourcesEnd = source.indexOf("tab === 'memory'", resourcesStart);
    const resources = source.slice(resourcesStart, resourcesEnd);

    expect(resources).toContain('<BotComputerFiles');
    expect(resources).toContain('<BotSkills');
    expect(resources).toContain('<BotCredentials');
    expect(resources).toContain('<BotEnvironmentSecrets');
    expect(resources).toContain('Built-in access');
    expect(resources).not.toContain('BotLibrary');
    expect(resources).not.toContain('MCP');
    expect(resources).not.toContain('BotRevisionForm');
  });

  test('keeps the Overview form mounted and resets it for another Bot', () => {
    expect(source).toContain("<div hidden={tab !== 'overview'} className=\"space-y-7\">");
    expect(source).not.toContain("{tab === 'overview' ? (");
    expect(source).toContain('onEditChange={setProfileEdit}');
    expect(source).toContain('const [contractDraft, setContractDraft]');
    expect(source).toContain('setContractDraft(authoritativeContractRef.current);');
    expect(source).toContain('selectedRevision?.updatedAt');
    expect(source).toContain('botCoreIdentityChanged(contractDraft, contract)');
    expect(source).toContain('name: detail.bot.name');
    expect(source).toContain('title: detail.bot.title');
    expect(source).toContain('[detail.bot.avatarFallback, detail.bot.avatarUrl, detail.bot.id, detail.bot.name, detail.bot.summary, detail.bot.title]');
  });

  test('publishes identity edits but leaves profile-only changes on the immediate save path', () => {
    expect(source).toContain('const publishesRevision = Boolean(workingRevision || contractDirty);');
    expect(source).toContain('{publishesRevision ? (');
    expect(source).toContain('onSaveProfile?.(profileEdit.request)');
    expect(source).toContain('onPublishRevision(selectedRevision, contractDraft, profileEdit.request);');
  });

  test('keeps provider credentials Bot-owned and write-only', () => {
    expect(credentialsSource).toContain('selectedProvider?.connections');
    expect(credentialsSource).toContain('oauthConnections.map');
    expect(credentialsSource).toContain('connectionId');
    expect(credentialsSource).toContain('ownerUserId: null');
    expect(credentialsSource).toContain('type="password"');
    expect(credentialsSource).toContain('autoComplete="new-password"');
    expect(credentialsSource).not.toContain('Owner User UUID');
  });

  test('routes relevant activation failures to Resources without restoring Permissions', () => {
    expect(source).toContain("if (['models', 'egress', 'tools', 'policy', 'library', 'skills'].includes(gate.id)) return 'resources';");
    expect(source).toContain("gate.id === 'images'");
    expect(source).toContain("activationHealth?.gates.filter((gate) => gate.status === 'fail')");
    expect(source).not.toContain("return 'permissions'");
  });

  test('contains no user-facing revision, bundle, retirement, or autonomous-default workflow', () => {
    for (const copy of [
      'Save Draft',
      'Publish Draft',
      'Import Revision',
      'Recovery Bundle',
      'Apply Autonomous Defaults',
      'Retire',
    ]) expect(source).not.toContain(copy);
  });
});
