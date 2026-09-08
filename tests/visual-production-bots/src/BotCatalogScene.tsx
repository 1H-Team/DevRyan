import React from 'react';
import { BotGallery } from '@/components/sections/bots/BotGallery';
import type { BotSummary } from '@/lib/botsApi';

// The API fixture represents the server-filtered catalog. Classification itself
// is exercised against the shared visibility service and real event stream.
export function BotCatalogScene({ bot, empty, canCreate }: { bot: BotSummary; empty: boolean; canCreate: boolean }) {
  const bots = empty ? [] : [{ ...bot, name: 'Rockbot' }, { ...bot, id: 'second-bot', name: 'Pixel' }];
  const [selected, setSelected] = React.useState<string | null>(bots[0]?.id || null);
  return <div className="flex min-h-[360px] overflow-hidden rounded-xl border border-border bg-background" data-catalog-fixture>
    <BotGallery bots={bots} selectedBotId={selected} canCreate={canCreate} onSelect={setSelected} onCreate={() => {}} />
  </div>;
}
