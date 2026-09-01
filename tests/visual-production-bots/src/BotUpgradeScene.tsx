import React from 'react';
import { Button } from '@/components/ui/button';
import { BotComposer } from '@/components/bots/chat/BotComposer';
import { BotInlineComputer } from '@/components/bots/chat/BotInlineComputer';
import { BotMessageList } from '@/components/bots/chat/BotMessageList';
import type { BotChannel, BotMessage, BotRun, BotSummary } from '@/lib/botsApi';
import { useBotChannelStore } from '@/stores/useBotChannelStore';
import { useBotComputerActivityStore } from '@/stores/useBotComputerActivityStore';
import { useBotOperationsStore } from '@/stores/useBotOperationsStore';

declare global {
  interface Window {
    __DEVRYAN_VISUAL_SCREEN_STREAMS__?: { starts: number; active: number; stops: number; maxActive: number };
  }
}

type Metrics = { history: number; renderedRows: number; draftsMsP95?: number; transcriptCommitsDuringTyping?: number; workingMsP95?: number; finalMsP95?: number; samples?: number; error?: string;
  warmup?: { settled: boolean; samples: number; durationMs: number; transcriptCommits: number; pendingAssistantRows: number } };
const percentile = (values: number[]) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1] ?? 0;
const nextPaint = () => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));

const ProfiledMessageList = React.memo(({ onCommit, ...props }: React.ComponentProps<typeof BotMessageList> & { onCommit: () => void }) => (
  <React.Profiler id="upgrade-transcript" onRender={onCommit}><BotMessageList {...props} /></React.Profiler>
));

export const BotUpgradeScene: React.FC<{ bot: BotSummary; channel: BotChannel; run: BotRun; installComputer: () => () => void }> = ({ bot, channel, run, installComputer }) => {
  const requestedCount = Number(new URLSearchParams(location.search).get('count') ?? 100);
  const initialCount = [0, 100, 1000, 5000].includes(requestedCount) ? requestedCount : 100;
  const [count, setCount] = React.useState(initialCount);
  const [working, setWorking] = React.useState(false);
  const [benchmarking, setBenchmarking] = React.useState(false);
  const [benchmarkRuns, setBenchmarkRuns] = React.useState<Metrics[]>([]);
  const [metrics, setMetrics] = React.useState<Metrics>({ history: initialCount, renderedRows: 0 });
  const [screen, setScreen] = React.useState(() => {
    const current = window.__DEVRYAN_VISUAL_SCREEN_STREAMS__;
    return current ? { ...current } : undefined;
  });
  const container = React.useRef<HTMLDivElement>(null);
  const commits = React.useRef(0);
  const countCommit = React.useCallback(() => { commits.current += 1; }, []);
  const sequence = React.useRef(0);
  const requestId = React.useRef('upgrade-working');
  const requestBase = React.useRef(initialCount);
  const createMessage = React.useCallback((index: number): BotMessage => ({
    id: `upgrade-history-${index}`, channelId: channel.id, runId: null, actorUserId: channel.ownerUserId,
    role: index % 2 ? 'assistant' : 'user', assistantPhase: index % 2 ? 'result' : null,
    sequence: index + 1, body: { text: index % 2
      ? `Verified answer ${index}: the release check completed successfully.\n\nThis deterministic answer includes **Markdown** and a concise result for the conversation.`
      : `Request ${index}: check deployment readiness and report the result.`, attachmentIds: [] },
    attachmentCount: 0, createdAt: '2026-08-31T00:00:00.000Z', finalizedAt: '2026-08-31T00:00:01.000Z',
  }), [channel.id, channel.ownerUserId]);
  const loadHistory = React.useCallback((nextCount: number) => {
    useBotChannelStore.getState().resetPrincipal(channel.ownerUserId);
    useBotChannelStore.getState().upsertChannel(channel);
    useBotChannelStore.getState().setActiveChannel(channel.id);
    useBotChannelStore.getState().mergeMessagePage(channel.id, { messages: Array.from({ length: nextCount }, (_, index) => createMessage(index)), nextCursor: null });
    useBotComputerActivityStore.getState().reset();
    setWorking(false); setCount(nextCount); setMetrics({ history: nextCount, renderedRows: 0 });
  }, [channel, createMessage]);
  React.useEffect(() => { loadHistory(initialCount); return installComputer(); }, [initialCount, installComputer, loadHistory]);
  React.useEffect(() => {
    const timer = setInterval(() => {
      setMetrics((value) => {
        const renderedRows = container.current?.querySelectorAll('[data-bot-message-id]').length ?? 0;
        return value.renderedRows === renderedRows ? value : { ...value, renderedRows };
      });
      const next = window.__DEVRYAN_VISUAL_SCREEN_STREAMS__;
      setScreen((current) => current && next && JSON.stringify(current) === JSON.stringify(next) ? current : next && { ...next });
    }, 250);
    return () => clearInterval(timer);
  }, []);
  const begin = () => {
    const id = `upgrade-run-${++sequence.current}`;
    requestId.current = id;
    requestBase.current = count + sequence.current * 3;
    useBotOperationsStore.getState().upsertRun({ ...run, id, state: 'running', finishedAt: null });
    useBotChannelStore.getState().upsertMessage({ ...createMessage(requestBase.current), id: `upgrade-user-${id}`, runId: id, role: 'user', assistantPhase: null, body: { text: 'Please run the next check.', attachmentIds: [] } });
    useBotChannelStore.getState().upsertMessage({ ...createMessage(requestBase.current + 1), id: `upgrade-ack-${id}`, runId: id, role: 'assistant', assistantPhase: 'acknowledgment', body: { text: 'HIDDEN ACKNOWLEDGMENT SENTINEL', attachmentIds: [] } });
    useBotChannelStore.getState().upsertMessage({ ...createMessage(requestBase.current + 2), id: `upgrade-result-${id}`, runId: id, role: 'assistant', assistantPhase: 'result', finalizedAt: null, body: { text: 'HIDDEN PARTIAL PREAMBLE SENTINEL', attachmentIds: [] } });
    setWorking(true);
  };
  const finish = () => {
    const id = requestId.current;
    useBotChannelStore.getState().upsertMessage({ ...createMessage(requestBase.current + 2), id: `upgrade-result-${id}`, runId: id, role: 'assistant', assistantPhase: 'result', body: { text: 'Verified final result: every release check passed. No preamble or internal reasoning appears here.', attachmentIds: [] } });
    useBotOperationsStore.getState().upsertRun({ ...run, id, state: 'completed', finishedAt: new Date().toISOString() });
    setWorking(false);
  };
  const benchmark = async () => {
    setBenchmarking(true);
    try {
      const typing: number[] = [];
      const warmupStarted = performance.now();
      const warmupCommits = commits.current;
      let previousCommits = commits.current;
      let stablePaints = 0;
      let warmupSamples = 0;
      let pendingAssistantRows = 0;
      while (stablePaints < 3 && warmupSamples < 20 && performance.now() - warmupStarted < 3000) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const painted = await Promise.race([
          nextPaint().then(() => true),
          new Promise<boolean>((done) => { timer = setTimeout(() => done(false), 500); }),
        ]);
        clearTimeout(timer);
        warmupSamples += 1;
        if (!painted) break;
        // Keep warm measurements separate from deferred Markdown work. Cold
        // first-answer paint is measured in a fresh, empty-history scene.
        const assistantRows = Array.from(container.current?.querySelectorAll('[data-bot-message-role="assistant"]') ?? []);
        pendingAssistantRows = assistantRows.filter((row) => row.querySelector('[data-bot-final-text-fallback]')
          || !row.textContent?.includes('Verified answer')).length;
        stablePaints = previousCommits === commits.current && assistantRows.length > 0 && pendingAssistantRows === 0
          ? stablePaints + 1 : 0;
        previousCommits = commits.current;
      }
      const warmup = { settled: stablePaints >= 3, samples: warmupSamples,
        durationMs: performance.now() - warmupStarted, transcriptCommits: commits.current - warmupCommits, pendingAssistantRows };
      if (!warmup.settled) {
        const result: Metrics = { history: count, renderedRows: container.current?.querySelectorAll('[data-bot-message-id]').length ?? 0,
          warmup, error: 'The transcript did not settle within the bounded warmup. No latency samples were collected.' };
        setMetrics(result); setBenchmarkRuns((previous) => [...previous, result]);
        return;
      }
      const before = commits.current;
      for (let index = 0; index < 30; index += 1) {
        const start = performance.now();
        useBotChannelStore.getState().setDraft(channel.id, { text: `Draft ${index} typed without transcript work`, attachmentIds: [] });
        await nextPaint(); typing.push(performance.now() - start);
      }
      const transcriptCommitsDuringTyping = commits.current - before;
      const workingDelays: number[] = [];
      const finalDelays: number[] = [];
      for (let index = 0; index < 30; index += 1) {
        const started = performance.now(); begin(); await nextPaint();
        workingDelays.push(performance.now() - started);
        const finalized = performance.now(); finish(); await nextPaint();
        finalDelays.push(performance.now() - finalized);
      }
      const result: Metrics = { history: count, renderedRows: container.current?.querySelectorAll('[data-bot-message-id]').length ?? 0,
        warmup, samples: 30, draftsMsP95: percentile(typing), transcriptCommitsDuringTyping,
        workingMsP95: percentile(workingDelays), finalMsP95: percentile(finalDelays) };
      setMetrics(result);
      setBenchmarkRuns((previous) => [...previous, result]);
    } catch (error) { setMetrics((value) => ({ ...value, error: error instanceof Error ? error.message : String(error) })); }
    finally { setBenchmarking(false); }
  };
  const computerSlot = React.useMemo(() => <BotInlineComputer botId={bot.id} channelId={channel.id} botActive />, [bot.id, channel.id]);
  return <div className="space-y-3" data-bot-upgrade-fixture>
    <h1 className="typography-ui-header">Bot interaction and responsiveness</h1>
    <p className="typography-meta text-muted-foreground">Real components with synthetic messages and an ephemeral local screen. Paint measurements include two animation frames and this machine’s load; provider execution is not simulated.</p>
    <div className="flex flex-wrap gap-2">
      {[100, 1000, 5000].map((size) => <Button key={size} size="xs" variant="outline" onClick={() => loadHistory(size)}>Load {size} messages</Button>)}
      <Button size="xs" onClick={begin}>Begin working</Button>
      <Button size="xs" disabled={!working} onClick={finish}>Deliver final answer</Button>
      <Button size="xs" disabled={benchmarking} onClick={() => void benchmark()}>{benchmarking ? 'Benchmark running' : 'Run interaction benchmark'}</Button>
      <Button size="xs" variant="outline" onClick={() => useBotComputerActivityStore.getState().upsert({ botId: bot.id, channelId: channel.id, runId: requestId.current, revision: ++sequence.current, state: 'active' })}>Start computer activity</Button>
      <Button size="xs" variant="outline" onClick={() => useBotComputerActivityStore.getState().upsert({ botId: bot.id, channelId: 'another-channel', runId: 'other-run', revision: ++sequence.current, state: 'active' })}>Hand off computer</Button>
      <Button size="xs" variant="outline" onClick={() => useBotComputerActivityStore.getState().show(bot.id, channel.id)}>Show computer</Button>
    </div>
    <output className="block whitespace-pre-wrap rounded-lg border p-2 font-mono text-xs" data-upgrade-metrics>{JSON.stringify({ ...metrics, screen, benchmarkRuns }, null, 2)}</output>
    <div ref={container} className="flex h-[600px] min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-background">
      <ProfiledMessageList onCommit={countCommit} bot={bot} channelId={channel.id} typingRunId={working ? requestId.current : null} computerSlot={computerSlot} />
      <BotComposer botId={bot.id} channel={channel} runtimeState="healthy" runtimeAvailable />
    </div>
  </div>;
};
