import React from 'react';
import { BotIdentityHeader } from '@/components/bots/chat/BotIdentityHeader';
import { BotTypingIndicator } from '@/components/bots/chat/BotTypingIndicator';
import { BotSidebarRow } from '@/components/bots/sidebar/BotSidebarRow';
import type { BotSummary } from '@/lib/botsApi';
import { useBotsStore } from '@/stores/useBotsStore';
import { prepareBotAvatar } from '@/lib/botAvatarUpload';

const avatarPath = '/__avatar_fixture__/';
const makeBot = (id: string): BotSummary => ({
  id, name: id === 'a' ? 'Amber Assistant' : 'Blue Assistant', title: 'Your project assistant',
  summary: '', avatarUrl: `${avatarPath}${id}?v=1`, avatarFallback: null,
  lifecycle: 'active', tenancy: 'team', activeRevisionId: null, createdAt: '', updatedAt: '', retiredAt: null,
});

export const BotAvatarScene: React.FC = () => {
  const selected = useBotsStore((state) => state.selectedBotId);
  const bots = useBotsStore((state) => state.botsById);
  const [requests, setRequests] = React.useState(0);
  const [ready, setReady] = React.useState(false);
  const [uploadVerified, setUploadVerified] = React.useState(false);
  const root = React.useRef<HTMLDivElement>(null);
  const selectionTime = React.useRef(performance.now());
  const state = new URLSearchParams(location.search).get('state');
  const bot = selected ? bots[selected] : null;

  React.useEffect(() => {
    const original = window.fetch;
    window.fetch = async (input, init) => {
      const url = String(input);
      if (!url.startsWith(avatarPath)) return original(input, init);
      setRequests((count) => count + 1);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, state === 'cold' ? 10_000 : 180);
        init?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
      });
      const canvas = document.createElement('canvas');
      canvas.width = 512; canvas.height = 256;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Missing fixture canvas');
      context.fillStyle = url.includes('v=2') ? '#237e54' : url.includes('/a?') ? '#a75418' : '#246da7';
      context.fillRect(0, 0, 384, 256); // Transparent right edge verifies alpha preservation.
      context.fillStyle = '#fff'; context.font = 'bold 100px sans-serif';
      context.fillText(url.includes('/a?') ? 'A' : 'B', 120, 165);
      const png = await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('PNG failed')), 'image/png'));
      const prepared = await prepareBotAvatar(new File([png], 'fixture.png', { type: 'image/png' }));
      const response = await original(prepared.dataUrl);
      const blob = await response.blob();
      const decoded = await createImageBitmap(blob);
      const check = document.createElement('canvas'); check.width = 256; check.height = 128;
      const pixels = check.getContext('2d');
      if (!pixels) throw new Error('Missing alpha check canvas');
      pixels.drawImage(decoded, 0, 0);
      const valid = decoded.width === 256 && decoded.height === 128 && pixels.getImageData(255, 0, 1, 1).data[3] === 0;
      decoded.close();
      if (!valid) throw new Error('Avatar resize/alpha regression');
      setUploadVerified(true);
      return new Response(blob, { headers: { 'Content-Type': blob.type, 'Cache-Control': 'no-store, private' } });
    };
    useBotsStore.getState().resetPrincipal('avatar-fixture');
    useBotsStore.getState().upsertBot(makeBot('a'));
    useBotsStore.getState().upsertBot(makeBot('b'));
    useBotsStore.getState().selectBot('a');
    setReady(true);
    return () => { window.fetch = original; useBotsStore.getState().resetPrincipal(null); };
  }, [state]);

  React.useLayoutEffect(() => {
    if (!root.current) return;
    const element = root.current;
    const record = () => {
      const header = element.querySelector('[data-bot-identity-header] [data-bot-avatar]');
      if (header?.getAttribute('data-bot-avatar') !== selected) throw new Error('Wrong avatar identity');
      const image = header.querySelector('img');
      element.dataset.firstRenderDecoded = String(Boolean(image?.complete && image.naturalWidth > 0));
      if (image) element.dataset.correctImageMs = (performance.now() - selectionTime.current).toFixed(1);
    };
    if (bot) record();
    const observer = new MutationObserver(record);
    observer.observe(element, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [bot, selected]);

  if (!ready || !bot) return <p>Loading avatar fixture…</p>;
  return (
    <div ref={root} data-avatar-fixture data-avatar-requests={requests} data-upload-verified={uploadVerified} className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <button className="rounded border p-2" data-avatar-replace onClick={() => {
          useBotsStore.getState().upsertBot({ ...bot, avatarUrl: `${avatarPath}${bot.id}?v=2` });
        }}>Replace avatar</button>
        <button className="rounded border p-2" data-avatar-rename onClick={() => {
          useBotsStore.getState().upsertBot({ ...bot, title: 'Updated title', updatedAt: 'later' });
        }}>Update title</button>
      </div>
      <div className="grid gap-4 min-[900px]:grid-cols-[240px_minmax(0,1fr)]">
        <nav aria-label="Bot conversations" className="space-y-1">
          {['a', 'b'].map((id) => <BotSidebarRow key={id} bot={bots[id]} selected={selected === id}
            opening={false} channelId={null} status="typing" onSelect={(botId) => {
              selectionTime.current = performance.now(); useBotsStore.getState().selectBot(botId);
            }} />)}
        </nav>
        <div className="min-w-0 rounded-lg border p-3">
          <BotIdentityHeader bot={bot} mobile={window.innerWidth < 720} />
          <p className="my-6 typography-ui-label">I’m preparing your project update.</p>
          <BotTypingIndicator bot={bot} />
        </div>
      </div>
    </div>
  );
};
