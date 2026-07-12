# Cloudflare Managed Tunnel Token Normalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make DevRyan accept raw Cloudflare managed-tunnel tokens and standard dashboard-copied connector commands while persisting and launching only the extracted token.

**Architecture:** Add a dependency-free parser owned by `packages/web/server/lib/tunnels/`. Apply it when managed credentials enter persistent configuration and again immediately before cloudflared receives a token. Keep the UI shell-agnostic and leave Cloudflare DNS/routes unchanged.

**Tech Stack:** JavaScript ESM, Express server runtime, Vitest, Bun, Electron, Cloudflare Tunnel.

## Global Constraints

- Work only inside `/Users/zoubair/Repositories/DevRyan`.
- Add no dependencies.
- Never log, return, snapshot, or otherwise expose a tunnel token.
- Preserve raw-token behavior and existing web/Electron/VS Code contracts.
- Do not modify Cloudflare DNS or route configuration.
- Run `bun run validate:affected` and `bun run --cwd packages/web test` for this server change.
- Perform a visual DevRyan check and verify Cloudflare reports a healthy replica.

---

### Task 1: Parse Cloudflare dashboard clipboard values

**Files:**
- Create: `packages/web/server/lib/tunnels/managed-token.js`
- Create: `packages/web/server/lib/tunnels/managed-token.test.js`

**Interfaces:**
- Consumes: an unknown pasted value.
- Produces: `normalizeManagedRemoteTunnelToken(value): string`, which returns a raw token or throws `ManagedRemoteTunnelTokenValidationError` with a non-sensitive message.

- [ ] **Step 1: Write the failing parser tests**

```js
import { describe, expect, it } from 'vitest';
import { normalizeManagedRemoteTunnelToken } from './managed-token.js';

const TOKEN = `eyJ${'a'.repeat(80)}`;

describe('normalizeManagedRemoteTunnelToken', () => {
  it.each([
    [TOKEN, TOKEN],
    [` cloudflared tunnel run --token ${TOKEN} `, TOKEN],
    [`cloudflared tunnel run --token=${TOKEN}`, TOKEN],
    [`sudo cloudflared service install '${TOKEN}'`, TOKEN],
    [`cloudflared.exe service install "${TOKEN}"`, TOKEN],
    [`docker run cloudflare/cloudflared:latest tunnel --no-autoupdate run --token ${TOKEN}`, TOKEN],
  ])('normalizes supported input %#', (input, expected) => {
    expect(normalizeManagedRemoteTunnelToken(input)).toBe(expected);
  });

  it.each(['', 'not a token', 'cloudflared tunnel run --token', `cloudflared tunnel run --token ${TOKEN} --token ${TOKEN}`])(
    'rejects invalid input without echoing it: %s',
    (input) => {
      expect(() => normalizeManagedRemoteTunnelToken(input)).toThrow('Paste a raw Cloudflare tunnel token or a Cloudflare-generated connector command.');
      try {
        normalizeManagedRemoteTunnelToken(input);
      } catch (error) {
        expect(error.message).not.toContain(TOKEN);
      }
    },
  );
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `bun run --cwd packages/web test -- server/lib/tunnels/managed-token.test.js`

Expected: FAIL because `managed-token.js` does not exist.

- [ ] **Step 3: Implement the minimal strict parser**

```js
const TOKEN_PATTERN = /^eyJ[A-Za-z0-9_-]{40,}={0,2}$/;
const ERROR_MESSAGE = 'Paste a raw Cloudflare tunnel token or a Cloudflare-generated connector command.';

export class ManagedRemoteTunnelTokenValidationError extends Error {
  constructor() {
    super(ERROR_MESSAGE);
    this.name = 'ManagedRemoteTunnelTokenValidationError';
  }
}

const unquote = (value) => {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
};

export const normalizeManagedRemoteTunnelToken = (value) => {
  const input = typeof value === 'string' ? value.trim() : '';
  if (TOKEN_PATTERN.test(input)) return input;

  const flagMatches = [...input.matchAll(/(?:^|\s)--token(?:=|\s+)(["']?[^\s"']+["']?)/g)];
  const serviceMatch = input.match(/(?:^|\s)(?:cloudflared(?:\.exe)?)\s+service\s+install\s+(["']?[^\s"']+["']?)\s*$/i);
  const candidates = [
    ...flagMatches.map((match) => unquote(match[1])),
    ...(serviceMatch ? [unquote(serviceMatch[1])] : []),
  ].filter((candidate) => TOKEN_PATTERN.test(candidate));

  if (candidates.length === 1) return candidates[0];
  throw new ManagedRemoteTunnelTokenValidationError();
};
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `bun run --cwd packages/web test -- server/lib/tunnels/managed-token.test.js`

Expected: PASS with all parser cases green.

- [ ] **Step 5: Commit the parser**

```bash
git add packages/web/server/lib/tunnels/managed-token.js packages/web/server/lib/tunnels/managed-token.test.js
git commit -m "fix: normalize Cloudflare tunnel tokens"
```

### Task 2: Enforce normalization at persistence and launch boundaries

**Files:**
- Modify: `packages/web/server/lib/tunnels/managed-config.js`
- Modify: `packages/web/server/lib/cloudflare-tunnel.js`
- Modify: `packages/web/server/index.js`
- Create: `packages/web/server/lib/tunnels/managed-config.test.js`
- Modify: `packages/web/server/lib/tunnels/DOCUMENTATION.md`

**Interfaces:**
- Consumes: `normalizeManagedRemoteTunnelToken(value): string` from Task 1.
- Produces: persisted configuration and cloudflared token files containing raw tokens only.

- [ ] **Step 1: Write a failing persistence-boundary test**

Create a runtime with in-memory `fsPromises`, inject `normalizeManagedRemoteTunnelToken`, call `upsertManagedRemoteTunnelToken` with `cloudflared tunnel run --token ${TOKEN}`, and assert the JSON written to disk contains exactly `TOKEN` and not `cloudflared`.

- [ ] **Step 2: Run the persistence test and verify RED**

Run: `bun run --cwd packages/web test -- server/lib/tunnels/managed-config.test.js`

Expected: FAIL because `createManagedTunnelConfigRuntime` currently persists the whole command.

- [ ] **Step 3: Normalize before persistence**

Add `normalizeManagedRemoteTunnelToken` to the runtime dependencies and replace:

```js
const normalizedToken = token.trim();
```

with:

```js
const normalizedToken = normalizeManagedRemoteTunnelToken(token);
```

Import the helper in `packages/web/server/index.js` and inject it into `createManagedTunnelConfigRuntime`.

- [ ] **Step 4: Normalize immediately before cloudflared launch**

In `cloudflare-tunnel.js`, import the helper and replace the trim-only normalization with:

```js
const normalizedToken = normalizeManagedRemoteTunnelToken(token);
```

This recovers recognized legacy stored commands and protects request-supplied tokens even when they bypass persistence.

- [ ] **Step 5: Update module documentation**

Document `managed-token.js` as the authoritative parser and state that persistence and launch boundaries both enforce it.

- [ ] **Step 6: Run focused server tests**

Run: `bun run --cwd packages/web test -- server/lib/tunnels/managed-token.test.js server/lib/tunnels/managed-config.test.js server/lib/tunnels/cloudflare-diagnostics.test.js`

Expected: PASS with no token material printed.

- [ ] **Step 7: Commit boundary enforcement**

```bash
git add packages/web/server/index.js packages/web/server/lib/cloudflare-tunnel.js packages/web/server/lib/tunnels/managed-config.js packages/web/server/lib/tunnels/managed-config.test.js packages/web/server/lib/tunnels/DOCUMENTATION.md
git commit -m "fix: enforce managed tunnel token normalization"
```

### Task 3: Validate and visually verify the repaired tunnel

**Files:**
- Modify only if validation reveals a defect in Task 1 or Task 2.

**Interfaces:**
- Consumes: completed parser and boundary enforcement.
- Produces: automated validation evidence and a visually verified healthy tunnel.

- [ ] **Step 1: Run affected validation**

Run: `bun run validate:affected`

Expected: exit 0.

- [ ] **Step 2: Run the complete web server suite**

Run: `bun run --cwd packages/web test`

Expected: exit 0 with zero failed tests.

- [ ] **Step 3: Start the updated Electron development app**

Run: `bun run electron:dev`

Expected: DevRyan opens and its in-process web server becomes ready.

- [ ] **Step 4: Perform the DevRyan visual check**

In DevRyan, open Settings → Remote Tunnel → Managed Remote, paste the current Cloudflare-generated manual command into the `Dev` token field, save, and start. Verify visually that the error panel disappears, active managed-tunnel controls appear, and no token is rendered.

- [ ] **Step 5: Verify Cloudflare visually**

In Firefox, refresh the `Dev` tunnel overview. Verify Status is Healthy, Active replicas is at least 1, and Routes still shows `devryan.1health.ae` → `http://localhost:49565`.

- [ ] **Step 6: Record final repository state**

Run: `git status --short && git log -3 --oneline`

Expected: no unintended changes; commits correspond only to the parser, boundary enforcement, and approved documentation.
