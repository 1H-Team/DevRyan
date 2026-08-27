import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { SettingsSectionTabs } from './SettingsSectionTabs';

describe('SettingsSectionTabs', () => {
  test('renders an accessible controlled tablist above its panel', () => {
    const markup = renderToStaticMarkup(
      <SettingsSectionTabs
        activeSlug="usage"
        ariaLabel="Providers"
        idPrefix="providers-settings"
        onTabChange={() => {}}
        tabs={[
          { slug: 'providers', label: 'Providers' },
          { slug: 'usage', label: 'Usage' },
        ]}
      >
        <div>Usage panel</div>
      </SettingsSectionTabs>,
    );

    expect(markup).toContain('role="tablist"');
    expect(markup).toContain('aria-label="Providers"');
    expect(markup).toContain('id="providers-settings-providers-tab"');
    expect(markup).toContain('id="providers-settings-usage-tab"');
    expect(markup).toContain('aria-controls="providers-settings-panel"');
    expect(markup).toContain('aria-labelledby="providers-settings-usage-tab"');
    expect(markup).toContain('aria-selected="true"');
    expect(markup).toContain('Usage panel');
  });

  test('omits a redundant tab strip when only one tab is available', () => {
    const markup = renderToStaticMarkup(
      <SettingsSectionTabs
        activeSlug="tunnel"
        ariaLabel="Remote Connections"
        idPrefix="remote-settings"
        onTabChange={() => {}}
        tabs={[{ slug: 'tunnel', label: 'Remote Tunnel' }]}
      >
        <div>Tunnel panel</div>
      </SettingsSectionTabs>,
    );

    expect(markup).not.toContain('role="tablist"');
    expect(markup).toContain('Tunnel panel');
  });
});
