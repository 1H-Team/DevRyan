// DevRyan-owned authority seams. Upstream Slim reads files, the network,
// processes and process-wide configuration directly; inside DevRyan every such
// access is lent per location or per invocation by the native host, and the
// code fails closed when no owner is bound.
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';

const fail = (code: string): never => {
  throw new Error(code);
};
const isAbsoluteDirectory = (value: unknown): value is string =>
  typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0');

// ---------------------------------------------------------------------------
// Host binding: the v1 hook factory, log sink and interview bridge per location.

// Method syntax: the bridge is created by createReviewedSlimInterviewBridge
// and only passed through the host, which never narrows its v2 payloads.
export interface ReviewedSlimInterviewBridge {
  registerCommand(draft: unknown): void;
  handleContext(event: unknown): Promise<void>;
  handleEvent(event: unknown): Promise<void>;
  dispose(): Promise<void>;
}

export interface ReviewedSlimHostBinding {
  readonly directory: string;
  readonly requiredHooks: readonly string[];
  readonly hooks: (input: unknown) => Promise<Record<string, unknown>>;
  readonly log: (entry: string) => void;
  readonly interviewBridge: ReviewedSlimInterviewBridge;
}

const hosts = new Map<string, ReviewedSlimHostBinding>();

export function bindReviewedSlimHost(input: ReviewedSlimHostBinding): () => void {
  if (
    !input ||
    !isAbsoluteDirectory(input.directory) ||
    typeof input.hooks !== 'function' ||
    typeof input.log !== 'function' ||
    !Array.isArray(input.requiredHooks) ||
    input.requiredHooks.some((name) => typeof name !== 'string') ||
    !input.interviewBridge ||
    (['registerCommand', 'handleContext', 'handleEvent', 'dispose'] as const).some(
      (name) => typeof input.interviewBridge[name] !== 'function',
    )
  )
    fail('reviewed_slim_host_invalid');
  if (hosts.has(input.directory)) fail('reviewed_slim_host_duplicate');
  const saved = Object.freeze({ ...input, requiredHooks: Object.freeze([...input.requiredHooks]) });
  hosts.set(input.directory, saved);
  return () => {
    if (hosts.get(input.directory) === saved) hosts.delete(input.directory);
  };
}

export function requireReviewedSlimHost(directory: string): ReviewedSlimHostBinding {
  return hosts.get(directory) ?? fail('reviewed_slim_host_unbound');
}

export function assertReviewedSlimHooks(directory: string, hooks: unknown): void {
  const required = requireReviewedSlimHost(directory).requiredHooks;
  if (
    !hooks ||
    typeof hooks !== 'object' ||
    required.some(
      (name) => !Object.hasOwn(hooks, name) || (hooks as Record<string, unknown>)[name] === undefined,
    )
  )
    fail('reviewed_slim_hook_missing');
}

/** Every bound host receives each (already redacted) log entry once. */
export function reviewedSlimLogSinks(): Set<(entry: string) => void> {
  return new Set([...hosts.values()].map((host) => host.log));
}

// ---------------------------------------------------------------------------
// Frozen per-location configuration: the host resolves it once from the saved
// settings; Slim never reads configuration files or the environment itself.

export interface ReviewedSlimConfiguration {
  readonly directory: string;
  readonly configuration: Record<string, unknown>;
  readonly userConfigPath?: string;
  readonly projectConfigPath?: string;
  readonly activePreset?: string;
}

const configurations = new Map<string, ReviewedSlimConfiguration>();

export function bindReviewedSlimConfiguration(input: ReviewedSlimConfiguration): () => void {
  if (
    !input ||
    !isAbsoluteDirectory(input.directory) ||
    !input.configuration ||
    typeof input.configuration !== 'object' ||
    Array.isArray(input.configuration)
  )
    fail('reviewed_slim_configuration_invalid');
  if (configurations.has(input.directory)) fail('reviewed_slim_configuration_duplicate');
  const saved = structuredClone(input);
  configurations.set(input.directory, saved);
  return () => {
    if (configurations.get(input.directory) === saved) configurations.delete(input.directory);
  };
}

export function requireReviewedSlimConfiguration(directory: string): ReviewedSlimConfiguration {
  return configurations.get(directory) ?? fail('reviewed_slim_configuration_unbound');
}

// ---------------------------------------------------------------------------
// Agent prompts captured by the host snapshot (replaces prompt file lookup).

export interface CapturedAgentPrompt {
  readonly prompt?: string;
  readonly appendPrompt?: string;
}
export const reviewedSlimAgentData = new AsyncLocalStorage<{
  readonly prompts: Readonly<Record<string, CapturedAgentPrompt>>;
}>();

// ---------------------------------------------------------------------------
// Invocation-local filesystem owner for the path rescue/patch/search hooks.

export interface ReviewedSlimPathOwner {
  readonly stat: (file: string) => Promise<{ isFile(): boolean }>;
  readonly realpath: (file: string) => Promise<string>;
  readonly readText: (file: string) => Promise<string>;
}

const pathOwners = new AsyncLocalStorage<ReviewedSlimPathOwner>();

export function withReviewedSlimPathOwner<T>(owner: ReviewedSlimPathOwner, action: () => Promise<T>): Promise<T> {
  if (!owner || (['stat', 'realpath', 'readText'] as const).some((name) => typeof owner[name] !== 'function'))
    fail('reviewed_slim_path_owner_required');
  return pathOwners.run(owner, action);
}

export function requireReviewedSlimPathOwner(): ReviewedSlimPathOwner {
  return pathOwners.getStore() ?? testOwners?.path ?? fail('reviewed_slim_path_owner_required');
}

// ---------------------------------------------------------------------------
// Invocation-local web fetch authority (network, cache, DOM, binaries, model).

export interface ReviewedWebfetchOwners {
  readonly sessionID: string;
  readonly signal: AbortSignal;
  /** Opaque handle from createReviewedWebfetchCache (checked on use). */
  readonly cache: object;
  readonly fetch: (
    url: string,
    init: {
      readonly redirect: 'manual';
      readonly signal: AbortSignal;
      readonly headers: Readonly<Record<string, string>>;
    },
  ) => Promise<Response>;
  readonly loadJSDOM: () => Promise<unknown>;
  readonly saveBinary: (request: {
    readonly directory: string;
    readonly data: Uint8Array;
    readonly contentType: string;
    readonly filename?: string;
  }) => Promise<string>;
  /** Must abort and settle its owned provider work before returning after cancellation. */
  readonly secondary: (request: {
    readonly sessionID: string;
    readonly model: { readonly providerID: string; readonly modelID: string; readonly variant?: string };
    readonly prompt: string;
    readonly signal: AbortSignal;
  }) => Promise<string>;
}

const webfetchOwners = new AsyncLocalStorage<ReviewedWebfetchOwners>();

export function withReviewedWebfetchOwner<T>(owner: ReviewedWebfetchOwners, action: () => Promise<T>): Promise<T> {
  return webfetchOwners.run(owner, action);
}

export function requireReviewedWebfetchOwner(): ReviewedWebfetchOwners {
  return webfetchOwners.getStore() ?? testOwners?.webfetch ?? fail('reviewed_webfetch_owner_required');
}

// ---------------------------------------------------------------------------
// The manifest-verified ast-grep executable (never downloaded or searched for).

let astGrepAssetPath: string | null = null;

export function bindReviewedAstGrepAsset(absolutePath: string): void {
  if (!isAbsoluteDirectory(absolutePath)) fail('reviewed_ast_asset_invalid');
  if (astGrepAssetPath !== null && astGrepAssetPath !== absolutePath) fail('reviewed_ast_asset_rebinding');
  astGrepAssetPath = absolutePath;
}

export function requireReviewedAstGrepAsset(): string {
  return astGrepAssetPath ?? fail('reviewed_ast_asset_unbound');
}

// ---------------------------------------------------------------------------
// The confined image worker: its process cwd is the private workspace view.

let imageWorkerDirectory: string | undefined;

export function bindReviewedSlimImageWorker(directory: string): void {
  if (
    !isAbsoluteDirectory(directory) ||
    path.resolve(directory) !== directory ||
    path.resolve(process.cwd()) !== directory
  )
    fail('reviewed_slim_image_worker_invalid');
  if (imageWorkerDirectory && imageWorkerDirectory !== directory) fail('reviewed_slim_image_worker_rebinding');
  imageWorkerDirectory = directory;
}

export function requireReviewedSlimImageWorker(directory?: string): string {
  if (
    !imageWorkerDirectory ||
    (directory !== undefined && directory !== imageWorkerDirectory) ||
    path.resolve(process.cwd()) !== imageWorkerDirectory
  )
    fail('reviewed_slim_image_worker_required');
  return imageWorkerDirectory as string;
}

// ---------------------------------------------------------------------------
// Test support only: the package test preload installs default owners so the
// upstream algorithm tests run against the real filesystem and fetch. The
// DevRyan host never calls this; without it every access fails closed.

let testOwners:
  | { readonly path: ReviewedSlimPathOwner; readonly webfetch: ReviewedWebfetchOwners }
  | undefined;

export function installReviewedSlimTestOwners(owners: {
  readonly path: ReviewedSlimPathOwner;
  readonly webfetch: ReviewedWebfetchOwners;
}): void {
  testOwners = owners;
}
