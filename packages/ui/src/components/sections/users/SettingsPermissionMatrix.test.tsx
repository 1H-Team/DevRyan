import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'bun:test';

import type { SettingsPermissions } from '@/lib/settings/permissions';
import { SettingsPermissionMatrix, SettingsPermissionOverrideMatrix } from './SettingsPermissionMatrix';

describe('Settings permission matrices', () => {
  test('renders a legacy partial role payload as a complete deny-safe matrix', () => {
    const partial = {
      appearance: { read: true, edit: true },
    } as SettingsPermissions;

    const markup = renderToStaticMarkup(
      <SettingsPermissionMatrix permissions={partial} onChange={() => undefined} />,
    );

    expect(markup).toContain('Read Appearance settings');
    expect(markup).toContain('Read Bots settings');
    expect(markup).toContain('Edit Bots settings');
  });

  test('renders partial effective and inherited payloads without dereferencing missing cells', () => {
    const partial = {
      appearance: { read: true, edit: true },
    } as SettingsPermissions;

    const markup = renderToStaticMarkup(
      <SettingsPermissionOverrideMatrix
        overrides={{}}
        effective={partial}
        inherited={partial}
        onChange={() => undefined}
      />,
    );

    expect(markup).toContain('Bots read override: Inherit (Off)');
    expect(markup).toContain('Bots edit override: Inherit (Off)');
  });
});
