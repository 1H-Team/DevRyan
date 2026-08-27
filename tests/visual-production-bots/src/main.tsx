import React from 'react';
import { createRoot } from 'react-dom/client';
import {
  RiComputerLine,
  RiFileShield2Line,
  RiGlobalLine,
  RiInformationLine,
  RiShieldCheckLine,
} from '@remixicon/react';

import '@/index.css';
import '@/styles/fonts';
import { BotMessageRow } from '@/components/bots/chat/BotMessageRow';
import { BotOperationsRail } from '@/components/bots/operations/BotOperationsRail';
import { BotAgentConnections } from '@/components/sections/bots/BotAgentConnections';
import { BotPolicyEditor } from '@/components/sections/bots/BotPolicyEditor';
import { BotRuntimeServicePanel } from '@/components/sections/bots/BotRuntimeServicePanel';
import { BotSpecManager } from '@/components/sections/bots/BotSpecManager';
import { RuntimeAPIProvider } from '@/contexts/RuntimeAPIProvider';
import { createDefaultBotRevisionContract } from '@/components/sections/bots/botManagementPresentation';
import {
  setAuthPrincipal,
  type AuthPrincipal,
} from '@/lib/authSession';
import {
  withBotRevisionAgent,
  type BotActionAttempt,
  type BotAgentConnection,
  type BotChannel,
  type BotMessage,
  type BotRevisionContract,
  type BotRevisionDetail,
  type BotRun,
  type BotSpecImportPreview,
  type BotSummary,
  type BotsApi,
} from '@/lib/botsApi';
import type { BotsDesktopApi, RuntimeServiceStatus } from '@/lib/botsDesktopApi';
import { I18nProvider } from '@/lib/i18n';
import { useBotChannelStore } from '@/stores/useBotChannelStore';
import { useBotOperationsNavigationStore } from '@/stores/useBotOperationsNavigationStore';
import { useBotOperationsStore } from '@/stores/useBotOperationsStore';
import { useBotsStore } from '@/stores/useBotsStore';
import './fixture.css';
import { createWebAPIs } from '../../../packages/web/src/api';

declare global {
  interface Window {
    __DEVRYAN_VISUAL_FIXTURE_READY__?: boolean;
    __DEVRYAN_VISUAL_FIXTURE_ERRORS__?: string[];
    __DEVRYAN_VISUAL_FIXTURE_ROOT__?: ReturnType<typeof createRoot>;
  }
}

const BOT_ID = 'b0000000-0000-4000-8000-000000000001';
const REVISION_ID = 'c0000000-0000-4000-8000-000000000001';
const CHANNEL_ID = 'd0000000-0000-4000-8000-000000000001';
const RUN_ID = 'f0000000-0000-4000-8000-000000000001';
const ACTION_ID = 'a1000000-0000-4000-8000-000000000001';
const USER_ID = 'a0000000-0000-4000-8000-000000000001';
const MESSAGE_ID = 'd1000000-0000-4000-8000-000000000001';
const NOW = '2026-08-27T10:00:00.000Z';
const runtimeApis = createWebAPIs();

const query = new URLSearchParams(window.location.search);
const scene = query.get('scene') || 'agent';
const fixtureState = query.get('state') || 'healthy';
const theme = query.get('theme') === 'dark' ? 'dark' : 'light';
const role = query.get('role') === 'developer' ? 'developer' : 'admin';
const railWidth = [220, 280, 500].includes(Number(query.get('rail')))
  ? Number(query.get('rail'))
  : 280;
const drawer = query.get('drawer') === 'closed' ? 'closed' : 'open';

document.documentElement.dataset.theme = theme;
document.documentElement.classList.toggle('dark', theme === 'dark');
document.documentElement.style.colorScheme = theme;
window.__DEVRYAN_VISUAL_FIXTURE_ERRORS__ = [];

window.addEventListener('error', (event) => {
  window.__DEVRYAN_VISUAL_FIXTURE_ERRORS__?.push(event.message || 'window_error');
});
window.addEventListener('unhandledrejection', (event) => {
  window.__DEVRYAN_VISUAL_FIXTURE_ERRORS__?.push(
    event.reason instanceof Error ? event.reason.message : 'unhandled_rejection',
  );
});

const adminPrincipal: AuthPrincipal = {
  id: USER_ID,
  email: 'admin@example.test',
  displayName: 'Test Administrator',
  role: 'admin',
  scope: 'managed',
  policy: {
    settingsPages: ['*'],
    bots: true,
    files: true,
    terminal: true,
    browser: true,
    createWorktrees: true,
    createBranches: true,
    manageProjects: true,
    manageUsers: true,
    manageGlobalSettings: true,
    manageGit: true,
    push: true,
    github: true,
  },
  assignments: [],
};
const developerPrincipal: AuthPrincipal = {
  ...adminPrincipal,
  email: 'developer@example.test',
  displayName: 'Test Developer',
  role: 'developer',
  policy: {
    ...adminPrincipal.policy,
    settingsPages: ['bots'],
    manageProjects: false,
    manageUsers: false,
    manageGlobalSettings: false,
    push: false,
  },
};
setAuthPrincipal(role === 'developer' ? developerPrincipal : adminPrincipal);

const baseContract = createDefaultBotRevisionContract('Release Steward');
const opencodeContract = withBotRevisionAgent(baseContract, {
  kind: 'opencode',
  models: baseContract.models,
});

const connectionStatus = fixtureState === 'revoked' ? 'revoked' : fixtureState === 'failed' ? 'error' : 'active';
const connectionHealth = fixtureState === 'revoked'
  ? { state: 'revoked' as const, checkedAt: NOW, code: 'agent_connection_revoked' }
  : fixtureState === 'failed'
    ? { state: 'failed' as const, checkedAt: NOW, code: 'agent_endpoint_timeout' }
    : fixtureState === 'testing'
      ? null
      : { state: 'healthy' as const, checkedAt: NOW, code: null };

const agentConnection: BotAgentConnection = {
  id: 'e0000000-0000-4000-8000-000000000001',
  botId: BOT_ID,
  name: 'Governed AG-UI endpoint',
  endpointUrl: 'https://agent.example.test/v1/run',
  protocolVersion: 'ag-ui/v1',
  authMode: 'bearer',
  hasCredential: true,
  modelHint: 'reasoning-large',
  limits: {
    maximumStreamBytes: 262_144,
    maximumTextBytes: 196_608,
    maximumArgumentBytes: 65_536,
    maximumEventCount: 4_096,
  },
  descriptorDigest: 'a'.repeat(64),
  status: connectionStatus,
  health: connectionHealth,
  createdAt: NOW,
  updatedAt: NOW,
  revokedAt: connectionStatus === 'revoked' ? NOW : null,
};

const agUiContract = withBotRevisionAgent(opencodeContract, {
  kind: 'ag_ui',
  connectionRef: agentConnection.id,
  connectionDigest: agentConnection.descriptorDigest,
  modelHint: agentConnection.modelHint || undefined,
});

const isolationTier: 'standard' | 'runsc' = fixtureState === 'runsc'
  || fixtureState === 'runsc_unavailable'
  ? 'runsc'
  : 'standard';

const policyContract: BotRevisionContract = {
  ...opencodeContract,
  actionPolicy: {
    matcherVersion: 2,
    defaultEffect: 'prompt',
    defaultRisk: 'sensitive',
    rules: [{
      id: 'release.publish',
      effect: 'prompt',
      risk: 'critical',
      match: {
        tool: 'browser',
        actions: ['submit'],
        actorRoles: ['operator', 'manager'],
        urlPathGlobs: ['/releases/**'],
        filePaths: { quantifier: 'all', globs: ['/Shared/release/**', '/Team/notes/*.md'] },
        argumentPredicates: [
          { pointer: '/confirmed', op: 'eq', value: true },
          { pointer: '/assets', op: 'arrayContains', value: 'manifest.json' },
        ],
      },
      quota: { scope: 'actor', limit: 3, windowSeconds: 3_600 },
      retainEvidence: true,
      ttlSeconds: 600,
    }],
  },
  browserPolicy: {
    allowedOrigins: ['https://releases.example.test'],
    deniedOrigins: [],
    networkAccess: fixtureState === 'allowlist'
      ? { mode: 'allowlist', hosts: ['releases.example.test:443', 'cdn.example.test:443'] }
      : { mode: 'public_only', hosts: [] },
  },
  computerPolicy: { isolationTier },
};

const specPreview: BotSpecImportPreview = {
  metadata: { name: 'Release Steward', revision: 12 },
  specHash: '7'.repeat(64),
  sourceCompiledHash: '8'.repeat(64),
  signer: {
    keyId: 'release-signing-2026',
    publicKey: 'MCowBQYDK2VwAyEAportable-public-key',
    status: fixtureState === 'untrusted' ? 'unknown' : 'trusted',
    acknowledgementRequired: fixtureState === 'untrusted',
  },
  target: { botId: BOT_ID, name: 'Release Steward' },
  requirements: [{
    kind: 'agent_connection',
    logicalKey: 'release-agent',
    portableDigest: '9'.repeat(64),
    candidates: fixtureState === 'binding_failed' ? [] : [{
      id: agentConnection.id,
      label: agentConnection.name,
      digest: agentConnection.descriptorDigest,
      exact: true,
    }],
  }],
  readyForPublication: false,
};

const mockBotsApi = {
  listBotAgentConnections: async () => ({ connections: [agentConnection], canManage: role === 'admin' }),
  createBotAgentConnection: async () => ({ connection: agentConnection }),
  updateBotAgentConnection: async () => ({ connection: agentConnection }),
  testBotAgentConnection: async () => ({
    connection: { ...agentConnection, health: { state: 'healthy', checkedAt: NOW, code: null } },
  }),
  revokeBotAgentConnection: async () => ({
    connection: { ...agentConnection, status: 'revoked', revokedAt: NOW },
  }),
  previewBotSpecImport: async () => {
    if (fixtureState === 'tampered') {
      throw new Error('Signature verification failed. The portable specification was modified.');
    }
    return specPreview;
  },
  exportBotSpec: async () => ({
    filename: 'DevRyan-Bot-release-steward-r12.devryan-bot.json',
    source: '{"apiVersion":"devryan.ai/bot-revision/v1"}\n',
  }),
  setBotSignerTrust: async () => ({ trust: { status: 'trusted' } }),
  importBotSpecDraft: async () => ({
    revision: { revisionNumber: 13 },
    compiledHashMatches: true,
    unresolvedBindings: fixtureState === 'binding_failed' ? ['release-agent'] : [],
  }),
} as unknown as BotsApi;

const revision: BotRevisionDetail = {
  id: REVISION_ID,
  botId: BOT_ID,
  revisionNumber: 12,
  compiledHash: '8'.repeat(64),
  createdBy: USER_ID,
  createdAt: NOW,
  updatedAt: NOW,
  activatedAt: NOW,
  retiredAt: null,
  contract: policyContract,
};

const runtimeStatus = (): RuntimeServiceStatus => {
  const statusState = fixtureState === 'consent'
    ? 'requires_approval'
    : fixtureState === 'disabled'
      ? 'not_registered'
      : 'enabled';
  const connected = ['starting', 'connected', 'degraded', 'updating', 'desktop_unavailable'].includes(fixtureState);
  return {
    configuredMode: fixtureState === 'disabled' ? 'disabled' : connected ? 'service' : 'app_bound',
    registrationMode: fixtureState === 'legacy_consent' ? 'legacy' : 'smappservice',
    registration: { ok: true, state: statusState, code: null },
    connected,
    handshake: connected ? {
      instanceId: '123e4567-e89b-42d3-a456-426614174000',
      protocolVersion: 2,
      health: fixtureState === 'starting'
        ? 'starting'
        : fixtureState === 'degraded'
          ? 'degraded'
          : fixtureState === 'updating'
            ? 'updating'
            : 'healthy',
      ownerGeneration: 5,
      desktopHost: {
        state: fixtureState === 'desktop_unavailable' ? 'unavailable' : 'connected',
        capabilities: fixtureState === 'desktop_unavailable' ? [] : ['focus', 'browser_cdp'],
      },
    } : null,
    settingsUrl: 'x-apple.systempreferences:com.apple.LoginItems-Settings.extension',
    canEnable: statusState === 'not_registered' || statusState === 'enabled',
  };
};

const mockDesktopApi = {
  isAvailable: () => true,
  status: async () => ({ ok: true, state: 'healthy', code: null, issues: [], manifest: null, desiredManifest: null, updateStaged: false, canSetup: false, canRepair: false, canUpdate: false, canRollback: false }),
  setup: async () => { throw new Error('not used'); },
  repair: async () => { throw new Error('not used'); },
  update: async () => { throw new Error('not used'); },
  rollback: async () => { throw new Error('not used'); },
  exportRecovery: async () => ({ cancelled: true }),
  restoreRecovery: async () => ({ cancelled: true }),
  runtimeServiceStatus: async () => runtimeStatus(),
  enableRuntimeService: async () => runtimeStatus(),
  disableRuntimeService: async () => runtimeStatus(),
  openRuntimeServiceSettings: async () => undefined,
} as BotsDesktopApi;

const bot: BotSummary = {
  id: BOT_ID,
  name: 'Release Steward',
  title: 'Release operations lead',
  summary: 'Coordinates reviewed releases without receiving gateway authority.',
  avatarUrl: null,
  avatarFallback: 'RS',
  lifecycle: fixtureState === 'retired' ? 'retired' : 'active',
  tenancy: 'team',
  activeRevisionId: REVISION_ID,
  createdAt: NOW,
  updatedAt: NOW,
  retiredAt: fixtureState === 'retired' ? NOW : null,
};

const channel: BotChannel = {
  id: CHANNEL_ID,
  botId: BOT_ID,
  ownerUserId: USER_ID,
  accessRole: role === 'developer' ? 'reader' : 'collaborator',
  canSend: role === 'admin',
  lifecycle: 'active',
  currentCheckpointNumber: 3,
  lastMessageSequence: 2,
  lastMessageAt: NOW,
  createdAt: NOW,
  updatedAt: NOW,
  archivedAt: null,
};

const runState: BotRun['state'] = fixtureState === 'reconciliation'
  ? 'needs_reconciliation'
  : fixtureState === 'paused'
    ? 'interrupted'
    : fixtureState === 'settled'
      ? 'completed'
      : fixtureState === 'failure'
        ? 'failed'
        : 'waiting_approval';

const run: BotRun = {
  id: RUN_ID,
  botId: BOT_ID,
  channelId: CHANNEL_ID,
  revisionId: REVISION_ID,
  modelSnapshot: { adapter: 'ag_ui' },
  computerScopeKey: `bot:${BOT_ID}`,
  queueSequence: 4,
  state: runState,
  retryable: false,
  interruptionKind: fixtureState === 'paused' ? 'desktop_host_unavailable' : null,
  createdAt: NOW,
  updatedAt: NOW,
  startedAt: NOW,
  finishedAt: ['settled', 'failure', 'paused'].includes(fixtureState) ? NOW : null,
};

const actionState: BotActionAttempt['state'] = fixtureState === 'reconciliation'
  ? 'needs_reconciliation'
  : fixtureState === 'settled'
    ? 'succeeded'
    : fixtureState === 'failure'
      ? 'failed'
      : 'pending_approval';

const action: BotActionAttempt = {
  id: ACTION_ID,
  runId: RUN_ID,
  botId: BOT_ID,
  revisionId: REVISION_ID,
  credentialId: null,
  computerScopeKey: `bot:${BOT_ID}`,
  actionHash: 'decision-bound-hash',
  argsDigest: 'sanitized-digest',
  tool: 'browser',
  action: 'submit release',
  target: {},
  risk: 'critical',
  approvalClass: 'manager',
  policyEffect: 'prompt',
  policyRuleIds: ['release.publish'],
  decisionExpiresAt: '2026-08-27T11:00:00.000Z',
  requiresDistinctApprover: true,
  retainEvidence: true,
  state: actionState,
  unknownOutcome: fixtureState === 'reconciliation',
  reconciliationDecision: null,
  initiatedBy: USER_ID,
  createdAt: NOW,
  updatedAt: NOW,
  startedAt: null,
  finishedAt: ['settled', 'failure'].includes(fixtureState) ? NOW : null,
};

const message: BotMessage = {
  id: MESSAGE_ID,
  channelId: CHANNEL_ID,
  runId: RUN_ID,
  actorUserId: null,
  role: 'assistant',
  assistantPhase: 'result',
  sequence: 2,
  body: {
    text: 'The release package is prepared. One governed browser submission is waiting for review.',
    attachmentIds: [],
  },
  attachmentCount: 0,
  createdAt: NOW,
  finalizedAt: NOW,
};

const initializeStores = () => {
  useBotsStore.getState().resetPrincipal(USER_ID);
  useBotChannelStore.getState().resetPrincipal(USER_ID);
  useBotOperationsStore.getState().resetPrincipal(USER_ID);
  useBotsStore.getState().replaceSnapshot({
    bots: [bot],
    revisions: [revision],
    memberships: [{
      botId: BOT_ID,
      userId: USER_ID,
      role: role === 'admin' ? 'manager' : 'member',
      activatedAt: NOW,
      revokedAt: null,
      updatedAt: NOW,
    }],
  });
  useBotChannelStore.getState().replaceSnapshot({ channels: [channel] });
  if (fixtureState !== 'empty' && fixtureState !== 'loading') {
    useBotChannelStore.getState().upsertMessage(message);
  }
  const hasOperations = fixtureState !== 'empty' && fixtureState !== 'loading';
  useBotOperationsStore.getState().replaceSnapshot({
    runs: hasOperations ? [run] : [],
    recentActions: hasOperations ? [action] : [],
    pendingApprovals: hasOperations && action.state === 'pending_approval' ? [action] : [],
    computers: [],
  });
  useBotOperationsStore.getState().setConnectionState(
    fixtureState === 'partial_failure'
      ? 'reconnecting'
      : fixtureState === 'loading'
        ? 'connecting'
        : fixtureState === 'failure'
          ? 'error'
          : 'connected',
    fixtureState === 'partial_failure'
      ? 'bot_event_connection_lost'
      : fixtureState === 'failure'
        ? 'bot_event_connection_failed'
        : null,
  );
  if (hasOperations) {
    const operationTab = action.state === 'pending_approval' ? 'approvals' : 'activity';
    if (scene === 'transcript' && drawer === 'open') {
      useBotOperationsNavigationStore.getState().focusAction(BOT_ID, operationTab, ACTION_ID);
    } else {
      useBotOperationsNavigationStore.getState().selectTab(BOT_ID, operationTab);
    }
  } else {
    useBotOperationsNavigationStore.getState().selectTab(BOT_ID, 'activity');
  }
};
initializeStores();

const FixtureHeader: React.FC = () => (
  <header className="flex min-h-[72px] flex-wrap items-center justify-between gap-3 border-b border-border bg-[var(--surface-elevated)] px-6 py-3">
    <div className="flex items-center gap-3">
      <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-background text-primary">
        <RiShieldCheckLine className="h-5 w-5" aria-hidden />
      </span>
      <div>
        <p className="typography-micro uppercase tracking-[0.16em] text-muted-foreground">Production Bots visual fixture</p>
        <h1 className="typography-ui-header font-semibold text-foreground">{scene.replaceAll('_', ' ')} · {fixtureState.replaceAll('_', ' ')}</h1>
      </div>
    </div>
    <div className="flex items-center gap-2">
      <span className="rounded-full border border-border px-2.5 py-1 typography-micro text-muted-foreground">{theme}</span>
      <span className="rounded-full border border-border px-2.5 py-1 typography-micro text-muted-foreground">{role}</span>
      <span className="rounded-full border border-border px-2.5 py-1 typography-micro text-muted-foreground">rail {railWidth}px</span>
    </div>
  </header>
);

const SectionTitle: React.FC<{ icon: React.ComponentType<{ className?: string }>; title: string; detail: string }> = ({ icon: Icon, title, detail }) => (
  <div className="mb-5 flex items-start gap-3">
    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-[var(--surface-elevated)] text-muted-foreground"><Icon className="h-4 w-4" /></span>
    <div>
      <h2 className="typography-ui-header font-semibold text-foreground">{title}</h2>
      <p className="typography-ui text-muted-foreground">{detail}</p>
    </div>
  </div>
);

const AgentScene: React.FC = () => {
  const [contract, setContract] = React.useState<BotRevisionContract>(
    fixtureState === 'opencode' ? opencodeContract : agUiContract,
  );
  return (
    <>
      <SectionTitle icon={RiGlobalLine} title="Reasoning adapter" detail="Choose who reasons. Every action still crosses the governed DevRyan gateway." />
      {fixtureState === 'privacy_warning' ? (
        <div className="mb-4 flex gap-3 rounded-xl border border-[var(--status-warning)]/35 bg-[var(--status-warning)]/10 p-4" role="note">
          <RiInformationLine className="h-5 w-5 shrink-0" aria-hidden />
          <p className="typography-ui text-foreground">The remote endpoint receives conversation context and tool outcomes, but never gateway credentials, computer tokens, local callback URLs, or stored secret values.</p>
        </div>
      ) : null}
      {fixtureState === 'testing' ? <p className="mb-3 typography-ui text-[var(--status-info)]" role="status">Testing endpoint health and AG-UI compatibility…</p> : null}
      <BotAgentConnections botId={BOT_ID} value={contract} readOnly={role === 'developer'} api={mockBotsApi} onChange={setContract} />
    </>
  );
};

const SpecScene: React.FC = () => {
  React.useEffect(() => {
    const timer = window.setTimeout(() => {
      const input = document.querySelector<HTMLInputElement>('input[type="file"][accept*="devryan-bot"]');
      if (!input) return;
      const transfer = new DataTransfer();
      transfer.items.add(new File(
        ['{"apiVersion":"devryan.ai/bot-revision/v1","kind":"BotRevision"}'],
        'DevRyan-Bot-release-steward-r12.devryan-bot.json',
        { type: 'application/json' },
      ));
      Object.defineProperty(input, 'files', { configurable: true, value: transfer.files });
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, 50);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <div className="space-y-4">
      {fixtureState === 'diff' ? (
        <section className="rounded-xl border border-border/70 bg-[var(--surface-elevated)]/30 p-4" aria-labelledby="portable-diff-heading">
          <h2 id="portable-diff-heading" className="typography-ui-label font-semibold text-foreground">Portable revision diff</h2>
          <p className="mt-1 typography-micro text-muted-foreground">Portable spec hash matches. Local binding resolution changes only the compiled hash shown below.</p>
          <dl className="mt-3 grid gap-2 sm:grid-cols-2">
            <div className="rounded-lg border border-border p-3"><dt className="typography-micro text-muted-foreground">Portable spec</dt><dd className="font-mono typography-micro text-[var(--status-success)]">777777777777…77777777 · unchanged</dd></div>
            <div className="rounded-lg border border-border p-3"><dt className="typography-micro text-muted-foreground">Local compiled</dt><dd className="font-mono typography-micro text-foreground">888888888888…88888888 → draft-local</dd></div>
          </dl>
        </section>
      ) : null}
      <BotSpecManager botId={BOT_ID} revisions={[revision]} api={mockBotsApi} />
    </div>
  );
};

const PolicyScene: React.FC = () => {
  const [contract, setContract] = React.useState<React.ComponentProps<typeof BotPolicyEditor>['value']>(policyContract);
  return (
    <>
      <SectionTitle icon={RiFileShield2Line} title="Deterministic policy" detail="Structured facts remain canonical, bounded, and exactly approval-bindable." />
      {fixtureState === 'quota_exhausted' ? (
        <div className="mb-4 rounded-xl border border-[var(--status-error)]/35 bg-[var(--status-error)]/10 p-4" role="alert">
          <p className="typography-ui-label font-semibold text-foreground">Quota exhausted for this decision window</p>
          <p className="mt-1 typography-micro text-muted-foreground">3 of 3 actor-scoped release submissions are already consumed. A new proposal can be evaluated after the fixed window ends.</p>
        </div>
      ) : null}
      {fixtureState === 'validation_error' ? (
        <div className="mb-4 rounded-xl border border-[var(--status-error)]/35 bg-[var(--status-error)]/10 p-4" role="alert">Encoded separators are not allowed in URL path globs.</div>
      ) : null}
      <BotPolicyEditor value={contract} readOnly={role === 'developer'} onChange={setContract} />
    </>
  );
};

const NetworkScene: React.FC = () => {
  const policyWindowRef = React.useRef<HTMLDivElement>(null);
  React.useLayoutEffect(() => {
    const container = policyWindowRef.current;
    if (!container) return;
    const legend = Array.from(container.querySelectorAll('legend')).find(
      (candidate) => candidate.textContent?.trim() === 'Computer network and isolation',
    );
    const target = legend?.closest('fieldset');
    if (!target) return;
    target.setAttribute('data-visual-focus-scope', 'true');
    const targetRect = target.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    container.scrollTop += targetRect.top - containerRect.top - 8;
  }, []);
  return (
    <>
      <SectionTitle icon={RiComputerLine} title="Browser network & computer isolation" detail="The browser has no direct public interface; authenticated traffic exits through the revision-bound proxy." />
      {fixtureState === 'private_denial' || fixtureState === 'proxy_failure' || fixtureState === 'runsc_unavailable' ? (
        <div className="mb-4 rounded-xl border border-[var(--status-error)]/35 bg-[var(--status-error)]/10 p-4" role="alert">
          <p className="typography-ui-label font-semibold text-foreground">
            {fixtureState === 'private_denial' ? 'Private network request denied' : fixtureState === 'proxy_failure' ? 'Browser proxy unavailable' : 'Hardened runtime unavailable'}
          </p>
          <p className="mt-1 typography-micro text-muted-foreground">
            {fixtureState === 'private_denial'
              ? 'The resolved destination is private, link-local, metadata, or otherwise reserved. No target details were added to the transcript.'
              : fixtureState === 'proxy_failure'
                ? 'Browser networking is disabled until the governed egress service is healthy. Direct container egress is not used as a fallback.'
                : 'Docker did not pass the owned runsc smoke check. This revision cannot publish or silently downgrade to standard isolation.'}
          </p>
        </div>
      ) : null}
      <div
        ref={policyWindowRef}
        className="max-h-[520px] overflow-y-auto rounded-xl border border-border/70 bg-background p-3"
        data-network-policy-window
      >
        <BotPolicyEditor value={policyContract} readOnly={role === 'developer'} onChange={() => undefined} />
      </div>
    </>
  );
};

const RuntimeScene: React.FC = () => (
  <div className="overflow-hidden rounded-xl border border-border bg-background">
    <BotRuntimeServicePanel canManage={role === 'admin'} desktopApi={mockDesktopApi} initialStatus={runtimeStatus()} />
    <div className="p-6">
      <SectionTitle icon={RiComputerLine} title="Runtime ownership" detail="The signed background process owns scheduling, memory, computer supervision, and the private runtime." />
      <dl className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-border p-3"><dt className="typography-micro text-muted-foreground">Protocol</dt><dd className="typography-ui-label text-foreground">Current + previous supported</dd></div>
        <div className="rounded-lg border border-border p-3"><dt className="typography-micro text-muted-foreground">Owner generation</dt><dd className="typography-ui-label text-foreground">Fenced, single writer</dd></div>
        <div className="rounded-lg border border-border p-3"><dt className="typography-micro text-muted-foreground">Renderer session</dt><dd className="typography-ui-label text-foreground">HttpOnly · SameSite=Strict</dd></div>
        <div className="rounded-lg border border-border p-3"><dt className="typography-micro text-muted-foreground">Docker preparation</dt><dd className="typography-ui-label text-foreground">Background progress; never splash-blocking</dd></div>
      </dl>
    </div>
  </div>
);

const TranscriptScene: React.FC = () => (
  <div className="space-y-5">
    <SectionTitle icon={RiShieldCheckLine} title="Response content only" detail="Governed actions stay in the Operations rail and do not add tool status or links to Bot responses." />
    {fixtureState === 'empty' ? (
      <div className="rounded-xl border border-dashed border-border p-8 text-center">
        <p className="typography-ui-label font-semibold text-foreground">No Bot activity yet</p>
        <p className="mt-1 typography-micro text-muted-foreground">Runs and governed actions will appear here after the first message.</p>
      </div>
    ) : fixtureState === 'loading' ? (
      <div className="rounded-xl border border-border bg-[var(--surface-elevated)] p-5" role="status" aria-label="Loading Bot transcript">
        <div className="h-3 w-28 animate-pulse rounded bg-border" />
        <div className="mt-4 h-20 animate-pulse rounded-xl bg-[var(--surface-subtle)]" />
      </div>
    ) : (
      <div className="rounded-xl border border-border bg-[var(--surface-elevated)] p-5">
        <BotMessageRow bot={bot} messageId={MESSAGE_ID} />
      </div>
    )}
    <div className="rounded-xl border border-border/70 bg-[var(--surface-subtle)]/40 p-4">
      <p className="typography-ui-label font-semibold text-foreground">Activity isolation contract</p>
      <p className="mt-1 typography-micro text-muted-foreground">No tool/action/status marker, activity link, or approval control is rendered inside the assistant response.</p>
    </div>
  </div>
);

const MainScene: React.FC = () => {
  if (scene === 'agent') return <AgentScene />;
  if (scene === 'spec') return <SpecScene />;
  if (scene === 'policy') return <PolicyScene />;
  if (scene === 'network') return <NetworkScene />;
  if (scene === 'runtime') return <RuntimeScene />;
  return <TranscriptScene />;
};

const App: React.FC = () => {
  React.useEffect(() => {
    const ready = window.setTimeout(() => {
      window.__DEVRYAN_VISUAL_FIXTURE_READY__ = true;
      document.documentElement.dataset.fixtureReady = 'true';
    }, scene === 'spec' ? 250 : 100);
    return () => window.clearTimeout(ready);
  }, []);

  return (
    <RuntimeAPIProvider apis={runtimeApis}>
      <I18nProvider>
        <div className="fixture-shell" style={{ '--fixture-rail-width': `${railWidth}px` } as React.CSSProperties} data-scene={scene} data-state={fixtureState} data-role={role} data-drawer={drawer}>
          <FixtureHeader />
          <div className="fixture-grid">
            <main className="fixture-content"><MainScene /></main>
            <aside className="fixture-rail" aria-label="Bot operations fixture">
              <BotOperationsRail botId={BOT_ID} channelId={CHANNEL_ID} />
            </aside>
          </div>
        </div>
      </I18nProvider>
    </RuntimeAPIProvider>
  );
};

const root = document.getElementById('root');
if (!root) throw new Error('Visual fixture root is missing');
window.__DEVRYAN_VISUAL_FIXTURE_ROOT__ ||= createRoot(root);
window.__DEVRYAN_VISUAL_FIXTURE_ROOT__.render(<App />);
