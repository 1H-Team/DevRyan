import React from 'react';
import { BotsEventOwner } from '@/apps/BotsEventOwner';
import { BotSidebarSection } from '@/components/bots/sidebar/BotSidebarSection';
import { BotGallery } from '@/components/sections/bots/BotGallery';
import { BotView } from '@/components/views/BotView';
import { Button } from '@/components/ui/button';
import { botsApi, type BotSummary } from '@/lib/botsApi';
import { useBotOperationsStore } from '@/stores/useBotOperationsStore';
import { useBotsStore } from '@/stores/useBotsStore';
import { interruptAssignedFixture, openAssignedTransportFixture, publishAssignedFixtureMessage, restoreAssignedFixture } from './assignedCatalogFetchFixture';

export function BotAssignedCatalogScene() {
  const [tab, setTab] = React.useState('settings');
  const [settingsBots, setSettingsBots] = React.useState<readonly BotSummary[]>([]);
  const connection = useBotOperationsStore((state) => state.connectionState);
  const loaded = useBotsStore((state) => state.catalogLoaded);
  React.useEffect(() => { void botsApi.listBots().then((result) => setSettingsBots(result.bots)); }, []);
  return <div data-assigned-catalog-fixture data-connection={connection} data-loaded={loaded} className="flex min-h-[600px] flex-col rounded-xl border border-border bg-background">
    <BotsEventOwner />
    <nav className="flex flex-wrap gap-2 border-b border-border p-3" aria-label="Fixture navigation">
      <Button variant="outline" data-settings-tab onClick={() => setTab('settings')}>Settings / Bots</Button>
      <Button variant="outline" data-bots-tab onClick={() => setTab('bots')}>Bots</Button>
      <Button variant="ghost" data-restore-service onClick={restoreAssignedFixture}>Restore fixture service</Button>
      {new URLSearchParams(location.search).get('state') === 'assigned_recovery' ? <>
        <Button data-interrupt-service onClick={interruptAssignedFixture}>Disconnect fixture</Button>
        <Button data-open-transport onClick={openAssignedTransportFixture}>Open transport without snapshot</Button>
        <Button data-publish-message onClick={publishAssignedFixtureMessage}>Publish fixture response</Button>
      </> : null}
    </nav>
    {tab === 'settings' ? <div data-settings-catalog className="p-3"><BotGallery bots={settingsBots} selectedBotId={null} canCreate={false} onSelect={() => {}} onCreate={() => {}} /></div> :
      <div className="flex min-h-[520px] flex-1 flex-col sm:flex-row">
        <aside className="shrink-0 border-b border-border p-2 sm:w-[280px] sm:border-b-0 sm:border-r" aria-label="Bot navigation"><BotSidebarSection standalone /></aside>
        <main className="relative min-h-[350px] min-w-0 flex-1"><BotView /></main>
      </div>}
  </div>;
}
