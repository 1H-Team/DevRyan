import React from 'react';
import type { RuntimeAPIs } from '@/lib/api/types';
import { RuntimeAPIProvider } from '@/contexts/RuntimeAPIProvider';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui';
import { BotSidebarSection } from '@/components/bots/sidebar/BotSidebarSection';
import { BotView } from '@/components/views/BotView';
import { BotsEventOwner } from './BotsEventOwner';

// A remote Bot grant mounts only Bot state and its event owner. Host project,
// OpenCode session, terminal, settings and native integrations never mount.
export function BotTunnelApp({ apis }: { apis: RuntimeAPIs }) {
  return <RuntimeAPIProvider apis={apis}>
    <TooltipProvider>
      <BotsEventOwner />
      <div className="flex h-full min-h-0 flex-col bg-background text-foreground sm:flex-row">
        <aside aria-label="Granted Bot Workspaces" className="max-h-48 shrink-0 overflow-auto border-b border-border p-3 sm:max-h-none sm:w-64 sm:border-b-0 sm:border-r">
          <h1 className="mb-3 typography-ui-header">Bot workspaces</h1>
          <BotSidebarSection standalone />
        </aside>
        <main className="min-h-0 min-w-0 flex-1"><BotView /></main>
      </div>
      <Toaster />
    </TooltipProvider>
  </RuntimeAPIProvider>;
}
