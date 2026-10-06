import { randomUUID } from 'node:crypto';
import { nativeHelperInput, nativeHelperTitleInput } from './native-helper-contract.js';
import { readResponseBody } from '../opencode-client/envelope.js';

const fail = (code, status = 503) => Object.assign(new Error(code), { code, status, statusCode: status });
const abortable = async (work, signal) => {
  let onAbort;
  try {
    return await Promise.race([work, new Promise((_, reject) => {
      onAbort = () => reject(signal.reason);
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    })]);
  } finally { signal.removeEventListener('abort', onAbort); }
};

/** A bounded caller response never substitutes for provider settlement. */
export function createNativeHelperOwner({ admissionOwner, current, headers, fetchImpl = fetch,
  settlementTimeoutMs = 10000, cancellationTimeoutMs = 5000 }) {
  const pending = new Map();
  const operations = new Map();
  const owner = {
    assert: async ({ input, permit }) => {
      const entry = pending.get(permit?.token);
      if (!entry || entry.cancelled || entry.unsettled || current() !== entry.target) throw fail('native_helper_expired');
      return admissionOwner.assertHelperOperation(input, permit);
    },
    settled: ({ permit }) => {
      const entry = pending.get(permit?.token);
      if (!entry || !permit || typeof permit !== 'object' || Array.isArray(permit)
        || Object.keys(permit).length !== Object.keys(entry.permit).length
        || Object.keys(permit).some(key => !Object.hasOwn(entry.permit, key))
        || entry.permit.token !== permit.token || entry.permit.sessionID !== permit.sessionID
        || entry.permit.revision !== permit.revision) throw fail('native_helper_expired');
      entry.resolve();
      return null;
    },
    // Called only after this controller and its execution workers have exited.
    controllerSettled: async instanceID => {
      if (typeof instanceID !== 'string' || !instanceID) throw fail('native_helper_controller_invalid');
      const entries = [...operations.values()].filter(entry => entry.target?.instanceID === instanceID);
      for (const entry of entries) {
        entry.exited = true;
        entry.abort.abort(fail('native_helper_controller_exited'));
        entry.resolve();
      }
      await Promise.all(entries.map(entry => entry.work));
    },
    stopProvider: async providerID => {
      const entries = [...operations.values()].filter(entry => entry.providerID === providerID);
      for (const entry of entries) { entry.cancelled = true; entry.abort.abort(fail('native_helper_provider_signed_out')); }
      let timer;
      try {
        await Promise.race([Promise.all(entries.map(entry => entry.work)), new Promise((_, reject) => {
          timer = setTimeout(() => reject(fail('native_helper_unsettled')), cancellationTimeoutMs + settlementTimeoutMs);
        })]);
      } finally { clearTimeout(timer); }
    },
    generate: async (request, titleOperation = false) => {
      const { signal: callerSignal, ...body } = request;
      const input = (titleOperation ? nativeHelperTitleInput : nativeHelperInput)({ ...body, operationID: body.operationID ?? randomUUID() });
      callerSignal?.throwIfAborted();
      if (operations.has(input.operationID)) throw fail('native_helper_operation_pending', 409);
      if ([...operations.values()].filter(entry => entry.unsettled).length >= 4) throw fail('native_helper_unsettled');
      let resolveVisible, rejectVisible;
      const visible = new Promise((resolve, reject) => { resolveVisible = resolve; rejectVisible = reject; });
      const entry = { providerID: input.providerID, abort: new AbortController(), unsettled: false, cancelled: false, exited: false };
      operations.set(input.operationID, entry);
      // Keep the admission callback alive until ACK/exit, even after visible rejects.
      const work = Promise.resolve().then(() => (titleOperation ? admissionOwner.withHelperTitleOperation : admissionOwner.withHelperOperation)(input, async permit => {
        entry.abort.signal.throwIfAborted(); // No dispatch means there is no provider ACK to wait for.
        entry.target = current();
        entry.permit = permit;
        const settled = new Promise(resolve => { entry.resolve = resolve; });
        pending.set(permit.token, entry);
        const signals = [entry.abort.signal, AbortSignal.timeout(input.timeoutMs ?? 30000)];
        if (callerSignal) signals.push(callerSignal);
        const signal = AbortSignal.any(signals);
        let failure, result;
        try {
          const response = await abortable(Promise.resolve().then(() => { signal.throwIfAborted(); return fetchImpl(`${entry.target.url}${titleOperation ? '/devryan/helper-title' : '/devryan/helper-text'}`, {
            method: 'POST', headers: { ...headers(), 'content-type': 'application/json' }, body: JSON.stringify(input), signal,
          }); }), signal);
          const payload = await abortable(readResponseBody(response, { signal, maxResponseBytes: 524288 }), signal);
          if (!response.ok || !payload.parsed || typeof payload.value?.[titleOperation ? 'title' : 'text'] !== 'string') {
            throw fail(typeof payload.value?.code === 'string' ? payload.value.code : 'native_helper_failed', response.ok ? 503 : response.status);
          }
          result = titleOperation ? { title: payload.value.title } : { text: payload.value.text };
        } catch (error) { failure = error; }
        try {
          if (failure && !entry.exited) {
            entry.cancelled = true;
            // Request cancellation while the real permit remains in this context.
            const cancelSignal = AbortSignal.timeout(cancellationTimeoutMs);
            try {
              await abortable(Promise.resolve().then(() => {
                if (current() !== entry.target) throw fail('native_helper_expired');
                return fetchImpl(`${entry.target.url}/devryan/helper-text/cancel`, {
                  method: 'POST', headers: headers(), signal: cancelSignal,
                });
              }), cancelSignal);
            } catch { /* Only ACK/exit can release the permit. */ }
          }
          let timer;
          const confirmed = await Promise.race([settled.then(() => true), new Promise(resolve => {
            timer = setTimeout(() => resolve(false), settlementTimeoutMs);
          })]);
          clearTimeout(timer);
          if (!confirmed) {
            entry.unsettled = true;
            entry.cancelled = true;
            rejectVisible(fail('native_helper_unsettled'));
            await settled;
          }
          if (entry.unsettled) return undefined;
          if (entry.exited) throw fail('native_helper_controller_exited');
          if (failure) throw failure;
          callerSignal?.throwIfAborted();
          if (!titleOperation) await admissionOwner.assertHelperOperation(input, permit);
          return result;
        } finally { pending.delete(permit.token); }
      }));
      entry.work = Promise.resolve(work).then(result => {
        operations.delete(input.operationID);
        if (!entry.unsettled) resolveVisible(result);
      }, error => {
        operations.delete(input.operationID);
        rejectVisible(error);
      });
      return visible;
    },
  };
  return owner;
}
