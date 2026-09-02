import type { BotComputerFiles } from '@/lib/botsApi';

export type BotComputerFilesView = 'relevant' | 'workspace' | 'computer';

// The two folders a member actually puts things into: chat attachments land in
// Shared, files added from Settings land in Resources. Everything else the Bot
// creates while working stays one click away behind "Whole Workspace".
export const RELEVANT_ROOT_ENTRIES: readonly string[] = Object.freeze(['Resources', 'Shared']);

export const computerFilesScopeForView = (view: BotComputerFilesView): 'workspace' | 'container' => (
  view === 'computer' ? 'container' : 'workspace'
);

export const visibleComputerEntries = (
  entries: BotComputerFiles['entries'],
  { path, view }: { path: string; view: BotComputerFilesView },
): BotComputerFiles['entries'] => {
  if (view !== 'relevant' || path.replace(/^\/+|\/+$/gu, '') !== '') return entries;
  return entries.filter((entry) => entry.kind === 'directory' && RELEVANT_ROOT_ENTRIES.includes(entry.name));
};

export const BOT_COMPUTER_FILES_VIEW_LABELS: Readonly<Record<BotComputerFilesView, string>> = Object.freeze({
  relevant: 'Shared & Resources',
  workspace: 'Whole Workspace',
  computer: 'Whole Computer',
});
