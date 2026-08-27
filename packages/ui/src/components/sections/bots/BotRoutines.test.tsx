import React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';
import type { BotRoutineContract, BotsApi } from '@/lib/botsApi';
import { BotEditor } from './BotEditor';
import { BotRoutines } from './BotRoutines';
import { RoutineDraftReview } from './RoutineDraftReview';
import { RoutineEditor } from './RoutineEditor';
import { managementDetail } from './botManagementTestFixtures';

const BOT_ID = '11111111-1111-4111-8111-111111111111';

const routineContract: BotRoutineContract = {
  version: 1,
  rationale: 'Review approved support work each morning.',
  trigger: { kind: 'daily', time: '09:30' },
  timezone: 'Africa/Casablanca',
  goal: 'Summarize priority tickets and update one reviewed status.',
  inputs: { queue: 'priority' },
  allowedTools: ['connector:zendesk'],
  allowedAccountIds: ['22222222-2222-4222-8222-222222222222'],
  allowedOrigins: ['https://support.example.com'],
  limits: { maxActions: 10, maxExternalWrites: 1 },
  approvalClass: 'requester',
  timeoutSeconds: 600,
  missedPolicy: 'run_once',
  missedRunCap: 1,
  completionCriteria: ['Every priority ticket has a summary.'],
};

const editorCallbacks = {
  onAssignMembership: () => {},
  onRevokeMembership: () => {},
  onSaveCredential: () => {},
  onTransition: () => {},
};

describe('BotRoutines', () => {
  test('presents background scheduling without runtime implementation details', () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <BotRoutines botId={BOT_ID} api={{} as BotsApi} />
      </I18nProvider>,
    );
    expect(markup).toContain('Scheduled routines');
    expect(markup).toContain('even after this window closes');
    expect(markup).toContain('Draft Routine');
    expect(markup).not.toContain('Compatibility mode');
  });

  test('keeps the routine editor focused on schedule and outcome', () => {
    const markup = renderToStaticMarkup(
      <RoutineEditor
        initialName="Morning support"
        initialContract={routineContract}
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );
    for (const label of [
      'Trigger type', 'IANA timezone', 'Goal', 'Timeout (seconds)', 'Completion criteria',
    ]) expect(markup).toContain(label);
    for (const removed of [
      'Inputs JSON', 'Allowed tools', 'Allowed account UUIDs', 'Allowed HTTP(S) origins',
      'Max actions', 'Max writes', 'Approval class', 'Missed-run policy', 'Replay cap',
    ]) expect(markup).not.toContain(removed);
  });

  test('requires a concise review before the activation action is enabled', () => {
    const markup = renderToStaticMarkup(
      <RoutineDraftReview
        contract={routineContract}
        actionLabel="Activate Reviewed Routine"
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(markup).toContain('Review the executable contract');
    expect(markup).toContain('Consequential actions pause and ask the requesting user for confirmation.');
    expect(markup).toContain('I reviewed this routine&#x27;s schedule, goal, and completion criteria.');
    expect(markup).not.toContain('connector:zendesk');
    expect(markup).not.toContain('https://support.example.com');
    expect(markup).toContain('disabled=""');
    expect(markup).toContain('Activate Reviewed Routine');
  });

  test('exposes routine settings only to users with Bot settings access', () => {
    const managerMarkup = renderToStaticMarkup(
      <I18nProvider>
        <BotEditor
          detail={managementDetail()}
          activationHealth={null}
          {...editorCallbacks}
        />
      </I18nProvider>,
    );
    const memberMarkup = renderToStaticMarkup(
      <I18nProvider>
        <BotEditor
          detail={{ ...managementDetail(), canManage: false }}
          activationHealth={null}
          {...editorCallbacks}
        />
      </I18nProvider>,
    );
    expect(managerMarkup).toContain('Routines</button>');
    expect(memberMarkup).not.toContain('Routines</button>');
  });
});
