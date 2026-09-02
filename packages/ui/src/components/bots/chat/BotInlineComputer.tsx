import React from 'react';
import { RiArrowDownSLine, RiComputerLine, RiFullscreenExitLine, RiFullscreenLine } from '@remixicon/react';
import { Button } from '@/components/ui/button';
import { useAuthPrincipal } from '@/lib/authSession';
import { cn } from '@/lib/utils';
import { useBotComputerActivityStore } from '@/stores/useBotComputerActivityStore';
import { useBotsStore } from '@/stores/useBotsStore';
import { BotBrowserDiagnostic } from '../operations/BotBrowserDiagnostic';

type Props = { botId: string; channelId: string; botActive: boolean };

// One viewer stays in the same DOM subtree. Native dialog's top layer expands it
// without remounting the canvas or consuming a second single-use stream ticket.
export const BotInlineComputer = React.memo(function BotInlineComputer({ botId, channelId, botActive }: Props) {
  const principal = useAuthPrincipal();
  const membership = useBotsStore((s) => s.membershipsByBotId[botId]);
  const activity = useBotComputerActivityStore((s) => s.byBotId[botId]);
  const manual = useBotComputerActivityStore((s) => s.manualByBotId[botId]);
  const runId = activity?.channelId === channelId && activity.state !== 'idle' ? activity.runId : undefined;
  const [hiddenRun, setHiddenRun] = React.useState<string>();
  const [expanded, setExpanded] = React.useState(false);
  const [documentVisible, setDocumentVisible] = React.useState(() => typeof document === 'undefined' || !document.hidden);
  const [onScreen, setOnScreen] = React.useState(true);
  const dialogRef = React.useRef<HTMLDialogElement>(null);
  const markerRef = React.useRef<HTMLDivElement>(null);
  const returnFocus = React.useRef<HTMLElement | null>(null);
  const requested = manual?.channelId === channelId;
  const shown = botActive && Boolean(membership) && (requested || Boolean(runId && hiddenRun !== runId));

  React.useEffect(() => {
    const update = () => setDocumentVisible(!document.hidden);
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  React.useEffect(() => {
    const marker = markerRef.current;
    if (!marker || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(([entry]) => setOnScreen(entry.isIntersecting), { rootMargin: '100px' });
    observer.observe(marker);
    return () => observer.disconnect();
  }, [shown]);
  React.useEffect(() => { setExpanded(false); setHiddenRun(undefined); }, [botId, channelId, principal.id]);
  React.useEffect(() => { if (!shown) setExpanded(false); }, [shown]);
  React.useLayoutEffect(() => {
    if (requested) markerRef.current?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  }, [requested, manual?.request]);
  React.useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (expanded && typeof dialog.showModal === 'function') {
      returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.close();
      dialog.showModal();
    } else if (dialog.matches(':modal')) {
      dialog.close();
      dialog.setAttribute('open', '');
      returnFocus.current?.focus({ preventScroll: true });
    }
  }, [expanded]);

  if (!shown) return null;
  // The desktop is a fixed 16:9 surface, so the widget is sized by that aspect
  // (never a fixed pixel height) and is allowed to grow past the 760px message
  // column into the transcript's full width; expanded, it fills the viewport
  // while keeping the same aspect so there are no black bars.
  return (
    <div
      ref={markerRef}
      className="my-3 w-[max(100%,min(100cqw-24px,1100px))] min-w-0 ml-[calc((100%-max(100%,min(100cqw-24px,1100px)))/2)]"
      data-bot-inline-computer={botId}
    >
      <dialog
        ref={dialogRef} open aria-label="Shared Bot Computer"
        onCancel={(event) => { event.preventDefault(); setExpanded(false); }}
        className={cn(
          'm-0 flex flex-col overflow-hidden rounded-xl border border-border bg-background p-0 text-foreground shadow-sm backdrop:bg-black/70',
          expanded
            ? 'fixed inset-0 m-auto h-auto max-h-[94dvh] w-[min(96vw,calc((94dvh-72px)*16/9))] max-w-none'
            : 'relative w-full max-w-none',
        )}
      >
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/60 px-2.5">
          <RiComputerLine className="h-4 w-4 text-muted-foreground" aria-hidden />
          <span className="min-w-0 flex-1 truncate typography-ui-label font-medium">Shared Bot Computer</span>
          <Button variant="ghost" size="xs" aria-label={expanded ? 'Collapse Computer' : 'Expand Computer'} onClick={() => setExpanded((value) => !value)}>
            {expanded ? <RiFullscreenExitLine /> : <RiFullscreenLine />}
          </Button>
          <Button variant="ghost" size="xs" onClick={() => {
            setExpanded(false); setHiddenRun(runId);
            useBotComputerActivityStore.getState().hide(botId);
          }}><RiArrowDownSLine /> Hide</Button>
        </div>
        <div className={expanded ? 'min-h-0 w-full' : 'w-full'} data-bot-inline-computer-screen="true">
          <div className={cn('flex w-full flex-col', expanded ? 'max-h-[calc(94dvh-36px)]' : 'max-h-[70dvh] min-h-[220px]')} style={{ aspectRatio: '16 / 8.6' }}>
            <BotBrowserDiagnostic botId={botId} channelId={channelId} botActive={botActive}
              principalId={principal.id} canControl={Boolean(membership)} runId={requested ? undefined : runId}
              active={documentVisible && (expanded || onScreen)} />
          </div>
        </div>
      </dialog>
    </div>
  );
});
