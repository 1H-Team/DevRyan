import React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { SettingsPermissionContext } from '@/lib/settings/permission-state';
import { SettingsOptionCardGroup, type SettingsOptionCard } from './SettingsOptionCardGroup';

type DiffLayout = 'dynamic' | 'inline' | 'side-by-side';

const OPTIONS: readonly SettingsOptionCard<DiffLayout>[] = [
  { value: 'dynamic', label: 'Dynamic', description: 'New inline, modified side-by-side.' },
  { value: 'inline', label: 'Always Inline', description: 'Show as a single unified view.' },
  { value: 'side-by-side', label: 'Always Side-by-Side' },
];

const render = (node: React.ReactNode, canEdit = true): string => renderToStaticMarkup(
  <SettingsPermissionContext.Provider value={{ slug: 'appearance', canEdit }}>
    {node}
  </SettingsPermissionContext.Provider>,
);

describe('SettingsOptionCardGroup', () => {
  test('renders a labelled radio group with one checked radio per option', () => {
    const markup = render(
      <SettingsOptionCardGroup
        value="inline"
        options={OPTIONS}
        onValueChange={() => {}}
        aria-labelledby="diff-label"
        aria-describedby="diff-description"
      />,
    );

    expect(markup).toContain('role="radiogroup"');
    expect(markup).toContain('aria-labelledby="diff-label"');
    expect(markup).toContain('aria-describedby="diff-description"');
    expect(markup.match(/role="radio"/g)).toHaveLength(3);
    expect(markup.match(/aria-checked="true"/g)).toHaveLength(1);
    expect(/aria-checked="true"[^>]*>(?:(?!role="radio").)*Always Inline/.test(markup)).toBe(true);
    expect(markup).toContain('Show as a single unified view.');
    expect(markup).toContain('@container');
  });

  test('compact chips skip descriptions and the container wrapper', () => {
    const markup = render(
      <SettingsOptionCardGroup value="dynamic" options={OPTIONS} onValueChange={() => {}} size="compact" aria-label="Diff Layout" />,
    );

    expect(markup).toContain('aria-label="Diff Layout"');
    expect(markup).not.toContain('New inline, modified side-by-side.');
    expect(markup).not.toContain('@container');
  });

  test('is read-only for viewers without edit permission', () => {
    const markup = render(
      <SettingsOptionCardGroup value="dynamic" options={OPTIONS} onValueChange={() => {}} aria-label="Diff Layout" />,
      false,
    );

    expect(markup).toContain('aria-readonly="true"');
  });
});
