import type { Express } from "express";
import type { Server } from "http";

export interface WebUiServerController {
  expressApp: Express;
  httpServer: Server;
  getPort: () => number | null;
  getOpenCodePort: () => number | null;
  getManagedOrchestrationDiagnostics: () => unknown;
  getBrowserLeaseDiagnostics: () => { activeLeases: number };
  getQuitRiskStatus: () => WebUiServerQuitRiskStatus;
  isReady: () => boolean;
  restartOpenCode: () => Promise<void>;
  stop: (options?: { exitProcess?: boolean }) => Promise<void>;
}

export interface ScheduledTasksStatus {
  hasEnabledScheduledTasks: boolean;
  hasPendingScheduledTasks: boolean;
  hasRunningScheduledTasks: boolean;
  enabledScheduledTasksCount: number;
  pendingScheduledTasksCount: number;
  runningScheduledTasksCount: number;
}

export interface WebUiServerQuitRiskStatus {
  tunnel: { active: boolean };
  scheduledTasks: ScheduledTasksStatus;
}

export interface BrowserLeaseMetadata {
  rootSessionId: string;
  opencodeSessionID: string;
  messageID: string;
  directory: string;
  agent: string | null;
}

export interface ManagedBrowserEnvironment {
  DEVRYAN_BROWSER_CDP_DISCOVERY_URL?: string;
  DEVRYAN_BROWSER_CDP_TOKEN?: string;
  DEVRYAN_AGENT_BROWSER_BIN?: string;
}

export interface BrowserLeaseAvailability {
  state?: string;
  available?: boolean;
}

export interface BotRuntimeStatus {
  ok: boolean;
  state: string;
  code: string | null;
  issues: Array<{ code: string; message: string }>;
  canSetup?: boolean;
  canRepair?: boolean;
  canUpdate?: boolean;
  canRollback?: boolean;
  indexState?: string | null;
}

export interface BotIndexerRequest {
  operation: "status" | "upsert" | "delete" | "search" | "rebuild";
  body?: Record<string, unknown>;
}

export interface StartWebUiServerOptions {
  port?: number;
  host?: string;
  attachSignals?: boolean;
  exitOnShutdown?: boolean;
  uiPassword?: string | null;
  getIsWindowFocused?: () => boolean;
  getBrowserCdpDiscoveryToken?: () => string;
  getBrowserCdpBridgeStatus?: () => BrowserLeaseAvailability | Promise<BrowserLeaseAvailability>;
  getBrowserLeaseAvailability?: () => boolean | BrowserLeaseAvailability | Promise<boolean | BrowserLeaseAvailability>;
  createBrowserLease?: (input: {
    leaseId: string;
    metadata: BrowserLeaseMetadata;
    onClosed: (reason?: string) => void;
  }) => Promise<{ wsUrl: string }>;
  touchBrowserLease?: (input: {
    leaseId: string;
    metadata?: BrowserLeaseMetadata;
  }) => Promise<unknown>;
  releaseBrowserLease?: (input: {
    leaseId: string;
    reason: string;
  }) => Promise<unknown>;
  getBotEncryptionKey?: () => Uint8Array | Promise<Uint8Array>;
  getBotRuntimeStatus?: () => BotRuntimeStatus | Promise<BotRuntimeStatus>;
  ensureBotReasoningRuntime?: (input: Record<string, unknown>) => Promise<unknown>;
  ensureBotComputerRuntime?: (input: Record<string, unknown>) => Promise<unknown>;
  inspectBotRuntimeResource?: (input: Record<string, unknown>) => Promise<unknown>;
  stopBotRuntimeResource?: (input: Record<string, unknown>) => Promise<unknown>;
  requestBotIndexer?: (input: BotIndexerRequest) => Promise<Record<string, unknown>>;
  getManagedBrowserEnvironment?: () => ManagedBrowserEnvironment | Promise<ManagedBrowserEnvironment>;
}

export declare function startWebUiServer(
  options?: StartWebUiServerOptions
): Promise<WebUiServerController>;

export declare function gracefulShutdown(options?: { exitProcess?: boolean }): Promise<void>;
export declare function setupProxy(app: Express): void;
export declare function restartOpenCode(): Promise<void>;
export declare function parseArgs(argv?: string[]): {
  port: number;
  host?: string;
  uiPassword: string | null;
  tryCfTunnel: boolean;
  tunnelProvider?: string;
  tunnelMode?: string;
  tunnelConfigPath?: string | null;
  tunnelToken?: string;
  tunnelHostname?: string;
};
