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
    expect(markup).toContain('Read Magic Prompts settings');
    expect(markup).toContain('Edit Magic Prompts settings');
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

    expect(markup).toContain('Magic Prompts read override: Inherit (Off)');
    expect(markup).toContain('Magic Prompts edit override: Inherit (Off)');
  });

  test('states the inherited value as On or Off, never an ambiguous dot form', () => {
    const inherited = { appearance: { read: true, edit: false } } as SettingsPermissions;
    const markup = renderToStaticMarkup(
      <SettingsPermissionOverrideMatrix overrides={{}} effective={inherited} inherited={inherited} onChange={() => undefined} />,
    );

    expect(markup).toContain('Appearance read override: Inherit (On)');
    expect(markup).toContain('Appearance edit override: Inherit (Off)');
    expect(markup).not.toContain('Inherit ·');
  });
});
