import React from 'react';
import { createRoot } from 'react-dom/client';
import type { Model } from '@opencode-ai/sdk/v2';
import { AgentsPage } from '@/components/sections/agents/AgentsPage';
import { I18nProvider } from '@/lib/i18n';
import { useAgentsStore, type AgentWithExtras } from '@/stores/useAgentsStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { opencodeClient } from '@/lib/opencode/client';
import { getAuthPrincipal, setAuthPrincipal } from '@/lib/authSession';
import { CSSVariableGenerator } from '@/lib/theme/cssGenerator';
import { getDefaultTheme } from '@/lib/theme/themes';
import '@/index.css';
import '@/styles/fonts';

const catalogModel = (id: string, variants: Model['variants']): Model => ({
  id, providerID: 'fixture', api: { id, url: 'https://example.invalid', npm: 'fixture' }, name: id,
  capabilities: { temperature: true, reasoning: true, attachment: false, toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false }, interleaved: false },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } }, limit: { context: 1000, output: 1000 },
  status: 'active', options: {}, headers: {}, release_date: '2026-01-01', variants,
});
const agent: AgentWithExtras = { name: 'explorer', mode: 'subagent', options: {}, permission: [],
  description: 'Isolated agent model settings verification.',
  model: { providerID: 'fixture', modelID: 'Explorer model' }, modelRefs: ['fixture/Explorer model'], variant: 'medium',
};
const saves: Array<{ model: string; variant: string | null }> = [];
setAuthPrincipal({ ...getAuthPrincipal(), policy: { ...getAuthPrincipal().policy,
  featureOverrides: { agents: { hideGlobalBehaviorUi: true, hidePermissionsUi: true } } } });
opencodeClient.listToolIds = async () => [];
useDirectoryStore.setState({ currentDirectory: '/isolated-agent-settings' });
useConfigStore.setState({ isInitialized: true, providers: [{ id: 'fixture', name: 'Fixture provider', source: 'custom', options: {}, env: [],
  models: [catalogModel('Explorer model', { low: {}, high: {} }), catalogModel('Alternate model', { high: {} })],
}] });
useAgentsStore.setState({ agents: [agent], selectedAgentName: agent.name,
  saveAgentModelOverride: async (_name, config) => {
    saves.push({ model: typeof config.model === 'string' ? config.model : '', variant: config.variant ?? null });
    window.dispatchEvent(new Event('fixture-save'));
    return null;
  },
});
const dark = new URLSearchParams(location.search).get('theme') !== 'light';
document.documentElement.classList.toggle('dark', dark);
new CSSVariableGenerator().apply(getDefaultTheme(dark));
export function App() {
  const [saved, setSaved] = React.useState('No changes saved');
  React.useEffect(() => {
    const update = () => setSaved(JSON.stringify(saves.at(-1)));
    window.addEventListener('fixture-save', update);
    return () => window.removeEventListener('fixture-save', update);
  }, []);
  return <I18nProvider><main className="mx-auto max-w-5xl p-5">
    <aside className="mb-4 rounded-lg border border-border p-3 typography-meta text-muted-foreground">
      <p>Isolated Agents Settings fixture. Saves stay in this browser tab.</p>
      <output data-fixture-save>{saved}</output>
    </aside>
    <AgentsPage />
  </main></I18nProvider>;
}
createRoot(document.getElementById('root')!).render(<App />);
