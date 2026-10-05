import React, { act } from 'react';
import { expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import type { RecoveredInputDetails } from '@/lib/primaryRecoveryApi';
import { usePrimaryRecoveryStore, type PrimaryRecoverySnapshot } from '@/stores/usePrimaryRecoveryStore';
import { withDom } from '../bots/chat/botMountedDom';

const requests: unknown[][] = [];
let respond: () => Promise<void> = async () => {};
const inputActions: unknown[][] = [];
const detailRequests: unknown[][] = [];
let loadDetails: () => Promise<RecoveredInputDetails>;
mock.module('@/lib/primaryRecoveryApi', () => ({ requestPrimaryRecovery: (...args: unknown[]) => {
  requests.push(args); return respond();
}, actOnRecoveredInput: (...args: unknown[]) => { inputActions.push(args); return respond(); },
readRecoveredInput: (...args: unknown[]) => { detailRequests.push(args); return loadDetails(); } }));
const { HostPrimaryRecovery } = await import('./HostPrimaryRecovery');
const { createQaUiDriver }: {
  createQaUiDriver: (cdp: { send: (method: string, params: { expression: string }) => Promise<{ result: { value: unknown } }> },
    options: { timeoutMs: number }) => { waitVisibleText: (text: string, selector: string) => Promise<unknown> };
} = await import(new URL('../../../../../scripts/qa/ui-driver.mjs', import.meta.url).href);
const snapshot = (): PrimaryRecoverySnapshot => ({ schemaVersion: 1, mode: 'enforce', supported: true, enforced: true,
  progressTimeoutMs: 300_000, record: { sessionID: 'ses_root', anchorID: 'msg_user', failedID: null, recoveryID: null,
    state: 'observing', revision: 2, attemptCount: 0, maxAttempts: 1, readOnly: false,
    providerID: 'openai', modelID: 'gpt-fixture', agent: 'orchestrator', variant: null, reason: null, updatedAt: 100,
    collectionIssue: { taskId: 'dvr_task_recovered', code: 'managed_continuation_fenced' } } });

test('offers an explicit collection for a fenced sub-agent result and recovers on projection changes', async () => {
  requests.length = 0;
  respond = async () => {};
  await withDom(async container => {
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container as unknown as Element);
    try {
      usePrimaryRecoveryStore.setState({ snapshots: { ses_root: snapshot() } });
      await act(async () => root.render(<HostPrimaryRecovery sessionId="ses_root" showAvailability />));
      expect(container.textContent).toContain('Sub-agent result ready');
      expect(container.textContent).not.toContain('managed_continuation_fenced');
      expect(requests).toEqual([['ses_root']]);
      await act(async () => { container.find(node => node.tagName === 'BUTTON' && node.textContent === 'Collect Result')?.click(); });
      expect(requests[1].slice(0, 2)).toEqual(['ses_root', 'continue']);
      requests.splice(1);
      const changed = snapshot();
      changed.record!.collectionIssue = null;
      changed.record!.state = 'needs_attention';
      changed.record!.revision++;
      await act(async () => { usePrimaryRecoveryStore.getState().accept('ses_root', changed); });
      expect(container.textContent).toContain('Recovery needs your attention');
      expect(container.textContent).toContain('Continue with Original Permissions');
      expect(container.textContent).not.toContain('gpt-fixture');
      expect(container.textContent).not.toContain('orchestrator');
      await act(async () => { container.find(node => node.tagName === 'BUTTON' && node.textContent === 'Continue with Original Permissions')?.click(); });
      expect(requests[1].slice(0, 2)).toEqual(['ses_root', 'continue']);
      expect(/^msg_[a-zA-Z0-9]+$/.test(String(requests[1][2]))).toBe(true);
      await act(async () => { container.find(node => node.tagName === 'BUTTON' && node.textContent === 'Stop')?.click(); });
      expect(requests[2].slice(0, 2)).toEqual(['ses_root', 'cancel']);
    } finally { await act(async () => root.unmount()); usePrimaryRecoveryStore.setState({ snapshots: {} }); }
  });
});

const retained = (sessionID = 'ses_root'): PrimaryRecoverySnapshot => ({ ...snapshot(), supported: false, enforced: false,
  record: null, recoveredInput: { revision: 'a'.repeat(64), state: 'paused', inputs: [{ messageID: `msg_${sessionID}`,
    payloadHash: 'b'.repeat(64), type: 'user', delivery: 'queue', location: 'queued', preview: `Saved request for ${sessionID}`,
    attachmentCount: 1, canResume: true, canDiscard: true, reason: null }] } });
const details = (sessionID = 'ses_root'): RecoveredInputDetails => ({ messageID: `msg_${sessionID}`, payloadHash: 'b'.repeat(64),
  type: 'user', delivery: 'queue', location: 'queued', text: 'Full retained text <script>never rendered as HTML</script>',
  files: [{ uri: 'https://example.invalid/private.png', name: 'private.png', mime: 'image/png' }],
  skills: [{ id: 'devryan-539ddc37a961e3aceadfc7bbb540b8e7', name: 'Superpowers' }] });

test('first retained input is visible without history or watchdog, with lazy details and exact actions', async () => {
  requests.length = 0; inputActions.length = 0; detailRequests.length = 0;
  respond = async () => {}; loadDetails = async () => details();
  const source = readFileSync(new URL('./ChatContainer.tsx', import.meta.url), 'utf8');
  const emptyBranch = source.slice(source.indexOf('if (sessionMessages.length === 0 && !sessionIsWorking)'), source.indexOf('currentSessionId={currentSessionId}'));
  expect(emptyBranch.match(/<HostPrimaryRecovery /g)).toHaveLength(1);
  await withDom(async container => {
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container as unknown as Element);
    try {
      usePrimaryRecoveryStore.setState({ snapshots: { ses_root: retained() } });
      await act(async () => root.render(<HostPrimaryRecovery sessionId="ses_root" showAvailability />));
      expect(container.textContent).toContain('Input retained after interruption');
      expect(container.textContent).toContain('Saved request for ses_root');
      expect(container.textContent).not.toContain('safeguards are unavailable');
      expect(detailRequests).toHaveLength(0);
      const disclosure = container.find(node => node.tagName === 'DETAILS');
      expect(disclosure?.find(node => node.tagName === 'SUMMARY')?.textContent).toBe('Review input');
      await act(async () => disclosure?.toggle(true));
      expect(detailRequests[0].slice(0, 2)).toEqual(['ses_root', { revision: 'a'.repeat(64), messageID: 'msg_ses_root', payloadHash: 'b'.repeat(64) }]);
      expect(container.textContent).toContain('Full retained text');
      expect(container.find(node => node.tagName === 'SCRIPT')).toBeNull();
      expect(container.find(node => node.tagName === 'IMG')).toBeNull();
      expect(container.find(node => node.tagName === 'A')).toBeNull();
      expect(container.textContent).toContain('private.png');
      expect(container.textContent).toContain('Skills: Superpowers');
      expect(container.textContent).not.toContain('devryan-539ddc37a961e3aceadfc7bbb540b8e7');
      await act(async () => disclosure?.toggle(false));
      expect(container.textContent).not.toContain('Full retained text');
      await act(async () => container.find(node => node.tagName === 'BUTTON' && node.textContent === 'Resume Input')?.click());
      await act(async () => container.find(node => node.tagName === 'BUTTON' && node.textContent === 'Discard Input')?.click());
      const exact = { revision: 'a'.repeat(64), messageID: 'msg_ses_root', payloadHash: 'b'.repeat(64) };
      expect(inputActions).toEqual([['ses_root', 'resume', exact], ['ses_root', 'discard', exact]]);
      expect(requests).toEqual([['ses_root']]);
    } finally { await act(async () => root.unmount()); usePrimaryRecoveryStore.setState({ snapshots: {} }); }
  });
});

test('late detail responses cannot appear after switching sessions', async () => {
  let finish: (value: RecoveredInputDetails) => void = () => {};
  loadDetails = () => new Promise(resolve => { finish = resolve; });
  detailRequests.length = 0;
  await withDom(async container => {
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container as unknown as Element);
    try {
      usePrimaryRecoveryStore.setState({ snapshots: { ses_root: retained(), ses_other: retained('ses_other') } });
      await act(async () => root.render(<HostPrimaryRecovery sessionId="ses_root" />));
      await act(async () => container.find(node => node.tagName === 'DETAILS')?.toggle(true));
      const signal = detailRequests[0][2] as AbortSignal;
      await act(async () => root.render(<HostPrimaryRecovery sessionId="ses_other" />));
      expect(signal.aborted).toBe(true);
      await act(async () => finish(details()));
      expect(container.textContent).toContain('Saved request for ses_other');
      expect(container.textContent).not.toContain('Full retained text');
      expect(container.textContent).not.toContain('Saved request for ses_root');
    } finally { await act(async () => root.unmount()); usePrimaryRecoveryStore.setState({ snapshots: {} }); }
  });
});

test('already-started retained input keeps session Stop separate from exact input actions', async () => {
  requests.length = 0; inputActions.length = 0;
  respond = async () => {};
  const current = retained();
  current.record = { ...snapshot().record!, state: 'needs_attention', revision: 9, collectionIssue: null };
  current.recoveredInput!.inputs[0] = { ...current.recoveredInput!.inputs[0], location: 'promoted',
    canResume: false, canDiscard: false, reason: 'assistant_incomplete' };
  await withDom(async container => {
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container as unknown as Element);
    try {
      usePrimaryRecoveryStore.setState({ snapshots: { ses_root: current } });
      await act(async () => root.render(<HostPrimaryRecovery sessionId="ses_root" />));
      expect(container.textContent).toContain('This input already started');
      expect(container.textContent).toContain('must settle');
      expect(container.find(node => node.tagName === 'BUTTON' && node.textContent === 'Resume Input')).toBeNull();
      expect(container.find(node => node.tagName === 'BUTTON' && node.textContent === 'Discard Input')).toBeNull();
      await act(async () => container.find(node => node.tagName === 'BUTTON' && node.textContent === 'Stop')?.click());
      expect(requests).toEqual([['ses_root'], ['ses_root', 'cancel', undefined]]);
      expect(inputActions).toEqual([]);
      expect(usePrimaryRecoveryStore.getState().snapshots.ses_root.record?.revision).toBe(9);
    } finally { await act(async () => root.unmount()); usePrimaryRecoveryStore.setState({ snapshots: {} }); }
  });
});

test('discarded input offers a new message while ordinary cancelled recovery keeps Stop', async () => {
  requests.length = 0; respond = async () => {};
  const discarded = snapshot();
  discarded.supported = false; discarded.enforced = false;
  discarded.record = { ...discarded.record!, state: 'cancelled', reason: 'recovered_input_discarded',
    recoveryID: 'msg_unpromoted', collectionIssue: null };
  await withDom(async container => {
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container as unknown as Element);
    try {
      usePrimaryRecoveryStore.setState({ snapshots: { ses_root: discarded } });
      await act(async () => root.render(<HostPrimaryRecovery sessionId="ses_root" />));
      expect(container.textContent).toContain('Input discarded');
      expect(container.textContent).toContain('Send a new message');
      expect(container.find(node => node.tagName === 'BUTTON' && node.textContent === 'Continue with Original Permissions')).toBeNull();
      const stopped = { ...discarded, supported: true, enforced: true,
        record: { ...discarded.record!, revision: discarded.record!.revision + 1, reason: 'user_stop' } };
      await act(async () => usePrimaryRecoveryStore.getState().accept('ses_root', stopped));
      expect(container.textContent).toContain('Continue with Original Permissions');
      await act(async () => container.find(node => node.tagName === 'BUTTON' && node.textContent === 'Stop')?.click());
      expect(requests.at(-1)).toEqual(['ses_root', 'cancel', undefined]);
    } finally { await act(async () => root.unmount()); usePrimaryRecoveryStore.setState({ snapshots: {} }); }
  });
});

test('partial event refresh coalesces and resumes after an input action finishes', async () => {
  requests.length = 0; inputActions.length = 0; respond = async () => {};
  let finish: () => void = () => {};
  await withDom(async container => {
    const listeners = new Map<string, (event: Event) => void>();
    Object.defineProperty(window, 'addEventListener', { value: (name: string, listener: (event: Event) => void) => listeners.set(name, listener) });
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container as unknown as Element);
    try {
      usePrimaryRecoveryStore.setState({ snapshots: { ses_root: retained() } });
      await act(async () => root.render(<HostPrimaryRecovery sessionId="ses_root" />));
      respond = () => new Promise(resolve => { finish = resolve; });
      await act(async () => container.find(node => node.tagName === 'BUTTON' && node.textContent === 'Discard Input')?.click());
      const event = new CustomEvent('openchamber:primary-recovery', { detail: { properties: { sessionID: 'ses_root',
        recovery: { ...retained(), recoveredInput: undefined, recoveredInputPartial: true } } } });
      await act(async () => {
        for (let index = 0; index < 3; index++) listeners.get('openchamber:primary-recovery')?.(event);
        await new Promise(resolve => setTimeout(resolve, 250));
      });
      expect(requests).toEqual([['ses_root']]);
      expect(container.textContent).toContain('Saved request for ses_root');
      respond = async () => { usePrimaryRecoveryStore.getState().accept('ses_root', { ...retained(), recoveredInput: undefined }); };
      await act(async () => { finish(); await new Promise(resolve => setTimeout(resolve, 250)); });
      expect(requests).toEqual([['ses_root'], ['ses_root']]);
      expect(inputActions).toHaveLength(1);
      expect(usePrimaryRecoveryStore.getState().snapshots.ses_root.recoveredInput).toBeUndefined();
    } finally { await act(async () => root.unmount()); usePrimaryRecoveryStore.setState({ snapshots: {} }); }
  });
});

test('original mounted attachment owner produces separate text nodes; original visible-text wait refuses their joined string', async () => {
  await withDom(async container => {
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container as unknown as Element);
    try {
      respond = async () => {}; loadDetails = async () => ({ ...details(), files: [{ uri: 'https://recovered-input-attachment.invalid/saved.txt', name: 'Saved attachment.txt', mime: 'text/plain' }] });
      usePrimaryRecoveryStore.setState({ snapshots: { ses_root: retained() } });
      await act(async () => root.render(<HostPrimaryRecovery sessionId="ses_root" />));
      await act(async () => container.find(node => node.tagName === 'DETAILS')?.toggle(true));
      const ul = container.find(node => node.tagName === 'UL' && node.getAttribute('aria-label') === 'Attachments');
      const li = ul?.find(node => node.tagName === 'LI');
      if (!ul || !li) throw new Error('Original attachment nodes missing');
      const nodes = li.childNodes.filter(node => node.nodeType === 3);
      expect(li.textContent).toBe('Saved attachment.txt (text/plain)');
      expect(nodes.map(node => node.textContent)).toEqual(['Saved attachment.txt', ' (text/plain)']);
      let clipped = false;
      const bounds = () => clipped
        ? { left: 38, right: 265, top: 900, bottom: 920, width: 227, height: 20 }
        : { left: 38, right: 265, top: 622, bottom: 642, width: 227, height: 20 };
      const cdp = { send: async (method: string, params: { expression: string }) => {
        expect(method).toBe('Runtime.evaluate');
        return { result: { value: runInNewContext(params.expression, {
          innerWidth: 390, innerHeight: 844, NodeFilter: { SHOW_TEXT: 4 },
          getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1', overflowX: 'visible', overflowY: 'visible' }),
          document: { querySelector: () => li,
            createTreeWalker: () => { let index = 0; return { nextNode: () => {
              const node = nodes[index++]; return node ? { textContent: node.textContent, parentElement: { parentElement: null, getBoundingClientRect: bounds } } : null;
            } }; },
            createRange: () => ({ selectNodeContents() {}, getClientRects: () => [bounds()] }),
          },
        }) } };
      } };
      const ui = createQaUiDriver(cdp, { timeoutMs: 1 });
      await expect(ui.waitVisibleText('Saved attachment.txt (text/plain)', 'ul[aria-label="Attachments"] li')).rejects.toThrow('Timed out: visible text Saved attachment.txt (text/plain)');
      await ui.waitVisibleText('Saved attachment.txt', 'ul[aria-label="Attachments"] li');
      await ui.waitVisibleText('(text/plain)', 'ul[aria-label="Attachments"] li');
      clipped = true;
      await expect(ui.waitVisibleText('Saved attachment.txt', 'ul[aria-label="Attachments"] li')).rejects.toThrow('Timed out: visible text Saved attachment.txt');
      await expect(ui.waitVisibleText('(text/plain)', 'ul[aria-label="Attachments"] li')).rejects.toThrow('Timed out: visible text (text/plain)');
    } finally {
      await act(async () => root.unmount());
      usePrimaryRecoveryStore.setState({ snapshots: {} });
    }
  });
});
