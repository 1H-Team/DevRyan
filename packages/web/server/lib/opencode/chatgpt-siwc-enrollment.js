import { credentialMutationFingerprint } from './runtime-host/native-credential-mutation-owner.js';
import http from 'node:http';
import crypto from 'node:crypto';
import {
  CHATGPT_SIWC_AGENT_NAME,
  CHATGPT_SIWC_CALLBACK_PATH,
  CHATGPT_SIWC_DYNAMIC_CLIENT_ID,
  CHATGPT_SIWC_METHOD_ID,
  buildSiwcAuthorizeUrl,
  buildSiwcCredentialValue,
  createOAuthNonce,
  createPkcePair,
  exchangeSiwcAuthorizationCode,
  failSiwc,
  hasSiwcPlanUsage,
  parseScopeList,
  readOrCreateSiwcHostId,
  readSiwcRegistrations,
  verifySiwcIdToken,
  writeSiwcRegistrations,
} from './chatgpt-siwc.js';

const SUCCESS_HTML = `<!doctype html><html><body style="font-family:system-ui;padding:2rem"><h1>Signed in with ChatGPT</h1><p>You can return to DevRyan.</p><script>window.close()</script></body></html>`;
const FAILURE_HTML = `<!doctype html><html><body style="font-family:system-ui;padding:2rem"><h1>Sign-in failed</h1><p>Return to DevRyan and try again.</p></body></html>`;

/**
 * DevRyan-owned Sign in with ChatGPT enrollment.
 * Loopback receives the OAuth callback; credentials are persisted through
 * the injected native OpenAI credential owner.
 */
export function createChatgptSiwcEnrollmentOwner({
  dataDirectory,
  persistCredential,
  readConnected,
  disconnectCredential,
  readRegistrationCredential,
  selectCredential,
  removeCredential,
  jwksImpl,
  fetchImpl = fetch,
  now = Date.now,
  createServer = http.createServer,
  listenHost = '127.0.0.1',
}) {
  if (typeof dataDirectory !== 'string' || !dataDirectory || typeof persistCredential !== 'function') {
    throw failSiwc('native_chatgpt_siwc_owner_required', 503);
  }
  const pending = new Map();
  const completingRegistrations = new Set();
  let closed = false;

  const live = () => {
    if (closed) throw failSiwc('native_chatgpt_siwc_owner_closed', 409);
  };

  const hostId = () => readOrCreateSiwcHostId(dataDirectory);

  const registrationFor = (registrationRef) => {
    const accounts = readSiwcRegistrations(dataDirectory).accounts;
    return accounts.find((row) => row.registrationRef === registrationRef) ?? null;
  };

  const upsertRegistration = (account) => {
    const current = readSiwcRegistrations(dataDirectory);
    const accounts = current.accounts.filter((row) => row.registrationRef !== account.registrationRef);
    if (accounts.length >= 64) throw failSiwc('native_chatgpt_siwc_capacity', 409);
    accounts.push(account);
    writeSiwcRegistrations(dataDirectory, { accounts });
  };

  const closeLoopback = (attempt) => {
    if (!attempt) return;
    try { attempt.server?.close(); } catch { /* ignore */ }
    attempt.server = null;
  };

  const forgetAttempt = (attempt) => {
    if (!attempt) return;
    attempt.aborted = true;
    closeLoopback(attempt);
    attempt.resolve?.(attempt);
    if (pending.get(attempt.id) === attempt) pending.delete(attempt.id);
  };

  const settleHtml = (res, ok) => {
    const body = ok ? SUCCESS_HTML : FAILURE_HTML;
    res.writeHead(ok ? 200 : 400, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
    });
    res.end(body);
  };

  const begin = async (context = {}) => {
    live();
    const id = crypto.randomUUID();
    const pkce = createPkcePair();
    const state = createOAuthNonce();
    const nonce = createOAuthNonce();
    if (pending.size >= 64) throw failSiwc('native_chatgpt_siwc_capacity');
    const connected = typeof readConnected === 'function' ? await readConnected(context) : null;
    if (context.expectedActiveCredentialID !== undefined && context.expectedActiveCredentialID !== (connected?.credentialID ?? null)) throw failSiwc('native_chatgpt_siwc_selection_changed');
    const existing = context.registrationRef ? registrationFor(context.registrationRef) : null;
    if (context.registrationRef && !existing) throw failSiwc('native_chatgpt_siwc_registration_missing', 404);
    if (existing && completingRegistrations.has(existing.registrationRef)) throw failSiwc('native_chatgpt_siwc_attempt_pending');
    if (existing?.stagedCredentialID) {
      const staged = await readRegistrationCredential({ directory: context.directory, registration: { ...existing, credentialID: existing.stagedCredentialID } });
      if (staged && connected?.credentialID === existing.stagedCredentialID) {
        if (existing.credentialID && existing.credentialID !== existing.stagedCredentialID) {
          const previous = await readRegistrationCredential({ directory: context.directory, registration: existing });
          if (previous) await removeCredential({ directory: context.directory, credentialID: previous.id, expectedFingerprint: previous.expectedFingerprint, requireInactive: true });
        }
        existing.credentialID = existing.stagedCredentialID;
      }
      else if (staged) await removeCredential({ directory: context.directory, credentialID: existing.stagedCredentialID, expectedFingerprint: staged.expectedFingerprint, requireInactive: true });
      delete existing.stagedCredentialID;
      upsertRegistration(existing);
    }
    const previousCredential = existing && typeof readRegistrationCredential === 'function' ? await readRegistrationCredential({ directory: context.directory, registration: existing }) : null;
    const clientId = existing?.clientId || CHATGPT_SIWC_DYNAMIC_CLIENT_ID;
    const attempt = {
      id,
      registration: existing,
      registrationFingerprint: existing ? credentialMutationFingerprint(existing) : null,
      previousCredential,
      expectedActiveCredentialID: connected?.credentialID ?? null,
      expectedActiveFingerprint: connected?.fingerprint ?? credentialMutationFingerprint(null),
      directory: context.directory,
      state,
      nonce,
      verifier: pkce.verifier,
      clientId,
      hostId: hostId(),
      redirectUri: null,
      server: null,
      result: null,
      error: null,
      done: null,
      aborted: false,
      createdAt: now(),
    };
    attempt.done = new Promise((resolve) => { attempt.resolve = resolve; });

    const server = createServer((req, res) => {
      void (async () => {
        try {
          if (attempt.aborted || closed) { settleHtml(res, false); return; }
          const url = new URL(req.url || '/', `http://${listenHost}`);
          if (req.method !== 'GET' || url.pathname !== CHATGPT_SIWC_CALLBACK_PATH) {
            res.writeHead(404).end();
            return;
          }
          if (url.searchParams.get('state') !== attempt.state || attempt.callbackStarted) { settleHtml(res, false); return; }
          attempt.callbackStarted = true;
          if (url.searchParams.get('error')) {
            attempt.error = failSiwc(
              url.searchParams.get('error') === 'access_denied'
                ? 'native_chatgpt_siwc_access_denied'
                : 'native_chatgpt_siwc_authorize_failed',
              400,
            );
            closeLoopback(attempt);
            attempt.resolve?.(attempt);
            settleHtml(res, false);
            return;
          }
          const code = url.searchParams.get('code');
          const returnedState = url.searchParams.get('state');
          const issuedClientId = url.searchParams.get('client_id');
          if (!code || returnedState !== attempt.state) {
            attempt.error = failSiwc('native_chatgpt_siwc_callback_invalid', 400);
            settleHtml(res, false);
            closeLoopback(attempt);
            attempt.resolve?.(attempt);
            return;
          }
          const exchangeClientId = issuedClientId || attempt.clientId;
          if (attempt.clientId !== CHATGPT_SIWC_DYNAMIC_CLIENT_ID) {
            if (issuedClientId && issuedClientId !== attempt.clientId) {
              attempt.error = failSiwc('native_chatgpt_siwc_client_mismatch', 400);
              settleHtml(res, false);
              closeLoopback(attempt);
              attempt.resolve?.(attempt);
              return;
            }
          } else if (!issuedClientId || issuedClientId === CHATGPT_SIWC_DYNAMIC_CLIENT_ID) {
            attempt.error = failSiwc('native_chatgpt_siwc_registration_incomplete', 400);
            settleHtml(res, false);
            closeLoopback(attempt);
            attempt.resolve?.(attempt);
            return;
          }
          const tokens = await exchangeSiwcAuthorizationCode({
            clientId: exchangeClientId,
            code,
            codeVerifier: attempt.verifier,
            redirectUri: attempt.redirectUri,
            fetchImpl,
          });
          const identity = await verifySiwcIdToken(tokens.id_token, {
            audience: exchangeClientId,
            nonce: attempt.nonce,
            ...(jwksImpl ? { jwksImpl } : {}),
          });
          if (attempt.registration && identity.sub !== attempt.registration.subject) throw failSiwc('native_chatgpt_siwc_identity_mismatch', 400);
          const scopes = parseScopeList(tokens.scope);
          const email = typeof identity.email === 'string' ? identity.email : undefined;
          const value = buildSiwcCredentialValue({
            access: tokens.access_token,
            refresh: tokens.refresh_token,
            expires: now() + tokens.expires_in * 1000,
            clientId: exchangeClientId,
            idToken: tokens.id_token,
            scopes,
            subject: identity.sub,
            email,
            hostId: attempt.hostId,
          });
          attempt.result = {
            value,
            subject: identity.sub,
            email,
            clientId: exchangeClientId,
            scopes,
            idToken: tokens.id_token,
          };
          settleHtml(res, true);
          closeLoopback(attempt);
          attempt.resolve?.(attempt);
        } catch (error) {
          attempt.error = error?.code?.startsWith?.('native_chatgpt_siwc_')
            ? error
            : failSiwc('native_chatgpt_siwc_exchange_failed', 503);
          try { settleHtml(res, false); } catch { /* ignore */ }
          closeLoopback(attempt);
          attempt.resolve?.(attempt);
        }
      })();
    });
    attempt.server = server;

    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, listenHost, () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === 'string' || !address.port) {
      forgetAttempt(attempt);
      throw failSiwc('native_chatgpt_siwc_loopback_failed', 503);
    }
    attempt.redirectUri = `http://${listenHost}:${address.port}${CHATGPT_SIWC_CALLBACK_PATH}`;
    const url = buildSiwcAuthorizeUrl({
      clientId,
      redirectUri: attempt.redirectUri,
      state,
      nonce,
      codeChallenge: pkce.challenge,
      hostId: attempt.hostId,
      agentNameHint: clientId === CHATGPT_SIWC_DYNAMIC_CLIENT_ID ? CHATGPT_SIWC_AGENT_NAME : undefined,
      idTokenHint: previousCredential?.value?.metadata?.idToken,
      loginHint: existing?.email,
    });
    pending.set(id, attempt);
    return { enrollmentID: id, status: 'pending', url, methodID: CHATGPT_SIWC_METHOD_ID };
  };

  const assertAttempt = (target, context, validateRegistration = true) => {
    live();
    if (target.aborted || pending.get(target.id) !== target || context.directory !== target.directory) throw failSiwc('native_chatgpt_siwc_attempt_stale');
    if (validateRegistration && target.registration && credentialMutationFingerprint(registrationFor(target.registration.registrationRef)) !== target.registrationFingerprint) throw failSiwc('native_chatgpt_siwc_registration_changed');
  };

  const complete = async (id, _body, context = {}) => {
    live();
    const target = pending.get(id);
    if (!target) throw failSiwc('native_chatgpt_siwc_attempt_missing', 404);
    assertAttempt(target, context);
    if (target.completing) throw failSiwc('native_chatgpt_siwc_attempt_pending');
    const claimedRegistration = target.registration?.registrationRef;
    if (claimedRegistration && completingRegistrations.has(claimedRegistration)) throw failSiwc('native_chatgpt_siwc_attempt_pending');
    if (claimedRegistration) completingRegistrations.add(claimedRegistration);
    target.completing = true;
    let timer, saved, registrationRef, staged = false, activated = false;
    try {
      await Promise.race([target.done, new Promise((_, reject) => {
        timer = setTimeout(() => reject(failSiwc('native_chatgpt_siwc_timeout', 408)), Math.max(1, 300_000 - (now() - target.createdAt)));
        timer.unref?.();
      })]);
      assertAttempt(target, context);
      if (target.error) throw target.error;
      if (!target.result) throw failSiwc('native_chatgpt_siwc_incomplete');
      const { value, subject, email, clientId, scopes } = target.result;
      registrationRef = target.registration?.registrationRef ?? crypto.randomUUID();
      if (!target.registration && readSiwcRegistrations(dataDirectory).accounts.length >= 64) throw failSiwc('native_chatgpt_siwc_capacity');
      const assertCurrent = () => assertAttempt(target, context);
      saved = await persistCredential({ directory: target.directory, value,
        expectedActiveFingerprint: target.expectedActiveFingerprint, assertCurrent });
      if (!saved?.credentialID || !saved.expectedFingerprint) throw failSiwc('native_chatgpt_siwc_credential_missing');
      assertCurrent();
      upsertRegistration({ ...target.registration, registrationRef, subject, email, clientId,
        credentialID: target.registration?.credentialID ?? null, stagedCredentialID: saved.credentialID });
      staged = true;
      if (target.registration) target.registrationFingerprint = credentialMutationFingerprint(registrationFor(registrationRef));
      // Enrollment stages an inactive record first. Only this captured selection
      // can activate it; a lost CAS leaves the staged registration recoverable.
      if (typeof selectCredential !== 'function') throw failSiwc('native_chatgpt_siwc_update_required');
      await selectCredential({ directory: target.directory, ...saved, expectedActiveFingerprint: target.expectedActiveFingerprint, assertCurrent });
      activated = true;
      assertCurrent();
      if (target.previousCredential && target.previousCredential.id !== saved.credentialID && typeof removeCredential === 'function') {
        await removeCredential({ directory: target.directory, credentialID: target.previousCredential.id, expectedFingerprint: target.previousCredential.expectedFingerprint, requireInactive: true });
      }
      upsertRegistration({ registrationRef, subject, email, clientId, credentialID: saved.credentialID, savedAt: new Date(now()).toISOString() });
      return { enrollmentID: id, status: 'enrolled', methodID: CHATGPT_SIWC_METHOD_ID,
        email: email ?? null, planUsage: hasSiwcPlanUsage(scopes), credentialID: saved.credentialID, registrationRef };
    } catch (error) {
      if (saved && !activated && typeof removeCredential === 'function') {
        try {
          await removeCredential({ directory: target.directory, ...saved, requireInactive: true });
          if (staged) {
            const current = readSiwcRegistrations(dataDirectory);
            writeSiwcRegistrations(dataDirectory, { accounts: target.registration
              ? current.accounts.map(row => row.registrationRef === registrationRef && row.stagedCredentialID === saved.credentialID ? target.registration : row)
              : current.accounts.filter(row => row.registrationRef !== registrationRef || row.stagedCredentialID !== saved.credentialID) });
          }
        } catch { throw Object.assign(failSiwc('native_chatgpt_siwc_cleanup_failed', 503), { localCleanup: 'failed' }); }
      }
      if (activated) throw Object.assign(failSiwc('native_chatgpt_siwc_registration_cleanup_required', 503), { credentialID: saved.credentialID, registrationRef });
      throw error;
    } finally {
      if (claimedRegistration) completingRegistrations.delete(claimedRegistration);
      clearTimeout(timer);
      forgetAttempt(target);
    }
  };

  const select = async (registrationRef, context = {}) => {
    live();
    const registration = registrationFor(registrationRef);
    if (!registration || !registration.credentialID) throw failSiwc('native_chatgpt_siwc_registration_missing', 404);
    const connected = typeof readConnected === 'function' ? await readConnected(context) : null;
    if (context.expectedActiveCredentialID !== (connected?.credentialID ?? null)) throw failSiwc('native_chatgpt_siwc_selection_changed');
    const row = await readRegistrationCredential({ directory: context.directory, registration });
    if (!row) throw failSiwc('native_chatgpt_siwc_reauthorization_required');
    await selectCredential({ directory: context.directory, credentialID: registration.credentialID,
      expectedFingerprint: row.expectedFingerprint, expectedActiveFingerprint: connected?.fingerprint ?? credentialMutationFingerprint(null), assertCurrent: live });
    return { success: true, registrationRef };
  };

  const cancel = async (id, context = {}) => {
    const target = pending.get(id);
    if (!target) return { success: true };
    assertAttempt(target, context, false);
    forgetAttempt(target);
    return { success: true };
  };

  const status = async (context = {}) => {
    live();
    const connected = typeof readConnected === 'function'
      ? await readConnected({ directory: context.directory })
      : null;
    const registrations = readSiwcRegistrations(dataDirectory).accounts.map((row) => ({
      registrationRef: row.registrationRef,
      label: `${row.email ?? 'ChatGPT account'} · ${row.registrationRef.slice(0, 8)}`,
      email: row.email ?? null,
      credentialID: row.credentialID ?? row.stagedCredentialID ?? null,
      active: [row.credentialID, row.stagedCredentialID].includes(connected?.credentialID) && connected?.credentialID !== undefined,
      cleanupRequired: Boolean(row.stagedCredentialID),
    }));
    return {
      methodID: CHATGPT_SIWC_METHOD_ID,
      hostId: hostId(),
      connected: connected
        ? {
          credentialID: connected.credentialID ?? null,
          methodID: connected.methodID ?? null,
          email: connected.email ?? null,
          planUsage: Boolean(connected.planUsage),
          legacy: Boolean(connected.legacy),
        }
        : null,
      registrations,
    };
  };

  const disconnect = async (context = {}) => {
    live();
    if (typeof disconnectCredential === 'function') {
      const result = await disconnectCredential({ directory: context.directory, expectedActiveCredentialID: context.expectedActiveCredentialID });
      if (result.localCleanup === 'complete') {
        const current = readSiwcRegistrations(dataDirectory);
        writeSiwcRegistrations(dataDirectory, { accounts: current.accounts.map(row => row.credentialID === context.expectedActiveCredentialID || row.stagedCredentialID === context.expectedActiveCredentialID ? { ...row, credentialID: row.credentialID === context.expectedActiveCredentialID ? null : row.credentialID, ...(row.stagedCredentialID === context.expectedActiveCredentialID ? { stagedCredentialID: undefined } : {}) } : row) });
      }
      return result;
    }
    return { success: true };
  };

  const close = async () => {
    closed = true;
    for (const attempt of [...pending.values()]) forgetAttempt(attempt);
  };

  return Object.freeze({ begin, complete, status, select, cancel, disconnect, close });
}
