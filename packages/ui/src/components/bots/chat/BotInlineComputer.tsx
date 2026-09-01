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
  return (
    <div ref={markerRef} className="my-3 min-w-0" data-bot-inline-computer={botId}>
      <dialog
        ref={dialogRef} open aria-label="Shared Bot Computer"
        onCancel={(event) => { event.preventDefault(); setExpanded(false); }}
        className={cn(
          'm-0 flex flex-col overflow-hidden rounded-xl border border-border bg-background p-0 text-foreground shadow-sm backdrop:bg-black/60',
          expanded ? 'fixed inset-4 m-auto h-[min(90dvh,900px)] w-[min(94vw,1400px)] max-w-none' : 'relative w-full max-w-none',
        )}
      >
        <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
          <RiComputerLine className="h-4 w-4 text-muted-foreground" aria-hidden />
          <span className="min-w-0 flex-1 typography-ui-label font-medium">Shared Bot Computer</span>
          <Button variant="ghost" size="xs" aria-label={expanded ? 'Collapse Computer' : 'Expand Computer'} onClick={() => setExpanded((value) => !value)}>
            {expanded ? <RiFullscreenExitLine /> : <RiFullscreenLine />}
          </Button>
          <Button variant="ghost" size="xs" onClick={() => {
            setExpanded(false); setHiddenRun(runId);
            useBotComputerActivityStore.getState().hide(botId);
          }}><RiArrowDownSLine /> Hide</Button>
        </div>
        <div className={expanded ? 'min-h-0 flex-1' : 'h-[360px] max-h-[60dvh] min-h-[220px]'}>
          <BotBrowserDiagnostic botId={botId} channelId={channelId} botActive={botActive}
            principalId={principal.id} canControl={Boolean(membership)} runId={requested ? undefined : runId}
            active={documentVisible && (expanded || onScreen)} />
        </div>
      </dialog>
    </div>
  );
});
