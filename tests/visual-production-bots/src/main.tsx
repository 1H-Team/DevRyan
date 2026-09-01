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
import { BotRunFailureNotice } from '@/components/bots/chat/BotRunFailureNotice';
import { BotMessageList } from '@/components/bots/chat/BotMessageList';
import { BotMessageRow } from '@/components/bots/chat/BotMessageRow';
import { BotResultImage } from '@/components/bots/chat/BotResultAttachments';
import { BotBrowserDiagnostic } from '@/components/bots/operations/BotBrowserDiagnostic';
import { BotOperationsRail } from '@/components/bots/operations/BotOperationsRail';
import { BotAgentConnections } from '@/components/sections/bots/BotAgentConnections';
import { BotCoreIdentityEditor } from '@/components/sections/bots/BotCoreIdentityEditor';
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
  createBotsApi,
  type BotActionAttempt,
  type BotAgentConnection,
  type BotChannel,
  type BotComputerStatus,
  type BotComputerViewSession,
  type BotCredentialMetadata,
  type BotMessage,
  type BotModelOptions,
  type BotRevisionContract,
  type BotRevisionDetail,
  type BotRun,
  type BotSpecImportPreview,
  type BotSummary,
  type BotsApi,
} from '@/lib/botsApi';
import type { BotsDesktopApi, RuntimeServiceStatus } from '@/lib/botsDesktopApi';
import { I18nProvider } from '@/lib/i18n';
import { createBotChannelStore, useBotChannelStore } from '@/stores/useBotChannelStore';
import { useBotOperationsNavigationStore } from '@/stores/useBotOperationsNavigationStore';
import { createBotOperationsStore, useBotOperationsStore } from '@/stores/useBotOperationsStore';
import { useBotsStore } from '@/stores/useBotsStore';
import './fixture.css';
import { BotUpgradeScene } from './BotUpgradeScene';
import { BotTelegramScene } from './BotTelegramScene';
import { createWebAPIs } from '../../../packages/web/src/api';

declare global {
  interface Window {
    __DEVRYAN_VISUAL_FIXTURE_READY__?: boolean;
    __DEVRYAN_VISUAL_FIXTURE_ERRORS__?: string[];
    __DEVRYAN_VISUAL_HUMAN_INPUT_EVENT_COUNT__?: number;
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
const USER_MESSAGE_ID = 'd1000000-0000-4000-8000-000000000002';
const ACKNOWLEDGMENT_ID = 'd1000000-0000-4000-8000-000000000003';
const IMAGE_OBJECT_ID = 'e1000000-0000-4000-8000-000000000001';
const NOW = '2026-08-27T10:00:00.000Z';
const runtimeApis = createWebAPIs();
window.__DEVRYAN_VISUAL_HUMAN_INPUT_EVENT_COUNT__ = 0;
window.__DEVRYAN_VISUAL_SCREEN_STREAMS__ = { starts: 0, active: 0, stops: 0, maxActive: 0 };

const VISUAL_STREAM_PATH = '/__devryan_visual_bot_stream__';
const originalFetch = window.fetch.bind(window);
let visualJpegPromise: Promise<Uint8Array> | null = null;

const visualJpeg = (): Promise<Uint8Array> => {
  if (visualJpegPromise) return visualJpegPromise;
  visualJpegPromise = new Promise((resolveJpeg, rejectJpeg) => {
    const canvas = document.createElement('canvas');
    canvas.width = 1280;
    canvas.height = 720;
    const context = canvas.getContext('2d');
    if (!context) {
      rejectJpeg(new Error('Visual browser canvas is unavailable'));
      return;
    }
    context.fillStyle = '#f7f8fb';
    context.fillRect(0, 0, 1280, 720);
    context.fillStyle = '#172033';
    context.fillRect(0, 0, 1280, 68);
    context.fillStyle = '#ffffff';
    context.font = '600 25px system-ui';
    context.fillText('Release Console', 34, 43);
    context.fillStyle = '#e9edf5';
    context.fillRect(0, 68, 250, 652);
    context.fillStyle = '#34405a';
    context.font = '500 18px system-ui';
    context.fillText('Overview', 32, 124);
    context.fillText('Deployments', 32, 168);
    context.fillText('Audit trail', 32, 212);
    context.fillStyle = '#172033';
    context.font = '700 32px system-ui';
    context.fillText('Production deployment', 302, 138);
    context.fillStyle = '#5b6477';
    context.font = '400 18px system-ui';
    context.fillText('Interactive deterministic browser target', 302, 174);
    context.fillStyle = '#ffffff';
    context.strokeStyle = '#cbd2df';
    context.lineWidth = 2;
    context.fillRect(302, 222, 700, 62);
    context.strokeRect(302, 222, 700, 62);
    context.fillStyle = '#667085';
    context.font = '400 18px system-ui';
    context.fillText('Type a release note', 326, 261);
    context.fillStyle = '#2563eb';
    context.fillRect(302, 322, 220, 58);
    context.fillStyle = '#ffffff';
    context.font = '600 18px system-ui';
    context.fillText('Confirm deployment', 326, 358);
    context.fillStyle = '#15803d';
    context.beginPath();
    context.arc(326, 446, 9, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = '#34405a';
    context.font = '500 18px system-ui';
    context.fillText('Browser connected · viewport 1280 × 720', 350, 452);
    canvas.toBlob(async (blob) => {
      if (!blob) {
        rejectJpeg(new Error('Visual browser frame encoding failed'));
        return;
      }
      resolveJpeg(new Uint8Array(await blob.arrayBuffer()));
    }, 'image/jpeg', 0.9);
  });
  return visualJpegPromise;
};

window.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const pathname = new URL(url, window.location.href).pathname;
  if (!pathname.startsWith(VISUAL_STREAM_PATH)) {
    return originalFetch(input, init);
  }
  const jpeg = await visualJpeg();
  const encoder = new TextEncoder();
  const header = encoder.encode(
    '--devryan-visual\r\nContent-Type: image/jpeg\r\n'
    + `Content-Length: ${jpeg.byteLength}\r\n`
    + 'X-DevRyan-Width: 1280\r\nX-DevRyan-Height: 720\r\n'
    + 'X-DevRyan-Device-Scale-Factor: 1\r\nX-DevRyan-Captured-At: 1\r\n\r\n',
  );
  const frame = new Uint8Array(header.byteLength + jpeg.byteLength + 2);
  frame.set(header, 0);
  frame.set(jpeg, header.byteLength);
  frame.set([13, 10], header.byteLength + jpeg.byteLength);
  const counters = window.__DEVRYAN_VISUAL_SCREEN_STREAMS__;
  if (counters) { counters.starts += 1; counters.active += 1; counters.maxActive = Math.max(counters.maxActive, counters.active); }
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    if (counters) { counters.active -= 1; counters.stops += 1; }
  };
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(frame);
      const abort = () => { if (!finished) { finish(); controller.close(); } };
      if (init?.signal?.aborted) abort();
      else init?.signal?.addEventListener('abort', abort, { once: true });
    },
    cancel() { finish(); },
  }), {
    status: 200,
    headers: { 'Content-Type': 'multipart/x-mixed-replace; boundary=devryan-visual' },
  });
};

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

const overviewModelOptions: BotModelOptions = {
  available: true,
  providers: [
    {
      id: 'openai',
      name: 'OpenAI',
      available: true,
      authType: 'api',
      connections: [],
      models: [{
        id: 'gpt-5.6-sol',
        name: 'GPT-5.6 Sol',
        providerId: 'openai',
        available: true,
        variants: [
          { id: 'medium', name: 'Medium', available: true },
          { id: 'high', name: 'High', available: true },
        ],
        contextLimit: 128_000,
        reviewedEgressHosts: ['api.openai.com'],
        egressReviewed: true,
      }],
    },
    {
      id: 'anthropic',
      name: 'Anthropic',
      available: true,
      authType: 'api',
      connections: [],
      models: [{
        id: 'claude-opus',
        name: 'Claude Opus',
        providerId: 'anthropic',
        available: true,
        variants: [{ id: 'high', name: 'High', available: true }],
        contextLimit: 200_000,
        reviewedEgressHosts: ['api.anthropic.com'],
        egressReviewed: true,
      }],
    },
  ],
};

const overviewCredential: BotCredentialMetadata = {
  id: 'e0000000-0000-4000-8000-000000000002',
  provider: 'openai',
  label: 'Production OpenAI',
  kind: 'api_key',
  scope: 'team',
  maskedIdentifier: null,
  status: 'active',
  version: 1,
  createdAt: NOW,
  updatedAt: NOW,
  rotatedAt: null,
};

const overviewContract = withBotRevisionAgent(opencodeContract, {
  kind: 'opencode',
  models: {
    ...baseContract.models,
    primary: {
      ...baseContract.models.primary,
      credentialId: overviewCredential.id,
    },
  },
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

const visualView: BotComputerViewSession = {
  id: 'visual-view-01',
  botId: BOT_ID,
  channelId: CHANNEL_ID,
  streamUrl: `${VISUAL_STREAM_PATH}/visual-view-01`,
  startedAt: NOW,
};
const screenLeaseOwner = ['screen_owned', 'screen_wait_owned'].includes(fixtureState)
  ? USER_ID
  : ['screen_conflict', 'screen_wait_other'].includes(fixtureState)
    ? 'a0000000-0000-4000-8000-000000000099'
    : null;
const screenControl = screenLeaseOwner ? {
  leaseId: 'visual-control-01',
  actorId: screenLeaseOwner,
  actorType: 'admin' as const,
  takenAt: Date.now() - 2_000,
  expiresAt: Date.now() + 60_000,
} : null;
const screenStatus: BotComputerStatus = {
  botId: BOT_ID,
  browser: {
    running: true,
    healthy: true,
    lifecycleState: 'running',
    mode: 'headed_virtual',
    displayReady: true,
  },
  control: screenControl,
  screencast: {
    subscribers: fixtureState.startsWith('screen_live') || screenLeaseOwner ? 1 : 0,
    lastFrameAt: Date.now(),
    retainedFrames: 0,
  },
  framesRecorded: false,
  arbitraryWebsiteExactlyOnce: false,
};
const disconnectedError = Object.assign(new Error('Visual screen disconnected'), {
  code: 'network_error',
});
const screenApi = {
  getComputerStatus: async () => screenStatus,
  startComputerView: async () => {
    if (fixtureState === 'screen_connecting') return new Promise(() => undefined);
    if (fixtureState === 'screen_disconnected') throw disconnectedError;
    return { view: visualView };
  },
  stopComputerView: async () => ({ stopped: true }),
  takeComputerControl: async () => ({
    botId: BOT_ID,
    control: {
      leaseId: 'visual-control-01',
      actorId: USER_ID,
      actorType: 'admin' as const,
      takenAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    },
  }),
  heartbeatComputerControl: async () => ({ botId: BOT_ID, control: screenControl }),
  returnComputerControl: async () => ({ botId: BOT_ID, control: null }),
  sendHumanComputerCommand: async (
    _botId: string,
    request: Parameters<BotsApi['sendHumanComputerCommand']>[1],
  ) => {
    const eventCount = Array.isArray(request.args.events) ? request.args.events.length : 0;
    window.__DEVRYAN_VISUAL_HUMAN_INPUT_EVENT_COUNT__ =
      (window.__DEVRYAN_VISUAL_HUMAN_INPUT_EVENT_COUNT__ ?? 0) + eventCount;
    return { result: { dispatched: eventCount } };
  },
} as unknown as BotsApi;
const visualScreenStore = createBotOperationsStore({ api: screenApi });
visualScreenStore.getState().resetPrincipal(USER_ID);
visualScreenStore.getState().replaceSnapshot({
  runs: fixtureState.startsWith('screen_wait_') ? [{
    id: RUN_ID,
    botId: BOT_ID,
    channelId: CHANNEL_ID,
    revisionId: REVISION_ID,
    modelSnapshot: { adapter: 'ag_ui' },
    computerScopeKey: `bot:${BOT_ID}`,
    queueSequence: 4,
    state: 'waiting_control',
    retryable: false,
    interruptionKind: null,
    createdAt: NOW,
    updatedAt: NOW,
    startedAt: NOW,
    finishedAt: null,
  }] : [],
  recentActions: [],
  pendingApprovals: [],
  computers: [screenStatus],
});
if (scene === 'screen' && fixtureState !== 'screen_off') {
  void visualScreenStore.getState().startComputerView(BOT_ID, CHANNEL_ID).catch(() => undefined);
}

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
  lastMessageSequence: fixtureState === 'ack_result' ? 3 : 2,
  lastMessageAt: NOW,
  createdAt: NOW,
  updatedAt: NOW,
  archivedAt: null,
};

const runState: BotRun['state'] = fixtureState === 'reconciliation'
  ? 'needs_reconciliation'
  : fixtureState.startsWith('screen_wait_')
    ? 'waiting_control'
  : fixtureState === 'paused'
    ? 'interrupted'
    : fixtureState === 'ack_running'
      ? 'running'
      : fixtureState === 'ack_result'
        ? 'completed'
        : fixtureState.startsWith('image_')
          ? 'completed'
    : fixtureState === 'settled'
      ? 'completed'
      : fixtureState === 'failure' || fixtureState.startsWith('retry_') || fixtureState === 'timeout'
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
  retryable: fixtureState.startsWith('retry_'),
  interruptionKind: fixtureState === 'timeout' ? 'bot_run_timeout' : fixtureState === 'paused' ? 'desktop_host_unavailable' : null,
  createdAt: NOW,
  updatedAt: NOW,
  startedAt: NOW,
  finishedAt: ['settled', 'failure', 'paused', 'ack_result'].includes(fixtureState)
    || fixtureState.startsWith('image_') ? NOW : null,
};

const actionState: BotActionAttempt['state'] = fixtureState === 'reconciliation'
  ? 'needs_reconciliation'
  : fixtureState.startsWith('screen_wait_')
    ? 'waiting_control'
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
  sequence: 3,
  body: {
    text: fixtureState.startsWith('image_')
      ? 'Here is the generated release illustration.'
      : 'The release package is prepared. One governed browser submission is waiting for review.',
    attachmentIds: [],
  },
  attachmentCount: 0,
  createdAt: NOW,
  finalizedAt: NOW,
};

const loadVisualImage = async (signal: AbortSignal): Promise<Blob> => {
  if (fixtureState === 'image_loading') {
    return new Promise((_resolve, reject) => {
      signal.addEventListener(
        'abort',
        () => reject(new DOMException('Aborted', 'AbortError')),
        { once: true },
      );
    });
  }
  if (fixtureState === 'image_error') {
    return new Blob([new Uint8Array([0, 1, 2, 3])], { type: 'image/jpeg' });
  }
  return new Blob([await visualJpeg()], { type: 'image/jpeg' });
};

const userMessage: BotMessage = {
  id: USER_MESSAGE_ID,
  channelId: CHANNEL_ID,
  runId: RUN_ID,
  actorUserId: USER_ID,
  role: 'user',
  assistantPhase: null,
  sequence: 1,
  body: {
    text: 'Open the release dashboard and confirm whether production is ready.',
    attachmentIds: [],
  },
  attachmentCount: 0,
  createdAt: NOW,
  finalizedAt: NOW,
};

const acknowledgmentMessage: BotMessage = {
  id: ACKNOWLEDGMENT_ID,
  channelId: CHANNEL_ID,
  runId: RUN_ID,
  actorUserId: null,
  role: 'assistant',
  assistantPhase: 'acknowledgment',
  sequence: 2,
  body: {
    text: 'I’ll open the release dashboard and verify the production checks first.',
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
  if (fixtureState.startsWith('retry_')) {
    useBotChannelStore.getState().upsertMessage(userMessage);
    const retryStore = createBotChannelStore({ api: createBotsApi({ fetchImpl: async (_url, init) => (
      init?.method === 'POST'
        ? new Response(JSON.stringify({ error: 'Retry refused', code: 'bot_run_retry_unavailable',
          details: { retryReason: 'revision_changed' } }), { status: 409 })
        : new Response(JSON.stringify({ run }), { status: 200 })
    ) }) });
    retryStore.getState().resetPrincipal(USER_ID);
    retryStore.getState().replaceSnapshot({ channels: [channel] });
    retryStore.getState().upsertMessage(userMessage);
    useBotChannelStore.setState({ retryRun: retryStore.getState().retryRun });
  }

  if (fixtureState === 'ack_running' || fixtureState === 'ack_result') {
    useBotChannelStore.getState().upsertMessage(userMessage);
    useBotChannelStore.getState().upsertMessage(acknowledgmentMessage);
    if (fixtureState === 'ack_result') useBotChannelStore.getState().upsertMessage(message);
  } else if (fixtureState !== 'empty' && fixtureState !== 'loading') {
    useBotChannelStore.getState().upsertMessage(message);
  }
  const hasOperations = fixtureState !== 'empty' && fixtureState !== 'loading';
  const hasGovernedAction = hasOperations
    && fixtureState !== 'ack_running'
    && fixtureState !== 'ack_result'
    && !fixtureState.startsWith('retry_') && fixtureState !== 'timeout';
  useBotOperationsStore.getState().replaceSnapshot({
    runs: hasOperations ? [run] : [],
    recentActions: hasGovernedAction ? [action] : [],
    pendingApprovals: hasGovernedAction && action.state === 'pending_approval' ? [action] : [],
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
    if (hasGovernedAction && scene === 'transcript' && drawer === 'open') {
      useBotOperationsNavigationStore.getState().focusAction(BOT_ID, 'approvals', ACTION_ID);
    } else {
      useBotOperationsNavigationStore.getState().selectTab(BOT_ID, 'approvals');
    }
  } else {
    useBotOperationsNavigationStore.getState().selectTab(BOT_ID, 'approvals');
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

const OverviewScene: React.FC = () => {
  const [contract, setContract] = React.useState<BotRevisionContract>(overviewContract);
  const overviewWindowRef = React.useRef<HTMLDivElement>(null);
  const credentials = fixtureState === 'missing_credential' ? [] : [overviewCredential];
  React.useLayoutEffect(() => {
    const container = overviewWindowRef.current;
    if (!container) return;
    const providerLabel = Array.from(container.querySelectorAll('label')).find(
      (candidate) => candidate.querySelector('span')?.textContent?.trim() === 'Provider',
    );
    const target = providerLabel?.parentElement;
    if (!target) return;
    target.setAttribute('data-visual-focus-scope', 'true');
    const targetRect = target.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    container.scrollTop += targetRect.top - containerRect.top - 12;
  }, []);
  return (
    <div
      ref={overviewWindowRef}
      className="mx-auto max-h-[620px] max-w-4xl overflow-y-auto rounded-xl border border-border bg-background p-5"
      data-overview-window
    >
      <SectionTitle
        icon={RiGlobalLine}
        title="Bot identity and reasoning"
        detail="Provider, model, and Thinking stay aligned with the Bot's managed credentials."
      />
      <BotCoreIdentityEditor
        botName="Release Steward"
        value={contract}
        modelOptions={overviewModelOptions}
        credentials={credentials}
        readOnly={role === 'developer'}
        onChange={setContract}
        onNavigateCredentials={() => undefined}
      />
    </div>
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
    ) : fixtureState === 'ack_running' || fixtureState === 'ack_result' ? (
      <div className="h-[430px] overflow-hidden rounded-xl border border-border bg-[var(--surface-elevated)]">
        <BotMessageList
          bot={bot}
          channelId={CHANNEL_ID}
          typingRunId={fixtureState === 'ack_running' ? RUN_ID : null}
        />
      </div>
    ) : fixtureState.startsWith('retry_') || fixtureState === 'timeout' ? (
      <div className="rounded-xl border border-border bg-[var(--surface-elevated)] p-5">
        <BotMessageRow bot={bot} messageId={MESSAGE_ID} />
        <BotRunFailureNotice runId={RUN_ID} channelId={CHANNEL_ID} sourceHasAttachments={false} />
      </div>
    ) : fixtureState.startsWith('image_') ? (
      <div className="rounded-xl border border-border bg-[var(--surface-elevated)] p-5">
        <BotMessageRow bot={bot} messageId={MESSAGE_ID} />
        <BotResultImage image={{
          key: `visual:${IMAGE_OBJECT_ID}`,
          alt: 'Generated release illustration',
          expectedType: 'image/jpeg',
          load: loadVisualImage,
        }} />
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

const ScreenScene: React.FC = () => {
  const canControl = role === 'admin' && fixtureState !== 'screen_view_only';
  return (
    <div className="space-y-5">
      <SectionTitle
        icon={RiComputerLine}
        title="Live Bot browser"
        detail="Decoded frames and human input stay ephemeral while authorization and control leases remain enforced."
      />
      <div className="h-[560px] overflow-hidden rounded-xl border border-border bg-[var(--surface-elevated)]">
        <BotBrowserDiagnostic
          botId={BOT_ID}
          channelId={CHANNEL_ID}
          botActive
          principalId={USER_ID}
          canControl={canControl}
          active={fixtureState !== 'screen_off'}
          operationsStore={visualScreenStore}
        />
      </div>
    </div>
  );
};

const installUpgradeComputer = () => {
  useBotOperationsStore.setState(visualScreenStore.getState());
  return visualScreenStore.subscribe((state) => useBotOperationsStore.setState(state));
};

const MainScene: React.FC = () => {
  if (scene === 'telegram') return <BotTelegramScene />;
  if (scene === 'upgrade') return <BotUpgradeScene bot={bot} channel={channel} run={run} installComputer={installUpgradeComputer} />;
  if (scene === 'overview') return <OverviewScene />;
  if (scene === 'agent') return <AgentScene />;
  if (scene === 'spec') return <SpecScene />;
  if (scene === 'policy') return <PolicyScene />;
  if (scene === 'network') return <NetworkScene />;
  if (scene === 'runtime') return <RuntimeScene />;
  if (scene === 'screen') return <ScreenScene />;
  return <TranscriptScene />;
};

const App: React.FC = () => {
  React.useEffect(() => {
    const ready = window.setTimeout(() => {
      window.__DEVRYAN_VISUAL_FIXTURE_READY__ = true;
      document.documentElement.dataset.fixtureReady = 'true';
    }, scene === 'spec' || scene === 'screen' ? 350 : 100);
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

export { App };

const root = document.getElementById('root');
if (!root) throw new Error('Visual fixture root is missing');
window.__DEVRYAN_VISUAL_FIXTURE_ROOT__ ||= createRoot(root);
window.__DEVRYAN_VISUAL_FIXTURE_ROOT__.render(<App />);
