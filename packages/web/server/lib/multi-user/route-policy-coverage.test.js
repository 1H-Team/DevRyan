// Route-policy coverage: no HTTP route can be added without someone deciding
// who may call it.
//
// Managed (multi-user, non-administrator) requests are authorized by
// authorizeManagedRequest in runtime.js, which classifies the request path
// with regular expressions. A path that no expression mentions passes the
// gate (see "passes an /api path that no policy rule mentions" below), so a
// new route under an unlisted prefix would be open to every managed user and
// nothing would notice. This test enumerates every route and path mount the
// main server registers, from the real registrars (test-route-registry.js),
// sends each one through the real gate as a signed-in managed developer and
// senior developer, and requires every entry to sit in one named class below
// whose expected decision (and, for a refusal, reason) matches the gate today.
//
// When this test fails:
// - "matches no class": a new route or mount. Decide who may call it, make
//   the policy (or the handler) enforce that, and add it to the class that
//   says so.
// - "decision differs": the policy changed for an entry. If intended, move it
//   to the class that now describes it.
// - "rule matches no entry": an entry was removed or renamed; drop or fix
//   the rule so the table stays true.
// - "not reached by the enumeration": a registration call site the registry
//   does not run. Mirror its registrar in test-route-registry.js, or list it
//   under NOT_ON_MAIN_SERVER / NOT_REACHED_HERE with the reason.
// - "registration order differs": application.js or the startup pipeline now
//   calls its registrars in another order (for example one moved ahead of the
//   policy gate). Mirror the new order in test-route-registry.js.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createMultiUserRuntime } from './runtime.js';
import {
  createManagedPolicyHarness,
  enumerateServerRoutes,
  probeManagedDecision,
} from './test-route-registry.js';

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ROLES = ['developer', 'senior_developer'];

// Decisions, per signed-in managed role with its default policy and one
// assigned project:
// - OUTSIDE: the path is not under /api, so the policy gate is not mounted
//   there; the handler authenticates (or the route is public).
// - PRE_GATE: an /api entry registered before the gate; it authenticates
//   itself (private capability token, loopback administrator, ...).
// - ALLOW: the gate passes the request on.
// - deny(reason): the gate refuses with 403 and a reason matching `reason`.
const OUTSIDE = 'outside-api';
const PRE_GATE = 'pre-gate';
const ALLOW = 'allow';
const deny = (reason, status = 403) => ({ decision: 'deny', status, reason });
const ADMIN_REQUIRED = deny(/^(?:Administrator access required|Host configuration is restricted to administrators)$/);
const SETTINGS_PAGE = deny(/^(?:Read|Edit) access to [a-z.-]+ settings is disabled by policy$/);
const NO_FILES = deny(/^File access is disabled by policy$/);
const NO_TERMINAL = deny(/^Terminal access is disabled by policy$/);
const GIT_RESTRICTED = deny(/^Git operation is not allowed by policy$/);
const NO_BRANCH_CREATION = deny(/^Branch creation is disabled by policy$/);
const NO_WORKTREE_CREATION = deny(/^Worktree creation is disabled by policy$/);
const GITHUB_ACCOUNTS = deny(/^(?:(?:Read|Edit) access to users settings is disabled by policy|GitHub account management is restricted to administrators)$/);

// Rules are 'METHOD /path'. METHOD '*' is any method, USE is a path mount
// (app.use / router.use with a path); a path ending in '/**' covers the prefix
// and everything below it. Rules are tried in class order and the first match
// wins, so narrower classes come first. `expect` is one decision for every
// role or an object with one per role.
const CLASSES = [
  {
    name: 'unauthenticated or self-authenticating, outside /api',
    expect: OUTSIDE,
    rules: [
      'GET /robots.txt',
      'GET /manifest.webmanifest',
      'GET /health',
      // Handler authorizes the SSH-managed shutdown token.
      'POST /health/ssh-shutdown',
      'GET /connect',
      'GET /invite',
      'GET /tunnel/connect',
      // Sign-in, sign-out, invitations, passkeys and loopback bootstraps.
      '* /auth/**',
      // SPA fallback for every non-/api, non-asset path.
      'GET regex:^(?!\\/api|.*\\.(js|css|svg|png|jpg|jpeg|gif|ico|woff|woff2|ttf|eot|map)).*$',
    ],
  },
  {
    name: 'own authentication, registered before the gate',
    expect: PRE_GATE,
    rules: [
      'GET /api/health',
      // Server status and shutdown: authorizeSystemRequest (administrator).
      '* /api/system/**',
      // Desktop/runtime-service capabilities: private capability token.
      '* /api/runtime-service/**',
      '* /api/desktop/**',
      // Loopback-administrator passkeys and the legacy reset.
      '* /api/passkeys/**',
      'POST /api/auth/reset',
    ],
  },
  {
    name: 'administrator only (gate refuses)',
    expect: ADMIN_REQUIRED,
    rules: [
      '* /api/diagnostics/**',
      '* /api/evidence/**',
      '* /api/config/apply/**',
      'GET /api/config/apply-status',
      'POST /api/config/reload',
      '* /api/config/packaged-agent-prompts/**',
      'POST /api/config/legacy-cursor-plugin/retire',
      'POST /api/browser/agent-leases/:leaseId/views',
      'DELETE /api/browser/agent-leases/:leaseId/views/:viewId',
      'POST /api/provider/cursor-acp/session-prewarm',
      'POST /api/provider/cursor-acp/workspace',
    ],
  },
  {
    // Senior developers can read the Users page; the handlers then require
    // canReviewUsers or an administrator (runtime.js).
    name: 'user review reads (Users page: senior developer only)',
    expect: { developer: SETTINGS_PAGE, senior_developer: ALLOW },
    rules: ['GET /api/admin/**'],
  },
  {
    name: 'settings-page gated (gate refuses without the page)',
    expect: SETTINGS_PAGE,
    rules: [
      '* /api/admin/**',
      // The OpenAI OAuth mount also requires local transport and an administrator.
      'USE /api/provider/openai/oauth',
      '* /api/behavior/**',
      '* /api/config/agent-overrides',
      '* /api/config/agents/:name/**',
      '* /api/config/commands/**',
      '* /api/config/mcp/**',
      '* /api/mcp/**',
      '* /api/config/plugins',
      '* /api/config/skills/**',
      '* /api/config/settings/agent-defaults/:agentName',
      'GET /api/config/opencode-resolution',
      'GET /api/config/opencode-update-check',
      'GET /api/devryan/update-check',
      'POST /api/devryan/update-install',
      '* /api/devryan/tunnel/**',
      '* /api/provider/**',
      '* /api/auth/:providerID',
      '* /api/auth/:providerId',
      '* /api/credential/**',
      '* /api/quota/credentials/**',
      'PUT /api/projects/:projectId/icon',
      'DELETE /api/projects/:projectId/icon',
      'POST /api/projects/:projectId/icon/discover',
      'GET /api/git/discover-credentials',
      'GET /api/git/global-identity',
      '* /api/git/identities/**',
      'POST /api/git/set-identity',
      'PUT /api/magic-prompts/:id',
      'DELETE /api/magic-prompts/**',
    ],
  },
  {
    name: 'GitHub account management (gate refuses)',
    expect: GITHUB_ACCOUNTS,
    rules: [
      '* /api/github/auth',
      'POST /api/github/auth/activate',
      'POST /api/github/auth/complete',
      'POST /api/github/auth/gh-cli',
      'POST /api/github/auth/start',
    ],
  },
  {
    name: 'host files (files capability, off for both roles)',
    expect: NO_FILES,
    rules: ['* /api/fs/**', '* /api/file/**', '* /api/find/**'],
  },
  {
    name: 'host terminal (terminal capability: senior developer only)',
    expect: { developer: NO_TERMINAL, senior_developer: ALLOW },
    rules: ['* /api/terminal/**'],
  },
  {
    name: 'branch and worktree creation (senior developer only)',
    expect: {
      developer: { 'POST /api/git/branches': NO_BRANCH_CREATION, default: NO_WORKTREE_CREATION },
      senior_developer: ALLOW,
    },
    rules: [
      'POST /api/git/branches',
      'POST /api/git/worktrees',
      'POST /api/git/worktrees/operations/:operationId/retry',
    ],
  },
  {
    name: 'restricted Git (restrictedGitRoute, administrators only)',
    expect: GIT_RESTRICTED,
    rules: [
      'DELETE /api/git/branches',
      'PUT /api/git/branches/rename',
      'POST /api/git/canonicalize-worktree-state',
      'GET /api/git/current-identity',
      'GET /api/git/has-local-identity',
      'DELETE /api/git/remote-branches',
      'DELETE /api/git/remotes',
      '* /api/git/stash/**',
      '* /api/git/stashes/**',
      'DELETE /api/git/worktrees',
    ],
  },
  {
    name: 'gate passes, handler refuses managed users (administrator only)',
    expect: ALLOW,
    rules: [
      // ensureLocalAdmin: lib/processes/routes.js
      '* /api/processes/**',
      // registerRuntimeBundleLifecycleRoutes guard: isAdministrator
      '* /api/runtime/bundle/**',
      // isManagedAdmin: lib/multi-user/bug-reports.js
      '* /api/error-logs/**',
    ],
  },
  {
    name: 'gate passes, handler answers unavailable or not found for everyone',
    expect: ALLOW,
    rules: [
      // Facade `disabled(...)` handlers and the retired retention control.
      '* /api/session/:sessionID/share',
      '* /api/session/:sessionID/shell',
      'ALL /api/session/:sessionID/message',
      'PATCH /api/session/:sessionID/message/:messageID/part/:partID',
      'DELETE /api/session/:sessionID/message/:messageID/part/:partID',
      'DELETE /api/session/:sessionID/message/:messageID',
      'ALL /api/session/retention-control',
    ],
  },
  {
    // ALLOWED TODAY AND UNREVIEWED. The gate lets a managed developer and
    // senior developer reach these entries, and reading the handler did not
    // show that this is safe: they read or change host-global state, use host
    // credentials, see or act on other users' requests, expose host paths,
    // proxy to host ports or start host work. This list is shrink-only in
    // spirit: never add an entry here to get the test green. Decide who may
    // call it and enforce that in the policy or handler; the test then fails
    // here and the entry moves to the class that holds.
    name: 'ALLOWED TODAY AND UNREVIEWED',
    expect: ALLOW,
    rules: [
      // OpenCode's resolved configuration (providers, MCP servers). hostGlobalRead
      // matches '/config/' with a slash, so the bare '/config' and '/global/config' pass.
      'GET /api/config',
      'GET /api/global/config',
      // Raw OpenCode v2 requests behind a browser allowlist the gate never sees.
      'USE /api/opencode-v2',
      // Native interview requests, answered with no principal check seen.
      'USE /api/devryan/interviews',
      // Preview targets accept any loopback URL and port with no project check,
      // and the proxy forwards to them.
      'POST /api/preview/targets',
      'POST /api/browser/targets',
      'USE /api/preview/proxy',
      // Pending requests of every user, and replies to them by id with no
      // owner check seen.
      'GET /api/permission',
      'GET /api/question',
      'POST /api/permission/:requestID/reply',
      'POST /api/question/:requestID/reply',
      'POST /api/question/:requestID/reject',
      // The host-wide OpenCode project list.
      'GET /api/project',
      // Host process memory metrics; the admin rule names 'memory-debug', which no route uses.
      'GET /api/debug/memory',
      // Host-wide session retention run and the shared retention selection gate.
      'POST /api/devryan/session-retention/run',
      'POST /api/devryan/session-retention/selection',
      // Starts agent/MCP warm-up for a request-supplied directory.
      'POST /api/startup/agent-runtime-warmup',
      // Usage of the host's provider credentials.
      'GET /api/quota/providers',
      'GET /api/quota/:providerId',
      // Speech and text services on host credentials or the host `say` binary.
      'POST /api/tts/speak',
      'POST /api/tts/say/speak',
      'POST /api/stt/transcribe',
      'POST /api/text/summarize',
      'POST /api/voice/token',
      // OpenCode's host paths (home, config, state).
      'GET /api/path',
    ],
  },
  {
    name: 'assignment checked by the gate (allowed for the assigned project)',
    expect: ALLOW,
    rules: ['GET /api/projects/:projectId/icon'],
  },
  {
    name: 'ownership scoped (gate passes, owner or assignment checked after it)',
    expect: ALLOW,
    rules: [
      // runtime.js mounts an ownsSession check on /api/session/:sessionID and
      // /api/devryan/session/:sessionID, and overrides list/create/fork.
      '* /api/session/**',
      'USE /api/devryan/session/:sessionID',
      // Session change host, behind the ownership mount above.
      'USE /api/devryan/session/:sessionID/changes',
      '* /api/devryan/session/:sessionID/**',
      '* /api/devryan/sessions/:sessionId/image-assets/prepare',
      '* /api/experimental/session',
      // filterSessionSnapshot / ownsSessionForRequest: notifications routes.
      '* /api/sessions/**',
      'GET /api/session-activity',
      'GET /api/notifications/stream',
      'POST /api/notifications/auto-accept',
      // authorizeObjectiveRead / ownsSession: orchestration routes.
      '* /api/orchestration/**',
      // resolveManagedProject: project runtime routes.
      'POST /api/projects/:projectId/branch-target',
      '* /api/projects/:projectId/scheduled-tasks/**',
      // Administrator status, else scoped to assigned projects.
      'GET /api/devryan/scheduled-tasks/status',
      'GET /api/devryan/events',
      // Managed override: switches only to an assigned project.
      'POST /api/opencode/directory',
      // Saved approvals: confined to the caller's assignment.
      '* /api/permission/saved/**',
      // Per-user folders, bug reports and analytics.
      '* /api/session-folders',
      '* /api/bug-reports/**',
      'POST /api/client-errors',
      'POST /api/analytics/events',
      // Per-UI-session push subscription and visibility.
      '* /api/push/**',
    ],
  },
  {
    name: 'open to managed users',
    expect: ALLOW,
    rules: [
      // Workspace Git and GitHub under the manageGit / github capabilities;
      // the gate pins the directory to the assignment.
      '* /api/git/**',
      '* /api/github/**',
      // Browser and preview under canUseBrowser, checked by the handlers.
      '* /api/browser/**',
      '* /api/preview/**',
      // Settings: the managed settings route validates each field against its page.
      '* /api/config/settings/**',
      'GET /api/config/themes',
      // Read-only catalogs the chat needs (see settingsPageForRequest).
      'GET /api/config/agents',
      'GET /api/config/providers',
      'GET /api/magic-prompts',
      'GET /api/agent',
      'GET /api/command',
      'GET /api/skill',
      'GET /api/lsp',
      'GET /api/vcs',
      'GET /api/project/current',
      'GET /api/experimental/tool/**',
      'GET /api/devryan/models-metadata',
      'GET /api/zen/models',
      'GET /api/tts/status',
      'GET /api/tts/say/status',
      // Event streams filtered per principal (filterEventForPrincipal).
      'GET /api/event',
      'GET /api/global/event',
    ],
  },
  {
    // Path middleware that never gives the final answer for a working
    // request: it times, journals, parses, holds while OpenCode restarts or
    // refuses with an error, then calls next(). The routes behind it are
    // classified above.
    name: 'path middleware in front of classified routes',
    expect: ALLOW,
    rules: [
      // proxy.js: generation check, readiness hold, facade router; the
      // facade ends in a 404 for unknown paths.
      'USE /api',
      // Creation tracing (application.js), session-create shaping (proxy.js).
      'USE /api/session',
      // Control journal and primary recovery (application.js), prompt admission and timing.
      'USE /api/session/:sessionID/prompt_async',
      // Retention connection tracking (session-retention.js).
      'USE /api/global/event',
      'USE /api/event',
      // Slow-request logging (question-routes.js).
      'USE /api/question',
    ],
  },
  {
    name: 'path middleware: ownership check (runtime.js) and control journal',
    expect: ALLOW,
    rules: ['USE /api/session/:sessionID'],
  },
  {
    name: 'path middleware: terminal session guard (terminal capability)',
    expect: { developer: NO_TERMINAL, senior_developer: ALLOW },
    rules: ['USE /api/terminal/:sessionId'],
  },
];

// Registration call sites that are not part of the main server.
const NOT_ON_MAIN_SERVER = [
  { file: 'lib/opencode/runtime-host/runtime-bundle-recovery.js', reason: 'separate loopback-only recovery server started instead of the main host' },
  { file: 'lib/opencode/standard-preview/application.js', reason: 'separate standard-preview server, not the managed host' },
];

// Main-server registrations this host never makes, with the reason.
const NOT_REACHED_HERE = [
  { file: 'lib/terminal/runtime.js', method: 'USE', path: '/api/terminal', reason: 'registered only where terminals are unavailable (Windows); answers 503 to everyone' },
];

// ---------------------------------------------------------------------------

const parseRule = (rule) => {
  const space = rule.indexOf(' ');
  return { rule, method: rule.slice(0, space), path: rule.slice(space + 1) };
};

const ruleMatches = ({ method, path: pattern }, entry) => {
  if (method === '*' ? entry.method === 'USE' : method !== entry.method) return false;
  if (pattern.endsWith('/**')) {
    const prefix = pattern.slice(0, -3);
    return entry.path === prefix || entry.path.startsWith(`${prefix}/`);
  }
  return entry.path === pattern;
};

for (const entry of CLASSES) entry.parsed = entry.rules.map(parseRule);
const classify = (entry) => {
  for (const candidate of CLASSES) {
    for (const rule of candidate.parsed) {
      if (ruleMatches(rule, entry)) return { entry: candidate, rule };
    }
  }
  return null;
};

const expectedFor = (entryClass, role, entry) => {
  const byRole = typeof entryClass.expect === 'object' && ROLES.some((name) => Object.hasOwn(entryClass.expect, name))
    ? entryClass.expect[role]
    : entryClass.expect;
  if (byRole && typeof byRole === 'object' && Object.hasOwn(byRole, 'default')) {
    return byRole[`${entry.method} ${entry.path}`] ?? byRole.default;
  }
  return byRole;
};

const describeDecision = (actual) => (actual.decision === 'deny'
  ? `deny ${actual.status} "${actual.reason}"`
  : actual.decision);
const describeExpected = (expected) => (typeof expected === 'string'
  ? expected
  : `deny ${expected.status} ${expected.reason}`);
const decisionMatches = (expected, actual) => (typeof expected === 'string'
  ? actual.decision === expected
  : actual.decision === 'deny' && actual.status === expected.status && expected.reason.test(actual.reason ?? ''));

const entryLabel = (entry) => `${entry.method} ${entry.path} (${entry.file}:${entry.line || 'inline'})`;

// Every `app|router.<verb>(` call, and every `.use(` with a literal path, in
// the server source.
const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.ts']);
const listServerSources = (directory) => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(directory, entry.name);
  if (entry.isDirectory()) return ['node_modules', 'default-config'].includes(entry.name) ? [] : listServerSources(full);
  if (!SOURCE_EXTENSIONS.has(path.extname(entry.name))) return [];
  if (/\.(?:test|spec)\.[cm]?[jt]s$/.test(entry.name) || entry.name.endsWith('.d.ts') || entry.name.startsWith('test-')) return [];
  return [full];
});

const REGISTRATION_CALL = /\b(app|router|privateApp)\.(get|post|put|patch|delete|all|use)\(\s*/g;
const literalPaths = (text) => {
  const quoted = text.match(/^(['`])((?:(?!\1)[^$\\])*)\1/);
  if (quoted) return [quoted[2]];
  const list = text.match(/^\[([^\]]*)\]/);
  if (list) return [...list[1].matchAll(/'([^']*)'/g)].map((match) => match[1]);
  const regex = text.match(/^\/((?:\\.|[^/\\])+)\/[a-z]*\s*,/);
  if (regex) return [`regex:${regex[1]}`];
  return [];
};

const scanRegistrationSites = () => {
  const sites = [];
  for (const file of listServerSources(SERVER_ROOT)) {
    const relative = path.relative(SERVER_ROOT, file);
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(REGISTRATION_CALL)) {
      const rest = text.slice(match.index + match[0].length);
      // app.get('name') with one argument reads an Express setting.
      if (match[2] === 'get' && /^'[^']*'\s*\)/.test(rest)) continue;
      const paths = literalPaths(rest);
      // A path-less use() is middleware for everything, not a path mount;
      // a path held in a variable cannot be read here and fails below.
      if (match[2] === 'use' && paths.length === 0 && !/^[A-Z_][A-Z0-9_]*\b/.test(rest)) continue;
      sites.push({
        file: relative,
        line: text.slice(0, match.index).split('\n').length,
        receiver: match[1],
        method: match[2] === 'use' ? 'USE' : match[2].toUpperCase(),
        paths,
      });
    }
  }
  return sites;
};

// Registrar calls in source order: calls that take the app (or an object
// starting with it) as first argument, inline app.<verb|use>(...) calls and
// the startup pipeline run.
const SEQUENCE_CALL = /\bapp\.(use|get|post|put|patch|delete|all)\(\s*(?:'([^']*)')?|([A-Za-z_$][\w$.]*)\(\s*(\{\s*app|app|privateApp)\b|\bstartupPipelineRuntime\.run\(/g;
const sourceSequence = (file, { from = null } = {}) => {
  const text = fs.readFileSync(path.join(SERVER_ROOT, file), 'utf8');
  const start = from ? text.indexOf(from) : 0;
  if (start < 0) throw new Error(`${file}: start marker "${from}" not found`);
  const tokens = [];
  for (const match of text.slice(start).matchAll(SEQUENCE_CALL)) {
    if (match[1]) tokens.push(`app.${match[1]}(${match[2] === undefined ? '' : `'${match[2]}'`}`);
    else if (match[3]) tokens.push(`${match[3]}(${match[4].replace(/\s+/g, '')}`);
    else tokens.push('startupPipelineRuntime.run(');
    if (tokens.at(-1) === 'startupPipelineRuntime.run(') break;
  }
  return tokens;
};

describe('managed-user route policy coverage', () => {
  let harness;
  let enumerated;
  let entries;
  let gate;
  const decisions = new Map();

  const countsTable = () => {
    const counts = new Map(CLASSES.map((entryClass) => [entryClass.name, { total: 0, ...Object.fromEntries(ROLES.map((role) => [role, {}])) }]));
    for (const entry of entries) {
      const match = classify(entry);
      if (!match) continue;
      const row = counts.get(match.entry.name);
      row.total += 1;
      for (const role of ROLES) {
        const decision = decisions.get(entry)[role].decision;
        row[role][decision] = (row[role][decision] ?? 0) + 1;
      }
    }
    const roleSummary = (tally) => Object.entries(tally).map(([decision, count]) => `${decision} ${count}`).join(', ');
    return [
      `${entries.length} entries: ${enumerated.routes.length} routes, ${enumerated.mounts.filter((mount) => mount.path).length - 1} path mounts (gate excluded)`,
      ...[...counts].map(([name, row]) => `  ${String(row.total).padStart(4)}  ${name}  [${ROLES.map((role) => `${role}: ${roleSummary(row[role])}`).join(' | ')}]`),
    ].join('\n');
  };

  beforeAll(async () => {
    harness = await createManagedPolicyHarness({ createMultiUserRuntime });
    enumerated = await enumerateServerRoutes({ multiUserRuntime: harness.runtime, dataDirectory: harness.repositoryPath });
    const gates = enumerated.mounts.filter((mount) => mount.path === '/api' && mount.file === 'lib/opencode/core-routes.js');
    if (gates.length !== 1) throw new Error(`Expected one /api policy gate from core-routes.js, found ${gates.length}`);
    [gate] = gates;
    entries = [
      ...enumerated.routes,
      ...enumerated.mounts.filter((mount) => typeof mount.path === 'string' && mount !== gate)
        .map((mount) => ({ ...mount, method: 'USE' })),
    ];
    for (const entry of entries) {
      const byRole = {};
      for (const role of ROLES) {
        const probe = (method) => probeManagedDecision({
          harness, gate: gate.handlers[0], method, routePath: entry.path, principal: harness.principals[role],
        });
        if (!entry.path.startsWith('/api')) {
          byRole[role] = { decision: OUTSIDE };
        } else if (entry.order < gate.order) {
          byRole[role] = { decision: PRE_GATE };
        } else if (entry.method === 'ALL' || entry.method === 'USE') {
          // Mounts and ALL routes take every method: read and write must agree.
          const [read, write] = [await probe('GET'), await probe('POST')];
          byRole[role] = describeDecision(read) === describeDecision(write)
            ? read
            : { decision: `GET ${describeDecision(read)}, POST ${describeDecision(write)}` };
        } else {
          byRole[role] = await probe(entry.method);
        }
      }
      decisions.set(entry, byRole);
    }
  // About 1,000 gate probes: around 1.5 s alone, but several times that on a
  // loaded machine, past Vitest's 10 s default hook budget.
  }, 30_000);

  afterAll(async () => {
    await harness?.dispose();
  });

  it('enumerates the main server routes and path mounts from the real registrars', () => {
    expect(enumerated.routes.length, countsTable()).toBeGreaterThan(400);
    expect(enumerated.mounts.some((mount) => mount.path === '/api/opencode-v2' && mount.viaRouter), countsTable()).toBe(true);
  });

  // The census is pinned to the host fixture in test-route-registry.js. A
  // second enumeration on a host that reports another platform and sets the
  // environment switches CI lanes and desktop builds use must register exactly
  // the same routes and mounts.
  it('enumerates the same routes and mounts whatever the host builds or runs on', async () => {
    const census = (result) => [
      ...result.routes.map((route) => `${route.method} ${route.path} ${route.file}:${route.line}`),
      ...result.mounts.filter((mount) => typeof mount.path === 'string').map((mount) => `USE ${mount.path} ${mount.file}:${mount.line}`),
    ].sort();
    const descriptors = Object.fromEntries(['platform', 'arch'].map((key) => [key, Object.getOwnPropertyDescriptor(process, key)]));
    let other;
    try {
      Object.defineProperty(process, 'platform', { ...descriptors.platform, value: process.platform === 'linux' ? 'win32' : 'linux' });
      Object.defineProperty(process, 'arch', { ...descriptors.arch, value: process.arch === 'x64' ? 'arm64' : 'x64' });
      for (const [key, value] of Object.entries({
        CI: 'true',
        GITHUB_ACTIONS: 'true',
        DEVRYAN_DIST_DIR: path.join(SERVER_ROOT, 'route-census-missing-dist'),
        DEVRYAN_RUNTIME: 'desktop',
        DEVRYAN_DEV_MODE: 'true',
        DEVRYAN_SKIP_OPENCODE_START: 'true',
      })) vi.stubEnv(key, value);
      other = await enumerateServerRoutes({ multiUserRuntime: harness.runtime, dataDirectory: harness.repositoryPath });
    } finally {
      vi.unstubAllEnvs();
      for (const [key, descriptor] of Object.entries(descriptors)) Object.defineProperty(process, key, descriptor);
    }
    const [expected, actual] = [census(enumerated), census(other)];
    const onlyHere = expected.filter((key) => !actual.includes(key));
    const onlyThere = actual.filter((key) => !expected.includes(key));
    expect({ onlyHere, onlyThere }, `Census differs on another host (${expected.length} vs ${actual.length} entries)`).toEqual({ onlyHere: [], onlyThere: [] });
  });

  it('mirrors the order in which the server calls its registrars', () => {
    const failures = [];
    for (const [file, mirrored] of Object.entries(enumerated.sequences)) {
      const actual = sourceSequence(file, file === 'application.js' ? { from: 'const app = express();' } : {});
      const length = Math.max(actual.length, mirrored.length);
      for (let index = 0; index < length; index += 1) {
        if (actual[index] !== mirrored[index]) {
          failures.push(`${file}: registration order differs at call ${index + 1}: source has ${actual[index] ?? '<end>'}, test-route-registry.js mirrors ${mirrored[index] ?? '<end>'}`);
          break;
        }
      }
    }
    expect(failures, failures.join('\n')).toEqual([]);
  });

  it('reaches every route and path-mount registration in the server source', () => {
    const excluded = new Set(NOT_ON_MAIN_SERVER.map((entry) => entry.file));
    const sites = scanRegistrationSites().filter((site) => !excluded.has(site.file));
    const missing = [];
    const usedNotReached = new Set();
    for (const site of sites) {
      const notReached = NOT_REACHED_HERE.find((entry) => entry.file === site.file && entry.method === site.method && site.paths.includes(entry.path));
      if (notReached) {
        usedNotReached.add(notReached);
        continue;
      }
      // The policy gate itself is not an entry.
      const isGate = site.file === gate.file && site.line === gate.line;
      const covered = isGate || entries.some((entry) => {
        if (entry.method !== site.method) return false;
        if (entry.sourceOnly) return entry.file === site.file && site.paths.includes(entry.path);
        // Router entries are read from the mounted router: match by method and
        // by path below the mount.
        if (site.receiver === 'router') return entry.viaRouter && site.paths.some((sitePath) => entry.path.endsWith(sitePath));
        if (entry.file !== site.file) return false;
        if (entry.line === site.line) return true;
        // The same registration on another branch (e.g. with and without a built UI).
        return site.paths.length > 0 && site.paths.includes(entry.path);
      });
      if (!covered) missing.push(`${site.file}:${site.line} ${site.method} ${site.paths.join(', ') || '<path not readable>'}`);
    }
    for (const file of excluded) {
      if (!fs.existsSync(path.join(SERVER_ROOT, file))) missing.push(`NOT_ON_MAIN_SERVER lists a missing file: ${file}`);
    }
    for (const entry of NOT_REACHED_HERE) {
      if (!usedNotReached.has(entry)) missing.push(`NOT_REACHED_HERE matches no call site: ${entry.file} ${entry.method} ${entry.path}`);
    }
    expect(missing, `Registrations not reached by the enumeration:\n${missing.join('\n')}`).toEqual([]);
  });

  it('classifies every entry and the managed-user policy decides as its class says, per role', () => {
    const failures = [];
    for (const entry of entries) {
      const match = classify(entry);
      const actual = decisions.get(entry);
      if (!match) {
        failures.push(`${entryLabel(entry)}: matches no class (policy today: ${ROLES.map((role) => `${role} ${describeDecision(actual[role])}`).join('; ')})`);
        continue;
      }
      for (const role of ROLES) {
        const expected = expectedFor(match.entry, role, entry);
        if (!decisionMatches(expected, actual[role])) {
          failures.push(`${entryLabel(entry)}: decision differs for ${role} from class "${match.entry.name}" (rule '${match.rule.rule}'): expected ${describeExpected(expected)}, policy today: ${describeDecision(actual[role])}`);
        }
      }
    }
    expect(failures, `Route policy coverage failures:\n${failures.join('\n')}\n\n${countsTable()}`).toEqual([]);
  });

  it('has no classification rule that matches no entry', () => {
    const used = new Set();
    for (const entry of entries) {
      const match = classify(entry);
      if (match) used.add(match.rule);
    }
    const unused = CLASSES.flatMap((entryClass) => entryClass.parsed
      .filter((rule) => !used.has(rule))
      .map((rule) => `"${entryClass.name}": '${rule.rule}'`));
    expect(unused, `Classification rules that match no entry:\n${unused.join('\n')}`).toEqual([]);
  });

  // Characterizes the gate as it is today: authorizeManagedRequest only
  // denies paths that one of its expressions names, so an /api path under a
  // prefix none of them mentions passes for a managed user (after the CSRF
  // header check for mutations). If the gate becomes default-deny, update this
  // expectation together with the classes above.
  it('passes an /api path that no policy rule mentions', async () => {
    const unlisted = '/api/route-policy-unlisted-prefix/probe';
    const handler = gate.handlers[0];
    for (const role of ROLES) {
      for (const method of ['GET', 'POST', 'DELETE']) {
        const result = await probeManagedDecision({ harness, gate: handler, method, routePath: unlisted, principal: harness.principals[role] });
        expect(result, `${role} ${method}`).toMatchObject({ decision: 'allow' });
      }
    }
    // Without a signed-in principal the same path is refused.
    const anonymous = await probeManagedDecision({ harness, gate: handler, method: 'GET', routePath: unlisted, principal: { cookie: '' } });
    expect(anonymous).toMatchObject({ decision: 'deny', status: 401 });
  });
});
