import React from 'react';
import {
  RiArrowLeftLine,
  RiFileAddLine,
  RiFile3Line,
  RiFolderAddLine,
  RiFolder3Line,
  RiFolderOpenLine,
  RiHardDrive2Line,
  RiLink,
  RiRefreshLine,
  RiShieldKeyholeLine,
} from '@remixicon/react';

import { Button } from '@/components/ui/button';
import {
  botsApi,
  type BotComputerFiles as BotComputerFilesResult,
  type BotComputerResource,
  type BotsApi,
} from '@/lib/botsApi';
import { revealDesktopPath } from '@/lib/desktop';
import { formatBytes } from '@/lib/formatBytes';
import { cn } from '@/lib/utils';
import { botComputerFilesUnavailableCopy } from './BotComputerFiles.copy';

type ComputerFilesApi = Pick<BotsApi, 'listBotComputerFiles'> & Partial<Pick<
  BotsApi,
  'listBotComputerResources' | 'importBotComputerResource'
>>;

type NativeDialog = {
  open?: (options: Readonly<Record<string, unknown>>) => Promise<unknown>;
};

const nativeDialog = (): NativeDialog | null => {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { __TAURI__?: { dialog?: NativeDialog } }).__TAURI__?.dialog || null;
};

export type BotComputerFilesProps = {
  botId: string;
  api?: ComputerFilesApi;
};

const parentOf = (path: string): string => {
  const segments = path.split('/').filter(Boolean);
  segments.pop();
  return segments.join('/');
};

const formatModified = (value: string | null): string => {
  if (!value) return '';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? ''
    : parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};

/**
 * What the Bot actually has on its computer right now. Global administrators
 * see the container root; other settings users remain scoped to the workspace.
 */
export const BotComputerFiles: React.FC<BotComputerFilesProps> = ({ botId, api = botsApi }) => {
  const [path, setPath] = React.useState('');
  const [listing, setListing] = React.useState<BotComputerFilesResult | null>(null);
  const [resources, setResources] = React.useState<readonly BotComputerResource[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [importing, setImporting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [feedback, setFeedback] = React.useState<string | null>(null);

  const load = React.useCallback(async (target: string) => {
    setLoading(true);
    try {
      const [result, resourceResult] = await Promise.all([
        api.listBotComputerFiles(botId, { path: target || null }),
        api.listBotComputerResources
          ? api.listBotComputerResources(botId)
          : Promise.resolve({ resources: [] }),
      ]);
      setListing(result);
      setResources(resourceResult.resources);
      setError(null);
    } catch (cause) {
      setListing(null);
      setError(cause instanceof Error ? cause.message : 'Unable to read the computer.');
    } finally {
      setLoading(false);
    }
  }, [api, botId]);

  React.useEffect(() => { void load(path); }, [load, path]);

  const chooseAndImport = async (directory: boolean) => {
    const open = nativeDialog()?.open;
    if (!open || !api.importBotComputerResource) {
      setError('Adding local resources is available in the DevRyan desktop app.');
      return;
    }
    const selected = await open({
      directory,
      multiple: !directory,
      title: directory ? 'Add a folder to this Bot' : 'Add files to this Bot',
    });
    const paths = Array.isArray(selected)
      ? selected.filter((value): value is string => typeof value === 'string' && value.length > 0)
      : typeof selected === 'string' && selected ? [selected] : [];
    if (paths.length === 0) return;
    setImporting(true);
    setError(null);
    try {
      let imported = 0;
      let skipped = 0;
      let indexSynchronized = true;
      for (const selectedPath of paths) {
        const result = await api.importBotComputerResource(botId, { path: selectedPath });
        imported += result.imported.length;
        skipped += result.skipped.length;
        indexSynchronized &&= result.indexSynchronized;
      }
      setFeedback(`${imported} file${imported === 1 ? '' : 's'} added${skipped ? ` · ${skipped} skipped` : ''}${indexSynchronized ? '' : ' · references will finish indexing when the runtime is ready'}.`);
      const resourcesPath = listing?.scope === 'container' ? 'workspace/Resources' : 'Resources';
      if (path === resourcesPath) await load(path);
      else setPath(resourcesPath);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Resources could not be added.');
    } finally {
      setImporting(false);
    }
  };

  const crumbs = path.split('/').filter(Boolean);
  const unavailable = listing && !listing.available
    ? botComputerFilesUnavailableCopy(listing.state)
    : null;
  const stopped = listing?.available === true && listing.state === 'offline';

  return (
    <section className="space-y-3" aria-labelledby="bot-computer-files-heading">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <RiHardDrive2Line className="h-5 w-5 text-muted-foreground" aria-hidden />
          <div>
            <h3 id="bot-computer-files-heading" className="typography-ui-header font-semibold text-foreground">
              Computer files
            </h3>
            <p className="typography-ui text-muted-foreground">
              What this Bot has on its computer. One computer per Bot, shared by everyone on it.
            </p>
            <p className="typography-micro text-muted-foreground">
              Text files added here are automatically available as references.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Button type="button" size="xs" variant="outline" disabled={loading || importing} onClick={() => void chooseAndImport(false)}>
            <RiFileAddLine className="h-3.5 w-3.5" aria-hidden /> Add Files
          </Button>
          <Button type="button" size="xs" variant="outline" disabled={loading || importing} onClick={() => void chooseAndImport(true)}>
            <RiFolderAddLine className="h-3.5 w-3.5" aria-hidden /> Add Folder
          </Button>
          <Button type="button" size="xs" variant="ghost" disabled={loading || importing} onClick={() => void load(path)}>
            <RiRefreshLine className="h-3.5 w-3.5" aria-hidden /> Refresh
          </Button>
        </div>
      </div>

      {feedback ? <p role="status" className="rounded-lg border border-border/70 px-3 py-2 typography-ui text-foreground">{feedback}</p> : null}

      <div className="overflow-hidden rounded-lg border border-border/70">
        {stopped ? (
          <p className="border-b border-border bg-[var(--status-warning)]/10 px-3 py-2 typography-micro text-foreground" role="status">
            Computer stopped — showing saved files.
          </p>
        ) : null}
        <div className="flex items-center gap-1.5 border-b border-border bg-[var(--surface-subtle)]/50 px-3 py-2">
          {path ? (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="h-6 w-6"
              aria-label="Go Up One Folder"
              onClick={() => setPath(parentOf(path))}
            >
              <RiArrowLeftLine className="h-3.5 w-3.5" aria-hidden />
            </Button>
          ) : null}
          <nav aria-label="Folder Path" className="flex min-w-0 flex-wrap items-center gap-1 typography-micro text-muted-foreground">
            <button
              type="button"
              className="rounded px-1 py-0.5 hover:bg-interactive-hover hover:text-foreground"
              onClick={() => setPath('')}
            >
              {listing?.rootLabel || 'Workspace'}
            </button>
            {crumbs.map((segment, index) => (
              <React.Fragment key={`${segment}-${index}`}>
                <span aria-hidden>/</span>
                <button
                  type="button"
                  className="max-w-40 truncate rounded px-1 py-0.5 hover:bg-interactive-hover hover:text-foreground"
                  onClick={() => setPath(crumbs.slice(0, index + 1).join('/'))}
                >
                  {segment}
                </button>
              </React.Fragment>
            ))}
          </nav>
        </div>

        {loading ? (
          <p className="px-3 py-6 typography-ui text-muted-foreground" role="status">Reading the computer…</p>
        ) : error ? (
          <p className="px-3 py-6 typography-ui text-[var(--status-error)]" role="alert">{error}</p>
        ) : unavailable ? (
          <div className="px-3 py-6 text-center">
            <p className="typography-ui text-foreground">{unavailable.title}</p>
            <p className="mt-1 typography-micro text-muted-foreground">
              {unavailable.detail}
            </p>
          </div>
        ) : !listing || listing.entries.length === 0 ? (
          <div className="px-3 py-6 text-center">
            <p className="typography-ui text-foreground">Nothing here yet.</p>
            <p className="mt-1 typography-micro text-muted-foreground">
              Files the Bot creates while it works will show up here.
            </p>
          </div>
        ) : (
          <ul aria-label="Computer Files">
            {listing.entries.map((entry) => {
              const Icon = entry.restricted
                ? RiShieldKeyholeLine
                : entry.kind === 'directory'
                  ? RiFolder3Line
                  : entry.kind === 'symlink' ? RiLink : RiFile3Line;
              const modified = formatModified(entry.modifiedAt);
              const navigable = entry.kind === 'directory' && !entry.restricted;
              const workspacePath = entry.path.replace(/^\/?workspace\//u, '');
              const localResource = resources.find((resource) => resource.computerPath === workspacePath);
              return (
                <li key={entry.path} className="border-b border-border/60 last:border-b-0">
                  <div
                    className={cn(
                      'flex items-center gap-2.5 px-3 py-2',
                      navigable && 'cursor-pointer hover:bg-interactive-hover',
                    )}
                    {...(navigable ? {
                      role: 'button',
                      tabIndex: 0,
                      onClick: () => setPath(path ? `${path}/${entry.name}` : entry.name),
                      onKeyDown: (event: React.KeyboardEvent) => {
                        if (event.key !== 'Enter' && event.key !== ' ') return;
                        event.preventDefault();
                        setPath(path ? `${path}/${entry.name}` : entry.name);
                      },
                    } : {})}
                  >
                    <Icon
                      className={cn(
                        'h-4 w-4 shrink-0',
                        entry.restricted
                          ? 'text-[var(--status-warning)]'
                          : entry.kind === 'directory'
                            ? 'text-[var(--status-info,var(--primary))]'
                            : 'text-muted-foreground',
                      )}
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1 truncate typography-ui-label text-foreground">{entry.name}</span>
                    {entry.restricted ? (
                      <span className="shrink-0 typography-micro text-[var(--status-warning)]">
                        Restricted
                      </span>
                    ) : entry.kind === 'file' ? (
                      <span className="shrink-0 typography-micro tabular-nums text-muted-foreground">
                        {formatBytes(entry.size)}
                      </span>
                    ) : null}
                    {modified ? (
                      <span className="hidden shrink-0 typography-micro text-muted-foreground sm:inline">{modified}</span>
                    ) : null}
                    {localResource ? (
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        aria-label={`Open ${entry.name} in Finder`}
                        onClick={(event) => {
                          event.stopPropagation();
                          void revealDesktopPath(localResource.sourcePath);
                        }}
                      >
                        <RiFolderOpenLine className="h-3.5 w-3.5" aria-hidden /> Open in Finder
                      </Button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {listing?.truncated ? (
          <p className="border-t border-border/60 px-3 py-2 typography-micro text-muted-foreground">
            Only the first {listing.entries.length} entries are shown.
          </p>
        ) : null}
      </div>
    </section>
  );
};
