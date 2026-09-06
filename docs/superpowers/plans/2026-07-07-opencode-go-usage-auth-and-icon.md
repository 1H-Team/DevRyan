# OpenCode Go Usage Auth And Icon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users configure OpenCode Go usage tracking from Settings and restore the OpenCode Go provider icon that was replaced in the last release.

**Architecture:** Keep quota fetching in the existing OpenCode Go provider modules; add only the missing credential-management surface that writes `usageWorkspaceId` and `usageAuthCookie` into `auth["opencode-go"]`. Mirror the existing Cursor usage-token pattern across the web server, VS Code bridge, and shared Providers settings UI, while reverting the `opencode-go -> gocode` logo alias that changed the icon in `v1.0.6`.

**Tech Stack:** Bun, Express, React, TypeScript, Vitest, VS Code webview bridge, existing `@/components/ui` primitives.

---

## File Structure

- Modify `packages/web/server/lib/opencode/routes.js`: add OpenCode Go usage-auth validation helpers and `GET`/`PUT`/`DELETE` routes next to Cursor usage-auth routes.
- Modify `packages/web/server/lib/opencode/provider-routes.test.js`: add route tests for saving, clearing, preserving API auth, and rejecting invalid OpenCode Go usage credentials.
- Modify `packages/ui/src/components/sections/providers/ProvidersPage.tsx`: add OpenCode Go usage-tracking state and controls modeled after Cursor, with two inputs: workspace ID and dashboard auth cookie.
- Modify `packages/ui/src/lib/i18n/messages/en.settings.ts`: add OpenCode Go labels, instructions, placeholders, and toast text.
- Modify `packages/ui/src/hooks/useProviderLogo.ts`: remove the `['opencode-go', 'gocode']` alias so `opencode-go` resolves to the previous remote `https://models.dev/logos/opencode-go.svg`.
- Modify or add focused tests in `packages/ui/src/components/sections/usage/UsagePage.test.ts` or a new source-level Providers test: lock the OpenCode Go usage UI strings and logo alias behavior.

---

### Task 1: Add Web Usage-Auth Routes

**Files:**
- Modify: `packages/web/server/lib/opencode/routes.js`
- Test: `packages/web/server/lib/opencode/provider-routes.test.js`

- [ ] **Step 1: Add failing route tests**

Append these tests near the existing Cursor usage-auth route tests in `packages/web/server/lib/opencode/provider-routes.test.js`:

```js
  it('saves OpenCode Go usage auth without deleting the API key', async () => {
    readAuthFile.mockReturnValue({ 'opencode-go': { key: 'go-api-key' } });
    const { app } = createApp();

    await request(app)
      .put('/api/provider/opencode-go/usage-auth')
      .send({ workspaceId: 'wrk_abc123', authCookie: 'Fe26.2**secret-cookie' })
      .expect(200);

    expect(writeAuthFile).toHaveBeenCalledWith({
      'opencode-go': {
        key: 'go-api-key',
        usageWorkspaceId: 'wrk_abc123',
        usageAuthCookie: 'Fe26.2**secret-cookie',
      },
    });
  });

  it('reports OpenCode Go usage auth status', async () => {
    readAuthFile.mockReturnValue({
      'opencode-go': {
        usageWorkspaceId: 'wrk_abc123',
        usageAuthCookie: 'Fe26.2**secret-cookie',
      },
    });
    const { app } = createApp();

    const response = await request(app)
      .get('/api/provider/opencode-go/usage-auth/status')
      .expect(200);

    expect(response.body).toEqual({ configured: true, workspaceId: 'wrk_abc123' });
  });

  it('clears OpenCode Go usage auth without deleting the API key', async () => {
    readAuthFile.mockReturnValue({
      'opencode-go': {
        key: 'go-api-key',
        usageWorkspaceId: 'wrk_abc123',
        usageAuthCookie: 'Fe26.2**secret-cookie',
      },
    });
    const { app } = createApp();

    await request(app)
      .delete('/api/provider/opencode-go/usage-auth')
      .expect(200);

    expect(writeAuthFile).toHaveBeenCalledWith({
      'opencode-go': { key: 'go-api-key' },
    });
  });

  it('rejects invalid OpenCode Go usage auth values', async () => {
    const { app } = createApp();

    await request(app)
      .put('/api/provider/opencode-go/usage-auth')
      .send({ workspaceId: 'not-a-workspace', authCookie: 'cookie' })
      .expect(400);

    expect(writeAuthFile).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```bash
bun run --cwd packages/web test -- server/lib/opencode/provider-routes.test.js
```

Expected: the new OpenCode Go usage-auth route tests fail with `404` until routes are implemented.

- [ ] **Step 3: Add route helpers**

In `packages/web/server/lib/opencode/routes.js`, add constants near the Cursor constants:

```js
const OPENCODE_GO_PROVIDER_ID = 'opencode-go';
const OPENCODE_GO_WORKSPACE_ID_PATTERN = /^wrk_[a-zA-Z0-9]+$/;
const OPENCODE_GO_USAGE_COOKIE_MAX_LENGTH = 16_384;
```

Add helpers near `readCursorUsageAuthConfigured` and `normalizeCursorUsageSessionToken`:

```js
  const readOpenCodeGoUsageAuthStatus = async () => {
    const { readAuthFile } = await getAuthLibrary();
    const auth = readAuthFile();
    const entry = auth?.[OPENCODE_GO_PROVIDER_ID];
    const workspaceId = typeof entry?.usageWorkspaceId === 'string' ? entry.usageWorkspaceId.trim() : '';
    const authCookie = typeof entry?.usageAuthCookie === 'string' ? entry.usageAuthCookie.trim() : '';
    return {
      configured: Boolean(workspaceId && authCookie),
      workspaceId: workspaceId || null,
    };
  };

  const normalizeOpenCodeGoWorkspaceId = (value) => {
    if (typeof value !== 'string') return null;
    const workspaceId = value.trim();
    if (!OPENCODE_GO_WORKSPACE_ID_PATTERN.test(workspaceId)) return null;
    return workspaceId;
  };

  const normalizeOpenCodeGoAuthCookie = (value) => {
    if (typeof value !== 'string') return null;
    const authCookie = value.trim();
    if (!authCookie || authCookie.length > OPENCODE_GO_USAGE_COOKIE_MAX_LENGTH) return null;
    return authCookie;
  };
```

- [ ] **Step 4: Add routes**

Add the routes immediately after the Cursor usage-auth routes in `packages/web/server/lib/opencode/routes.js`:

```js
  app.get('/api/provider/opencode-go/usage-auth/status', async (_req, res) => {
    try {
      return res.json(await readOpenCodeGoUsageAuthStatus());
    } catch (error) {
      console.error('Failed to read OpenCode Go usage auth status:', error);
      return res.status(500).json({ error: error.message || 'Failed to read OpenCode Go usage auth status' });
    }
  });

  app.put('/api/provider/opencode-go/usage-auth', async (req, res) => {
    try {
      const workspaceId = normalizeOpenCodeGoWorkspaceId(req.body?.workspaceId);
      const authCookie = normalizeOpenCodeGoAuthCookie(req.body?.authCookie);
      if (!workspaceId) {
        return res.status(400).json({ error: 'A valid OpenCode Go workspace ID is required.' });
      }
      if (!authCookie) {
        return res.status(400).json({ error: 'OpenCode Go auth cookie is required.' });
      }

      const { readAuthFile, writeAuthFile } = await getAuthLibrary();
      const auth = readAuthFile();
      const existing = auth?.[OPENCODE_GO_PROVIDER_ID] && typeof auth[OPENCODE_GO_PROVIDER_ID] === 'object'
        ? auth[OPENCODE_GO_PROVIDER_ID]
        : {};
      writeAuthFile({
        ...auth,
        [OPENCODE_GO_PROVIDER_ID]: {
          ...existing,
          usageWorkspaceId: workspaceId,
          usageAuthCookie: authCookie,
        },
      });

      return res.json({ success: true, configured: true, workspaceId });
    } catch (error) {
      console.error('Failed to save OpenCode Go usage auth:', error);
      return res.status(500).json({ error: error.message || 'Failed to save OpenCode Go usage auth' });
    }
  });

  app.delete('/api/provider/opencode-go/usage-auth', async (_req, res) => {
    try {
      const { readAuthFile, writeAuthFile } = await getAuthLibrary();
      const auth = readAuthFile();
      const existing = auth?.[OPENCODE_GO_PROVIDER_ID] && typeof auth[OPENCODE_GO_PROVIDER_ID] === 'object'
        ? { ...auth[OPENCODE_GO_PROVIDER_ID] }
        : {};
      delete existing.usageWorkspaceId;
      delete existing.usageAuthCookie;
      writeAuthFile({
        ...auth,
        [OPENCODE_GO_PROVIDER_ID]: existing,
      });

      return res.json({ success: true, configured: false, workspaceId: null });
    } catch (error) {
      console.error('Failed to clear OpenCode Go usage auth:', error);
      return res.status(500).json({ error: error.message || 'Failed to clear OpenCode Go usage auth' });
    }
  });
```

- [ ] **Step 5: Run tests and verify they pass**

Run:

```bash
bun run --cwd packages/web test -- server/lib/opencode/provider-routes.test.js
```

Expected: the new OpenCode Go usage-auth route tests pass.

---

### Task 2: Add VS Code Bridge Parity

**Files:**

- [ ] **Step 1: Add constants and helpers**

```ts
const OPENCODE_GO_PROVIDER_ID = 'opencode-go';
const OPENCODE_GO_WORKSPACE_ID_PATTERN = /^wrk_[a-zA-Z0-9]+$/;
const OPENCODE_GO_USAGE_COOKIE_MAX_LENGTH = 16_384;
```

Add helpers near the Cursor usage token helpers:

```ts
const normalizeOpenCodeGoWorkspaceId = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const workspaceId = value.trim();
  return OPENCODE_GO_WORKSPACE_ID_PATTERN.test(workspaceId) ? workspaceId : null;
};

const normalizeOpenCodeGoAuthCookie = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const authCookie = value.trim();
  if (!authCookie || authCookie.length > OPENCODE_GO_USAGE_COOKIE_MAX_LENGTH) return null;
  return authCookie;
};

const readOpenCodeGoUsageAuthStatus = () => {
  const auth = readAuthFile();
  const entry = isRecord(auth[OPENCODE_GO_PROVIDER_ID]) ? auth[OPENCODE_GO_PROVIDER_ID] : {};
  const workspaceId = normalizeOpenCodeGoWorkspaceId(entry.usageWorkspaceId);
  const authCookie = normalizeOpenCodeGoAuthCookie(entry.usageAuthCookie);
  return {
    configured: Boolean(workspaceId && authCookie),
    workspaceId,
  };
};
```

- [ ] **Step 2: Add bridge handlers**

In the `switch` inside `handleSystemBridgeMessage`, add:

```ts
    case 'api:provider/opencode-go/usage-auth/status': {
      try {
        return {
          id,
          type,
          success: true,
          data: readOpenCodeGoUsageAuthStatus(),
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return { id, type, success: false, error: errorMessage };
      }
    }

    case 'api:provider/opencode-go/usage-auth:save': {
      const body = asObject(payload);
      const workspaceId = normalizeOpenCodeGoWorkspaceId(body?.workspaceId);
      const authCookie = normalizeOpenCodeGoAuthCookie(body?.authCookie);
      if (!workspaceId) {
        return { id, type, success: false, error: 'A valid OpenCode Go workspace ID is required.' };
      }
      if (!authCookie) {
        return { id, type, success: false, error: 'OpenCode Go auth cookie is required.' };
      }
      try {
        const auth = readAuthFile();
        const existing = asObject(auth[OPENCODE_GO_PROVIDER_ID]) ?? {};
        auth[OPENCODE_GO_PROVIDER_ID] = {
          ...existing,
          usageWorkspaceId: workspaceId,
          usageAuthCookie: authCookie,
        };
        writeAuthFile(auth);
        return {
          id,
          type,
          success: true,
          data: { success: true, configured: true, workspaceId },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return { id, type, success: false, error: errorMessage };
      }
    }

    case 'api:provider/opencode-go/usage-auth:clear': {
      try {
        const auth = readAuthFile();
        const existing = asObject(auth[OPENCODE_GO_PROVIDER_ID]) ?? {};
        const nextEntry = { ...existing };
        delete nextEntry.usageWorkspaceId;
        delete nextEntry.usageAuthCookie;
        auth[OPENCODE_GO_PROVIDER_ID] = nextEntry;
        writeAuthFile(auth);
        return {
          id,
          type,
          success: true,
          data: { success: true, configured: false, workspaceId: null },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return { id, type, success: false, error: errorMessage };
      }
    }
```

- [ ] **Step 3: Add webview fetch intercepts**

```ts
  if (pathname === '/api/provider/opencode-go/usage-auth/status' && (init?.method || 'GET').toUpperCase() === 'GET') {
    try {
      const data = await sendBridgeMessage('api:provider/opencode-go/usage-auth/status', {});
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ error: message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  }

  if (pathname === '/api/provider/opencode-go/usage-auth' && (init?.method || 'GET').toUpperCase() === 'PUT') {
    try {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
      const data = await sendBridgeMessage('api:provider/opencode-go/usage-auth:save', body);
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ error: message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  }

  if (pathname === '/api/provider/opencode-go/usage-auth' && (init?.method || 'GET').toUpperCase() === 'DELETE') {
    try {
      const data = await sendBridgeMessage('api:provider/opencode-go/usage-auth:clear', {});
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ error: message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  }
```

- [ ] **Step 4: Run VS Code checks**

Run:

```bash
```

Expected: existing OpenCode Go quota tests still pass and TypeScript accepts the new bridge handlers.

---

### Task 3: Add Shared UI Controls

**Files:**
- Modify: `packages/ui/src/components/sections/providers/ProvidersPage.tsx`
- Modify: `packages/ui/src/lib/i18n/messages/en.settings.ts`
- Test: `packages/ui/src/components/sections/usage/UsagePage.test.ts`

- [ ] **Step 1: Add source-level failing test for UI wiring**

Add a test to `packages/ui/src/components/sections/usage/UsagePage.test.ts`:

```ts
  test('Providers page contains OpenCode Go usage auth controls', () => {
    const source = readFileSync(join(rootDir, 'packages/ui/src/components/sections/providers/ProvidersPage.tsx'), 'utf8');
    const messages = readFileSync(join(rootDir, 'packages/ui/src/lib/i18n/messages/en.settings.ts'), 'utf8');

    expect(source).toContain('/api/provider/opencode-go/usage-auth/status');
    expect(source).toContain('/api/provider/opencode-go/usage-auth');
    expect(source).toContain('renderOpenCodeGoUsageTracking');
    expect(messages).toContain('settings.providers.page.auth.openCodeGoUsageTitle');
    expect(messages).toContain('settings.providers.page.toast.openCodeGoUsageSaved');
  });
```

- [ ] **Step 2: Run test and verify it fails**

Run:

```bash
bun run --cwd packages/ui test -- UsagePage.test.ts
```

Expected: the new test fails until the UI code and messages are added.

- [ ] **Step 3: Add constants, state, and active-provider detection**

In `ProvidersPage.tsx`, add:

```ts
const OPENCODE_GO_PROVIDER_ID = 'opencode-go';
const OPENCODE_GO_WORKSPACE_INPUT_ID = 'opencode-go-usage-workspace-id';
const OPENCODE_GO_AUTH_COOKIE_INPUT_ID = 'opencode-go-usage-auth-cookie';
```

Add state near Cursor usage state:

```ts
  const [openCodeGoWorkspaceIdInput, setOpenCodeGoWorkspaceIdInput] = React.useState('');
  const [openCodeGoAuthCookieInput, setOpenCodeGoAuthCookieInput] = React.useState('');
  const [openCodeGoUsageAuthConfigured, setOpenCodeGoUsageAuthConfigured] = React.useState(false);
  const [openCodeGoUsageAuthLoading, setOpenCodeGoUsageAuthLoading] = React.useState(false);
```

Add active-provider memo near `activeCursorAcpProviderId`:

```ts
  const activeOpenCodeGoProviderId = React.useMemo(() => {
    if (isAddMode) {
      return candidateProviderId === OPENCODE_GO_PROVIDER_ID ? candidateProviderId : null;
    }
    return selectedProviderId === OPENCODE_GO_PROVIDER_ID ? selectedProviderId : null;
  }, [candidateProviderId, isAddMode, selectedProviderId]);
```

- [ ] **Step 4: Add status/save/clear/refresh handlers**

Add the handlers near the Cursor usage handlers:

```ts
  const refreshOpenCodeGoUsageAuthStatus = React.useCallback(async () => {
    if (!activeOpenCodeGoProviderId) {
      setOpenCodeGoUsageAuthConfigured(false);
      setOpenCodeGoUsageAuthLoading(false);
      setOpenCodeGoWorkspaceIdInput('');
      return;
    }

    setOpenCodeGoUsageAuthLoading(true);
    try {
      const response = await fetch('/api/provider/opencode-go/usage-auth/status', {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.error || t('settings.providers.page.toast.openCodeGoUsageStatusFailed'));
      }
      setOpenCodeGoUsageAuthConfigured(Boolean(payload?.configured));
      setOpenCodeGoWorkspaceIdInput(typeof payload?.workspaceId === 'string' ? payload.workspaceId : '');
    } catch (error) {
      console.error('Failed to load OpenCode Go usage auth status:', error);
      setOpenCodeGoUsageAuthConfigured(false);
    } finally {
      setOpenCodeGoUsageAuthLoading(false);
    }
  }, [activeOpenCodeGoProviderId, t]);

  React.useEffect(() => {
    void refreshOpenCodeGoUsageAuthStatus();
  }, [refreshOpenCodeGoUsageAuthStatus]);

  const handleSaveOpenCodeGoUsageAuth = async () => {
    const workspaceId = openCodeGoWorkspaceIdInput.trim();
    const authCookie = openCodeGoAuthCookieInput.trim();
    if (!workspaceId) {
      toast.error(t('settings.providers.page.toast.openCodeGoWorkspaceRequired'));
      return;
    }
    if (!authCookie) {
      toast.error(t('settings.providers.page.toast.openCodeGoAuthCookieRequired'));
      return;
    }

    const busyKey = 'opencode-go-usage-save';
    setAuthBusyKey(busyKey);
    try {
      const response = await fetch('/api/provider/opencode-go/usage-auth', {
        method: 'PUT',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ workspaceId, authCookie }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.error || t('settings.providers.page.toast.openCodeGoUsageSaveFailed'));
      }
      setOpenCodeGoAuthCookieInput('');
      setOpenCodeGoUsageAuthConfigured(true);
      toast.success(t('settings.providers.page.toast.openCodeGoUsageSaved'));
      await fetchProviderQuota(OPENCODE_GO_PROVIDER_ID, { forceRefresh: true });
    } catch (error) {
      console.error('Failed to save OpenCode Go usage auth:', error);
      toast.error(error instanceof Error ? error.message : t('settings.providers.page.toast.openCodeGoUsageSaveFailed'));
    } finally {
      setAuthBusyKey(null);
    }
  };

  const handleClearOpenCodeGoUsageAuth = async () => {
    const busyKey = 'opencode-go-usage-clear';
    setAuthBusyKey(busyKey);
    try {
      const response = await fetch('/api/provider/opencode-go/usage-auth', {
        method: 'DELETE',
        headers: { Accept: 'application/json' },
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.error || t('settings.providers.page.toast.openCodeGoUsageClearFailed'));
      }
      setOpenCodeGoWorkspaceIdInput('');
      setOpenCodeGoAuthCookieInput('');
      setOpenCodeGoUsageAuthConfigured(false);
      toast.success(t('settings.providers.page.toast.openCodeGoUsageCleared'));
      await fetchProviderQuota(OPENCODE_GO_PROVIDER_ID, { forceRefresh: true });
    } catch (error) {
      console.error('Failed to clear OpenCode Go usage auth:', error);
      toast.error(error instanceof Error ? error.message : t('settings.providers.page.toast.openCodeGoUsageClearFailed'));
    } finally {
      setAuthBusyKey(null);
    }
  };

  const handleRefreshOpenCodeGoUsage = async () => {
    if (!openCodeGoUsageAuthConfigured) {
      toast.error(t('settings.providers.page.toast.openCodeGoUsageAuthRequired'));
      return;
    }

    const busyKey = 'opencode-go-usage-refresh';
    setAuthBusyKey(busyKey);
    try {
      await fetchProviderQuota(OPENCODE_GO_PROVIDER_ID, { forceRefresh: true });
      const result = useQuotaStore.getState().results.find((entry) => entry.providerId === OPENCODE_GO_PROVIDER_ID);
      if (result && !result.ok) {
        throw new Error(result.error || t('settings.providers.page.toast.openCodeGoUsageRefreshFailed'));
      }
      toast.success(t('settings.providers.page.toast.openCodeGoUsageRefreshed'));
    } catch (error) {
      console.error('Failed to refresh OpenCode Go usage:', error);
      toast.error(error instanceof Error ? error.message : t('settings.providers.page.toast.openCodeGoUsageRefreshFailed'));
    } finally {
      setAuthBusyKey(null);
    }
  };
```

- [ ] **Step 5: Add the panel renderer and render it in both add and selected modes**

Add:

```tsx
  const renderOpenCodeGoUsageTracking = () => (
    <div className="space-y-2 border-t border-[var(--surface-subtle)] pt-3">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="typography-ui-label text-foreground">{t('settings.providers.page.auth.openCodeGoUsageTitle')}</div>
          <div className="typography-meta whitespace-pre-line text-muted-foreground">{t('settings.providers.page.auth.openCodeGoUsageDescription')}</div>
        </div>
        <span className={cn(
          'typography-micro shrink-0',
          openCodeGoUsageAuthConfigured ? 'text-[var(--status-success)]' : 'text-muted-foreground',
        )}>
          {openCodeGoUsageAuthLoading
            ? t('settings.providers.page.auth.openCodeGoUsageChecking')
            : openCodeGoUsageAuthConfigured
              ? t('settings.providers.page.auth.openCodeGoUsageConfigured')
              : t('settings.providers.page.auth.openCodeGoUsageNotConfigured')}
        </span>
      </div>
      <div className="grid gap-2 sm:grid-cols-[minmax(0,0.45fr)_minmax(0,0.55fr)]">
        <Input
          id={OPENCODE_GO_WORKSPACE_INPUT_ID}
          value={openCodeGoWorkspaceIdInput}
          onChange={(event) => setOpenCodeGoWorkspaceIdInput(event.target.value)}
          placeholder={t('settings.providers.page.auth.openCodeGoWorkspacePlaceholder')}
          className="font-mono text-xs"
          autoComplete="off"
        />
        <Input
          id={OPENCODE_GO_AUTH_COOKIE_INPUT_ID}
          type="password"
          value={openCodeGoAuthCookieInput}
          onChange={(event) => setOpenCodeGoAuthCookieInput(event.target.value)}
          placeholder={t('settings.providers.page.auth.openCodeGoAuthCookiePlaceholder')}
          className="font-mono text-xs"
          autoComplete="off"
        />
      </div>
      <div className="flex flex-wrap gap-1">
        <Button size="xs" className="!font-normal" onClick={handleSaveOpenCodeGoUsageAuth} disabled={authBusyKey === 'opencode-go-usage-save'}>
          {authBusyKey === 'opencode-go-usage-save' ? t('settings.providers.page.actions.saving') : t('settings.providers.page.actions.save')}
        </Button>
        <Button variant="outline" size="xs" className="!font-normal" onClick={handleClearOpenCodeGoUsageAuth} disabled={authBusyKey === 'opencode-go-usage-clear' || (!openCodeGoUsageAuthConfigured && !openCodeGoWorkspaceIdInput && !openCodeGoAuthCookieInput)}>
          {authBusyKey === 'opencode-go-usage-clear' ? t('settings.providers.page.actions.saving') : t('settings.providers.page.actions.clear')}
        </Button>
        <Button variant="outline" size="xs" className="!font-normal" onClick={handleRefreshOpenCodeGoUsage} disabled={authBusyKey === 'opencode-go-usage-refresh' || !openCodeGoUsageAuthConfigured}>
          {authBusyKey === 'opencode-go-usage-refresh' ? t('settings.providers.page.actions.refreshing') : t('settings.providers.page.actions.refreshUsage')}
        </Button>
      </div>
    </div>
  );
```

Render it anywhere the Cursor usage panel is rendered:

```tsx
                  {activeOpenCodeGoProviderId === candidateProviderId && renderOpenCodeGoUsageTracking()}
```

and:

```tsx
                {activeOpenCodeGoProviderId === selectedProvider.id && renderOpenCodeGoUsageTracking()}
```

- [ ] **Step 6: Add messages**

Add these keys to `packages/ui/src/lib/i18n/messages/en.settings.ts`:

```ts
  'settings.providers.page.auth.openCodeGoUsageChecking': 'Checking...',
  'settings.providers.page.auth.openCodeGoUsageConfigured': 'Usage credentials saved',
  'settings.providers.page.auth.openCodeGoUsageDescription': '1. Open opencode.ai and sign in.\n2. Open the Go workspace dashboard and copy the workspace ID from the URL: /workspace/wrk_.../go.\n3. In DevTools, copy the Value of the auth cookie for opencode.ai.',
  'settings.providers.page.auth.openCodeGoUsageNotConfigured': 'Usage credentials not saved',
  'settings.providers.page.auth.openCodeGoUsageTitle': 'OpenCode Go usage tracking',
  'settings.providers.page.auth.openCodeGoWorkspacePlaceholder': 'wrk_...',
  'settings.providers.page.auth.openCodeGoAuthCookiePlaceholder': 'auth cookie value',
  'settings.providers.page.toast.openCodeGoAuthCookieRequired': 'Paste the OpenCode Go auth cookie first',
  'settings.providers.page.toast.openCodeGoUsageAuthRequired': 'Save OpenCode Go usage credentials first',
  'settings.providers.page.toast.openCodeGoUsageClearFailed': 'Failed to clear OpenCode Go usage credentials',
  'settings.providers.page.toast.openCodeGoUsageCleared': 'OpenCode Go usage credentials cleared',
  'settings.providers.page.toast.openCodeGoUsageRefreshFailed': 'Failed to refresh OpenCode Go usage',
  'settings.providers.page.toast.openCodeGoUsageRefreshed': 'OpenCode Go usage refreshed',
  'settings.providers.page.toast.openCodeGoUsageSaveFailed': 'Failed to save OpenCode Go usage credentials',
  'settings.providers.page.toast.openCodeGoUsageSaved': 'OpenCode Go usage credentials saved',
  'settings.providers.page.toast.openCodeGoUsageStatusFailed': 'Failed to check OpenCode Go usage credentials',
  'settings.providers.page.toast.openCodeGoWorkspaceRequired': 'Enter a valid OpenCode Go workspace ID first',
```

- [ ] **Step 7: Run UI test**

Run:

```bash
bun run --cwd packages/ui test -- UsagePage.test.ts
```

Expected: the new source-level UI wiring test passes.

---

### Task 4: Restore The OpenCode Go Icon

**Files:**
- Modify: `packages/ui/src/hooks/useProviderLogo.ts`
- Test: `packages/ui/src/components/sections/usage/UsagePage.test.ts`

- [ ] **Step 1: Add failing logo regression test**

Add this test to `packages/ui/src/components/sections/usage/UsagePage.test.ts`:

```ts
  test('OpenCode Go uses the opencode-go logo id instead of the local gocode alias', () => {
    const source = readFileSync(join(rootDir, 'packages/ui/src/hooks/useProviderLogo.ts'), 'utf8');

    expect(source).not.toContain("['opencode-go', 'gocode']");
  });
```

- [ ] **Step 2: Run test and verify it fails**

Run:

```bash
bun run --cwd packages/ui test -- UsagePage.test.ts
```

Expected: the new test fails while the alias remains present.

- [ ] **Step 3: Remove the alias**

In `packages/ui/src/hooks/useProviderLogo.ts`, remove this line:

```ts
    ['opencode-go', 'gocode'],
```

This restores the previous resolution path for `opencode-go`: no local match, so `ProviderLogo` falls back to `https://models.dev/logos/opencode-go.svg`.

- [ ] **Step 4: Run logo test**

Run:

```bash
bun run --cwd packages/ui test -- UsagePage.test.ts
```

Expected: the logo regression test passes.

---

### Task 5: Validate End To End

**Files:**
- No new files.
- Validate all modified web, UI, surfaces.

- [ ] **Step 1: Run focused package tests**

Run:

```bash
bun run --cwd packages/web test -- server/lib/opencode/provider-routes.test.js server/lib/quota/providers/opencode-go.test.js
bun run --cwd packages/ui test -- UsagePage.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 2: Run affected validation**

Run:

```bash
bun run validate:affected
```

Expected: changed-file-aware lint/type/test validation passes for UI, web,.

- [ ] **Step 3: Manual runtime check**

Run the app:

```bash
bun run dev:web:full
```

Manual checks:

1. Open Settings → Providers → OpenCode Go.
2. Confirm the provider icon is the prior OpenCode Go logo, not the local `gocode.svg` icon.
3. Confirm the Usage tracking panel appears with Workspace ID and auth cookie inputs.
4. Save `wrk_abc123` plus a non-empty cookie and confirm the status changes to “Usage credentials saved”.
5. Open Settings → Usage → OpenCode Go and refresh. The old setup error should be gone once real credentials are supplied; invalid/stale cookies should show the dashboard authentication error instead.
6. Clear credentials and confirm the API key remains in `auth["opencode-go"].key` if it existed.

---

## Self-Review

- Spec coverage: The plan fixes the reported setup error by adding a UI/API path to save the credentials the quota provider already requires, and fixes the icon regression by reverting the v1.0.6 alias change.
- Cross-runtime parity: Web/Electron routes bridge/webview routes expose the same HTTP contract.
- Safety: Usage auth fields are stored under the existing `auth["opencode-go"]` object and clearing usage auth preserves API auth fields.
- Validation: Focused tests cover route behavior, UI wiring, and icon mapping, followed by `validate:affected`.
