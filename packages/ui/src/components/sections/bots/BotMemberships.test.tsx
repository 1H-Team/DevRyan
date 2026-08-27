import React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';
import { BotMemberships } from './BotMemberships';
import { canRevokeBotMembership } from './botManagementPresentation';
import { managementDetail, OTHER_USER_ID, USER_ID } from './botManagementTestFixtures';

describe('BotMemberships', () => {
  test('protects the final person with settings access', () => {
    const memberships = managementDetail().memberships;
    expect(canRevokeBotMembership(memberships, USER_ID)).toEqual({
      allowed: false,
      reason: 'At least one person must retain access to Bot settings.',
    });
  });

  test('allows assignment and revocation without exposing role controls', () => {
    const memberships = [
      ...managementDetail().memberships,
      { ...managementDetail().memberships[0], userId: OTHER_USER_ID },
    ];
    expect(canRevokeBotMembership(memberships, USER_ID).allowed).toBe(true);

    const markup = renderToStaticMarkup(
      <I18nProvider>
        <BotMemberships
          botId="b0000000-0000-4000-8000-000000000001"
          memberships={memberships}
          onAssign={() => {}}
          onRevoke={() => {}}
        />
      </I18nProvider>,
    );
    expect(markup).toContain('Add a Member');
    expect(markup).toContain('Member');
    expect(markup).not.toContain('Operator');
    expect(markup).not.toContain('Manager</');
    expect(markup).not.toContain('Role');
    expect(markup).toContain(`Remove ${USER_ID}`);
  });

  test('shows a person by name and email instead of a raw id', () => {
    const base = managementDetail().memberships[0];
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <BotMemberships
          botId="b0000000-0000-4000-8000-000000000001"
          readOnly
          memberships={[{ ...base, displayName: 'Ada Lovelace', email: 'ada@example.com' }]}
          onAssign={() => {}}
          onRevoke={() => {}}
        />
      </I18nProvider>,
    );
    expect(markup).toContain('Ada Lovelace');
    expect(markup).toContain('ada@example.com');
    expect(markup).not.toContain(USER_ID);
  });
});
