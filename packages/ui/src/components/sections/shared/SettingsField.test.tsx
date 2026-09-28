import React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';
import { SettingsPermissionContext } from '@/lib/settings/permission-state';
import { SettingsField, SettingsSwitchField } from './SettingsField';

const render = (node: React.ReactNode, canEdit = true): string => renderToStaticMarkup(
  <I18nProvider>
    <SettingsPermissionContext.Provider value={{ slug: 'appearance', canEdit }}>
      {node}
    </SettingsPermissionContext.Provider>
  </I18nProvider>,
);

const attribute = (markup: string, pattern: RegExp): string => {
  const match = markup.match(pattern);
  if (!match?.[1]) throw new Error(`No match for ${pattern}`);
  return match[1];
};

describe('SettingsField', () => {
  test('wires the label, description and badge ids into the control', () => {
    const markup = render(
      <SettingsField label="Code Font" description="Used for code blocks." badge={<span>Mobile Only</span>}>
        {({ labelId, describedBy }) => <button type="button" aria-labelledby={labelId} aria-describedby={describedBy}>Font</button>}
      </SettingsField>,
    );

    const labelId = attribute(markup, /<span id="([^"]+)"[^>]*>Code Font<\/span>/);
    const descriptionId = attribute(markup, /<p id="([^"]+)"[^>]*>Used for code blocks\.<\/p>/);
    const badgeId = attribute(markup, /<span id="([^"]+)" class="inline-flex"><span>Mobile Only/);

    expect(markup).toContain(`aria-labelledby="${labelId}"`);
    expect(markup).toContain(`aria-describedby="${descriptionId} ${badgeId}"`);
    expect(markup).toContain('data-settings-field');
  });

  test('renders a label element that targets the control when requested', () => {
    const markup = render(
      <SettingsField label="Chat Width" labelTargetsControl>
        {({ controlId }) => <input id={controlId} type="range" />}
      </SettingsField>,
    );

    const controlId = attribute(markup, /<input id="([^"]+)" type="range"/);
    expect(markup).toContain(`for="${controlId}"`);
    expect(markup).not.toContain('aria-describedby');
  });

  test('marks the reset button as mutating and disables it at the default', () => {
    const atDefault = render(
      <SettingsField label="Spacing Density" reset={{ onReset: () => {}, disabled: true, ariaLabel: 'Reset Spacing' }}>
        {() => null}
      </SettingsField>,
    );
    expect(atDefault).toContain('data-settings-mutating="true"');
    expect(atDefault).toContain('aria-label="Reset Spacing"');
    expect(atDefault).toContain('title="Reset"');
    expect(/<button[^>]*disabled=""[^>]*aria-label="Reset Spacing"/.test(atDefault)).toBe(true);

    const changed = render(
      <SettingsField label="Spacing Density" reset={{ onReset: () => {}, disabled: false, ariaLabel: 'Reset Spacing' }}>
        {() => null}
      </SettingsField>,
    );
    expect(/<button[^>]*disabled=""[^>]*aria-label="Reset Spacing"/.test(changed)).toBe(false);
  });

  test('disables reset for read-only viewers even when the value changed', () => {
    const markup = render(
      <SettingsField label="Spacing Density" reset={{ onReset: () => {}, disabled: false, ariaLabel: 'Reset Spacing' }}>
        {() => null}
      </SettingsField>,
      false,
    );
    expect(/<button[^>]*disabled=""[^>]*aria-label="Reset Spacing"/.test(markup)).toBe(true);
  });
});

describe('SettingsSwitchField', () => {
  test('renders a named, described switch whose label targets its input', () => {
    const markup = render(
      <SettingsSwitchField
        label="Sticky User Header"
        description="Pins your message to the top while you scroll its reply."
        checked
        onCheckedChange={() => {}}
      />,
    );

    expect(markup).toContain('role="switch"');
    expect(markup).toContain('aria-checked="true"');
    const labelId = attribute(markup, /<label id="([^"]+)"[^>]*>Sticky User Header<\/label>/);
    const labelFor = attribute(markup, /<label id="[^"]+" for="([^"]+)"/);
    const descriptionId = attribute(markup, /<p id="([^"]+)"[^>]*>Pins your message/);
    expect(markup).toContain(`aria-labelledby="${labelId}"`);
    expect(markup).toContain(`aria-describedby="${descriptionId}"`);
    expect(markup).toContain(`id="${labelFor}"`);
  });

  test('is read-only for viewers without edit permission', () => {
    const markup = render(
      <SettingsSwitchField label="Show Dotfiles" checked={false} onCheckedChange={() => {}} />,
      false,
    );
    expect(markup).toContain('aria-readonly="true"');
  });
});
