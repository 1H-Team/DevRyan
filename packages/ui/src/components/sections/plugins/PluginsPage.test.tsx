import { beforeEach, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';
import { usePluginsStore } from '@/stores/usePluginsStore';
import { PluginsPage } from './PluginsPage';

const initialPluginsState = usePluginsStore.getState();
const initialServerPluginsState = { ...usePluginsStore.getInitialState() };

const defaultPlugin = {
  id: 'devryan-default:opencode-with-claude',
  pluginId: 'opencode-with-claude' as const,
  displayName: 'OpenCode with Claude',
  shippedSpec: './node_modules/opencode-with-claude/dist/index.js',
  effectiveSpec: 'opencode-with-claude@1.6.17',
  version: '1.6.18',
  delivery: 'installed-local' as const,
  sourcePath: 'default-config/user-profile/package.json',
  configuredSourcePath: '/tmp/opencode.json',
  kind: 'default' as const,
};

describe('PluginsPage default details', () => {
  beforeEach(() => {
    usePluginsStore.setState({
      defaults: [defaultPlugin],
      entries: [],
      files: [],
      errors: [],
      selectedId: defaultPlugin.id,
      isLoading: false,
      lastError: null,
      slimStatus: null,
      slimStatusLoading: false,
      slimActionInFlight: null,
      slimLastError: null,
    });
    Object.assign(usePluginsStore.getInitialState(), {
      defaults: [defaultPlugin],
      selectedId: defaultPlugin.id,
    });
  });

  test('shows ownership, shipped metadata, and an effective override', () => {
    try {
      const markup = renderToStaticMarkup(
        <I18nProvider>
          <PluginsPage />
        </I18nProvider>,
      );

      expect(markup).toContain('Included with DevRyan');
      expect(markup).toContain('./node_modules/opencode-with-claude/dist/index.js');
      expect(markup).toContain('opencode-with-claude@1.6.17');
      expect(markup).toContain('Installed locally (no runtime fetch)');
      expect(markup).toContain('/tmp/opencode.json');
    } finally {
      usePluginsStore.setState(initialPluginsState, true);
      Object.assign(usePluginsStore.getInitialState(), initialServerPluginsState);
    }
  });
});
