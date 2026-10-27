/**
 * Cache-safety tripwire — scans prompt-assembly source directories for
 * volatile-input patterns that silently invalidate provider prompt caches.
 *
 * Provider caches are exact byte-prefix matches over the rendered request.
 * A `Date.now()`, `new Date(...)`, `Math.random()`, or `randomUUID()` whose
 * value reaches the prompt prefix makes every request's prefix unique, so
 * nothing is ever served from cache — silently, with no error.
 *
 * When this test fails for a new file:
 *
 *   1. If the value can reach prompt content, keep it out of the stable
 *      prefix: route it through the trailing volatile zone via
 *      src/hooks/cache-safe-injection.ts, or drop it.
 *   2. If the value never feeds prompt content (timers, temp file names,
 *      internal bookkeeping), add an allowlist entry below with a
 *      justification that a reviewer can verify.
 *
 * The same scan covers the native runtime host and the managed orchestration
 * runtime, which assemble system prefixes, tool definitions and model-visible
 * tool replies outside this package (`runtime-host/...` and
 * `orchestration-runtime/...` allowlist keys).
 *
 * See docs/CACHE_EFFICIENCY.md (Verification and evidence limits).
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const SRC_ROOT = import.meta.dir;

/** Directories that participate in prompt/payload assembly. */
const SCAN_DIRS = ['hooks', 'agents', 'config'];

const REPO_ROOT = path.resolve(SRC_ROOT, '../../..');

/** Prompt- and payload-assembly roots outside agents-core, keyed by allowlist prefix. */
const EXTERNAL_SCAN_ROOTS = new Map<string, string>([
  ['runtime-host', path.join(REPO_ROOT, 'packages/web/server/lib/opencode/runtime-host')],
  ['orchestration-runtime', path.join(REPO_ROOT, 'packages/orchestration-runtime')],
]);

const isScannedSource = (file: string) => !/\.test\.|\.d\.ts$/.test(file)
  && !file.split('/').some((part) => part === 'node_modules' || part.endsWith('fixtures'));

const VOLATILE_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: 'Date.now()', regex: /\bDate\.now\(/ },
  { name: 'new Date(...)', regex: /\bnew Date\(/ },
  { name: 'Math.random()', regex: /\bMath\.random\(/ },
  { name: 'randomUUID()', regex: /\brandomUUID\b/ },
  { name: 'randomBytes(...)', regex: /\brandomBytes\(/ },
  { name: 'performance.now()', regex: /\bperformance\.now\(/ },
];

/**
 * Files allowed to use volatile inputs, each with a reviewer-verifiable
 * reason why the value can never reach the prompt prefix. Adding an entry
 * is a code-review decision, not a formality.
 */
const ALLOWLIST = new Map<string, string>([
  [
    'hooks/loop-command/index.ts',
    'Timestamps/randomness name per-run loop-history directories; the path only appears inside a newly appended user turn (payload tail), never in earlier prefix bytes.',
  ],
  [
    'hooks/foreground-fallback/index.ts',
    'Date.now() gates retry/dedup windows for model failover; no prompt content is derived from it.',
  ],
  [
    'hooks/task-session-manager/board-injection.ts',
    'randomBytes(4) names each process instance of checkpoint board snapshot ids (#1368): the epoch is restart-scoped identity metadata on injected message ids. snapshotID metadata is dropped by the host converter and never reaches provider bytes (pinned by board-injection-cache-safety.test.ts); board text itself is deterministic.',
  ],
  [
    'hooks/task-session-manager/revived-run-tracker.ts',
    'Date.now() captures immutable observation-attempt boundaries for terminal attribution; these timestamps are never serialized into notification prompts.',
  ],
  ...externalAllowlist(),
]);

/**
 * Native runtime and managed orchestration entries. None of these values is
 * written into a system prefix, tool definition or earlier transcript bytes.
 */
function externalAllowlist(): Array<[string, string]> {
  const rpc = 'randomUUID()/randomBytes() mint per-call RPC/IPC correlation IDs, permits or bearer tokens; they travel in host messages and are never written into prompt, system or tool-definition text.';
  const timing = 'Date.now()/performance.now() bound deadlines, throttles or elapsed-time diagnostics; no prompt, system or tool-definition text is derived from them.';
  const temporary = 'Random suffixes name temporary, stale or aside paths on disk that are renamed or removed; the names never reach model-visible text.';
  const replyDeadline = 'Date.now() sets the managed task timeoutAt deadline on the scheduler record; it can appear only in a tool reply appended after the cached prefix, never in system or tool-definition text.';
  const entries: Array<[string, string, string]> = [
    ['runtime-host', 'bundle-checkpoint.js', 'randomUUID()/Date.now() identify and timestamp a bundle checkpoint record used for startup recovery; never model-visible.'],
    ['runtime-host', 'controller-images.ts', rpc],
    ['runtime-host', 'controller-integrations.ts', 'randomUUID() identifies an in-process integration acquisition for teardown bookkeeping; never model-visible.'],
    ['runtime-host', 'controller-interview.ts', rpc],
    ['runtime-host', 'controller-providers.ts', 'randomUUID() names a per-attempt transport requestID for Meridian attribution; it is attempt metadata, not request body or prompt text.'],
    ['runtime-host', 'controller-slim.ts', 'randomUUID() keys a private task-board presentation round trip; placeholders are mapped back to the original parts before anything reaches the provider.'],
    ['runtime-host', 'controller-webfetch.ts', 'Date.now() stamps time.created/updated on a synthetic message info record; message info timestamps are not rendered into provider request text.'],
    ['runtime-host', 'council-owner.js', replyDeadline],
    ['runtime-host', 'credential-mutation-bridge.ts', rpc],
    ['runtime-host', 'execution-routing.ts', 'randomUUID() mints a shell execution ticket passed through the child environment for ownership checks; never model-visible.'],
    ['runtime-host', 'managed-task-owner.js', replyDeadline],
    ['runtime-host', 'native-admission-owner.js', `${rpc} ${timing}`],
    ['runtime-host', 'native-artifacts.js', timing],
    ['runtime-host', 'native-bundle-credential-process.js', rpc],
    ['runtime-host', 'native-bundle-reboot-recovery.js', 'randomUUID() names a reboot-recovery fence for the bundle ledger; never model-visible.'],
    ['runtime-host', 'native-bundle-startup-upgrade.js', `${temporary} ${timing}`],
    ['runtime-host', 'native-claude-enrollment.js', 'randomUUID()/randomBytes() create enrollment profile IDs and OAuth PKCE verifier/state values; Date.now() sets the enrollment deadline. None reaches prompt text.'],
    ['runtime-host', 'native-claude-inspection.js', 'Date.now() stamps usageUpdatedAt on a provider usage result shown in settings; never model-visible.'],
    ['runtime-host', 'native-claude-transport-channel.ts', rpc],
    ['runtime-host', 'native-claude-transport-host.js', `${rpc} Date.now() only checks credential expiry.`],
    ['runtime-host', 'native-context-assets.js', 'randomUUID() names the job handle; the captured contextAssetID only feeds the execution-ledger callID digest and is not part of the returned messages.'],
    ['runtime-host', 'native-cursor-owner.js', `${rpc} ${timing}`],
    ['runtime-host', 'native-default-bundle.js', temporary],
    ['runtime-host', 'native-document-plugin.ts', rpc],
    ['runtime-host', 'native-harness-relocation.js', `${temporary} randomBytes() also mints a relocation nonce for the host request.`],
    ['runtime-host', 'native-helper-owner.js', `${rpc} ${timing}`],
    ['runtime-host', 'native-image-runtime.js', timing],
    ['runtime-host', 'native-integration-authorization.js', rpc],
    ['runtime-host', 'native-interview-document.js', 'randomUUID() names the execution-ledger callID and job handle of the document worker; the published document content is deterministic and never carries them.'],
    ['runtime-host', 'native-meridian-worker.ts', `${rpc} Date.now() only checks credential expiry.`],
    ['runtime-host', 'native-migration-files.js', temporary],
    ['runtime-host', 'native-migration-process.js', 'randomUUID()/randomBytes() name the migration process instance; never model-visible.'],
    ['runtime-host', 'native-observation.ts', `randomUUID() correlates observation records. ${timing}`],
    ['runtime-host', 'native-process.js', `${rpc} ${timing}`],
    ['runtime-host', 'native-provider-configuration-operation.js', temporary],
    ['runtime-host', 'native-provider-process.js', rpc],
    ['runtime-host', 'native-provider-runtime-owner.js', `${rpc} Date.now() only checks credential expiry.`],
    ['runtime-host', 'native-provider-timing.js', timing],
    ['runtime-host', 'native-runtime-owner.js', `${rpc} ${timing}`],
    ['runtime-host', 'native-session-context-owner.js', 'Date.now()/randomBytes() mint an ascending OpenCode message ID for an appended continuation turn; message IDs are not provider request text and the turn is in the payload tail.'],
    ['runtime-host', 'native-setup-local-owners.js', temporary],
    ['runtime-host', 'native-setup-source.js', temporary],
    ['runtime-host', 'native-slim-context-owner.js', timing],
    ['runtime-host', 'native-stream-continuation.ts', timing],
    ['runtime-host', 'remote-mcp.ts', 'randomUUID() identifies a remote MCP catalog acquisition for binding checks; tool definitions are digested without it.'],
    ['runtime-host', 'retained-native-artifacts.js', `${temporary} Date.now()/new Date() stamp retention markers and mtimes.`],
    ['runtime-host', 'writer-worker.ts', rpc],
    ['orchestration-runtime', 'persistence.js', 'Date.now() is the default clock for durable record timestamps; record times are never rendered into system or tool-definition text.'],
    ['orchestration-runtime', 'scheduler.js', 'randomUUID() (Date.now()/Math.random() fallback) mints managed task IDs, which appear only in tool replies after the cached prefix; performance.now() measures mutation timing diagnostics.'],
    ['orchestration-runtime', 'transport-recovery.js', 'randomUUID() suffixes an ascending recovery message ID; message IDs are not provider request text.'],
    ['orchestration-runtime', 'xai-tool-catalog.js', 'Date.now() is the default cache-age clock; catalog content and tool order do not depend on it.'],
  ];
  return entries.map(([root, file, reason]) => [`${root}/${file}`, reason]);
}

async function scanForViolations(): Promise<string[]> {
  const violations: string[] = [];
  const glob = new Bun.Glob('**/*.ts');

  for (const dir of SCAN_DIRS) {
    const root = path.join(SRC_ROOT, dir);
    for await (const file of glob.scan(root)) {
      if (file.endsWith('.test.ts')) continue;
      const relative = `${dir}/${file}`;
      if (ALLOWLIST.has(relative)) continue;

      const content = readFileSync(path.join(root, file), 'utf8');
      for (const pattern of VOLATILE_PATTERNS) {
        if (pattern.regex.test(content)) {
          violations.push(`${relative} uses ${pattern.name}`);
        }
      }
    }
  }

  const sourceGlob = new Bun.Glob('**/*.{ts,js,mjs}');
  for (const [prefix, root] of EXTERNAL_SCAN_ROOTS) {
    for await (const file of sourceGlob.scan(root)) {
      if (!isScannedSource(file)) continue;
      const relative = `${prefix}/${file}`;
      if (ALLOWLIST.has(relative)) continue;

      const content = readFileSync(path.join(root, file), 'utf8');
      for (const pattern of VOLATILE_PATTERNS) {
        if (pattern.regex.test(content)) {
          violations.push(`${relative} uses ${pattern.name}`);
        }
      }
    }
  }

  return violations;
}

function resolveAllowlisted(relative: string): string {
  const [prefix, ...rest] = relative.split('/');
  const root = EXTERNAL_SCAN_ROOTS.get(prefix ?? '');
  return root ? path.join(root, ...rest) : path.join(SRC_ROOT, relative);
}

describe('cache-safety tripwire', () => {
  test('prompt-assembly code introduces no unreviewed volatile inputs', async () => {
    const violations = await scanForViolations();

    if (violations.length > 0) {
      throw new Error(
        [
          'Volatile input detected in prompt-assembly code. If its value can',
          'reach the prompt, it will silently bust the provider cache on',
          'every request — keep it in the volatile tail via',
          'src/hooks/cache-safe-injection.ts, or add a justified allowlist',
          'entry in src/cache-safety-tripwire.test.ts (see file header).',
          '',
          ...violations,
        ].join('\n'),
      );
    }
  });

  test('allowlist contains no stale entries', async () => {
    const stale: string[] = [];

    for (const [relative] of ALLOWLIST) {
      const absolute = resolveAllowlisted(relative);
      let content: string;
      try {
        content = readFileSync(absolute, 'utf8');
      } catch {
        stale.push(`${relative} (file no longer exists)`);
        continue;
      }
      const stillMatches = VOLATILE_PATTERNS.some((pattern) =>
        pattern.regex.test(content),
      );
      if (!stillMatches) {
        stale.push(`${relative} (no volatile patterns remain)`);
      }
    }

    expect(stale).toEqual([]);
  });
});
