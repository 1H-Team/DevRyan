import { beforeEach, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';
import { usePluginsStore } from '@/stores/usePluginsStore';
import { PluginsSidebar } from './PluginsSidebar';

const initialPluginsState = usePluginsStore.getState();
const initialServerPluginsState = { ...usePluginsStore.getInitialState() };

const projectEntry = {
  id: 'project-default-plugin',
  spec: 'devryan-default-plugin@1.0.0',
  scope: 'project' as const,
  kind: 'config' as const,
  parsedKind: 'npm' as const,
  sourcePath: '/tmp/project/opencode.json',
};

const defaultPlugin = {
  id: 'devryan-default:oh-my-opencode-slim',
  pluginId: 'oh-my-opencode-slim' as const,
  displayName: 'Oh My OpenCode Slim',
  shippedSpec: 'oh-my-opencode-slim@2.0.5',
  effectiveSpec: './plugins/devryan-oh-my-opencode-slim.mjs',
  version: '2.0.5',
  delivery: 'npm' as const,
  sourcePath: 'default-config/user-profile/package.json',
  kind: 'default' as const,
};

describe('PluginsSidebar', () => {
  beforeEach(() => {
    usePluginsStore.setState({
      defaults: [defaultPlugin],
      entries: [projectEntry],
      files: [],
      errors: [],
      selectedId: null,
      isLoading: false,
      lastError: null,
      slimStatus: null,
      slimStatusLoading: false,
      slimActionInFlight: null,
      slimLastError: null,
    });
    Object.assign(usePluginsStore.getInitialState(), { defaults: [defaultPlugin], entries: [projectEntry] });
  });

  test('renders defaults separately from unrelated project plugins', () => {
    try {
      const markup = renderToStaticMarkup(
        <I18nProvider>
          <PluginsSidebar />
        </I18nProvider>,
      );

      expect(markup).toContain('DevRyan Default Plugins');
      expect(markup).toContain('Project Config Entries');
      expect(markup).toContain('Oh My OpenCode Slim');
      expect(markup).toContain('devryan-default-plugin@1.0.0');
    } finally {
      usePluginsStore.setState(initialPluginsState, true);
      Object.assign(usePluginsStore.getInitialState(), initialServerPluginsState);
    }
  });
});
