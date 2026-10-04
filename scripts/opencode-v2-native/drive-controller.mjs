// The public OpenCode Drive protocol controls model output only. Native tools
// remain in the product registry; this controller never calls tool.attach.
export const attachDriveController = async (endpoint, responder, options = {}) => {
  const { timeoutMs = 30_000, maxRequests = 512, connect = url => new WebSocket(url) } = options;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(maxRequests) || maxRequests <= 0) {
    throw new TypeError('Invalid Drive bounds');
  }
  const url = new URL(endpoint);
  if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1') throw new TypeError('Drive endpoint must be loopback');
  const socket = connect(endpoint);
  const waiting = new Map();
  const requests = [];
  const active = new Set();
  let nextID = 1;
  let currentResponder = responder;
  let failure;
  let closed = false;
  const rejectPending = error => {
    for (const pending of waiting.values()) { clearTimeout(pending.timer); pending.reject(error); }
    waiting.clear();
  };
  const fail = error => {
    failure ??= error instanceof Error ? error : new Error(String(error));
    rejectPending(failure);
    socket.close();
  };
  const check = () => { if (failure) throw failure; if (closed) throw new Error('Drive closed'); };
  const call = (method, params) => {
    check();
    const id = nextID++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => fail(new Error(`Drive RPC timed out: ${method}`)), timeoutMs);
      waiting.set(id, { resolve, reject, timer, method });
      try { socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })); }
      catch (error) { fail(error); }
    });
  };
  const reply = async request => {
    const response = await Promise.race([
      Promise.resolve().then(() => currentResponder(request)),
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error('Drive responder timed out')), timeoutMs);
        // Keep the timer scoped to this reply, including rejection.
        activeTimers.set(request.id, timer);
        activeAborts.set(request.id, reject);
      }),
    ]).finally(() => { clearTimeout(activeTimers.get(request.id)); activeTimers.delete(request.id); activeAborts.delete(request.id); });
    check();
    if (!response || !Array.isArray(response.items) || !['stop', 'tool-calls', 'length', 'content-filter'].includes(response.reason)) {
      throw new TypeError('Malformed Drive response');
    }
    if (response.items.length) await call('llm.chunk', { id: request.id, items: response.items });
    await call('llm.finish', { id: request.id, reason: response.reason });
  };
  const activeTimers = new Map();
  const activeAborts = new Map();
  socket.addEventListener('message', event => {
    try {
      const message = JSON.parse(String(event.data));
      if (!message || message.jsonrpc !== '2.0') throw new TypeError('Malformed Drive packet');
      if (message.id !== undefined) {
        const pending = waiting.get(message.id);
        if (!pending) throw new Error('Unexpected Drive response identity');
        if (!message.error && !Object.hasOwn(message, 'result')) throw new TypeError('Missing Drive RPC result');
        waiting.delete(message.id); clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(`Drive ${pending.method}: ${message.error.message}`));
        else if (Object.hasOwn(message, 'result')) pending.resolve(message.result);
        return;
      }
      const request = message.params;
      if (message.method !== 'llm.request' || !request || typeof request.id !== 'string' || typeof request.url !== 'string'
        || !Object.hasOwn(request, 'body') || requests.some(previous => previous.id === request.id)) {
        throw new TypeError('Malformed or duplicate Drive invocation');
      }
      if (requests.length >= maxRequests) throw new Error('Drive request bound exceeded');
      requests.push(request);
      const work = reply(request).catch(error => { if (!closed) fail(error); }).finally(() => active.delete(work));
      active.add(work);
    } catch (error) { fail(error); }
  });
  socket.addEventListener('error', () => fail(new Error('Drive WebSocket failed')));
  socket.addEventListener('close', () => {
    closed = true;
    rejectPending(failure ?? new Error('Drive WebSocket closed'));
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { const error = new Error('Drive connect timed out'); fail(error); reject(error); }, timeoutMs);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(failure); }, { once: true });
      socket.addEventListener('close', () => { clearTimeout(timer); reject(failure ?? new Error('Drive closed before open')); }, { once: true });
    });
    const handshake = await call('simulation.handshake', {
      client: { name: 'devryan-native-acceptance', version: '1' }, expectedRole: 'backend', offeredVersions: [1],
      requiredCapabilities: ['llm.attach', 'llm.request', 'llm.chunk', 'llm.finish', 'llm.disconnect'], optionalCapabilities: [],
    });
    const required = ['llm.attach', 'llm.request', 'llm.chunk', 'llm.finish', 'llm.disconnect'];
    if (handshake?.protocolVersion !== 1 || handshake?.role !== 'backend'
      || !Array.isArray(handshake.capabilities) || !required.every(value => handshake.capabilities.includes(value))) {
      throw new Error('Drive handshake contract mismatch');
    }
    await call('llm.attach');
    return {
      requests, check,
      setResponder: async next => { check(); await Promise.all(active); check(); currentResponder = next; },
      disconnect: id => call('llm.disconnect', { id }),
      close: async () => {
        if (!closed) { closed = true; rejectPending(new Error('Drive closed')); socket.close(); }
        for (const abort of activeAborts.values()) abort(new Error('Drive closed'));
        await Promise.allSettled(active);
        if (failure) throw failure;
      },
    };
  } catch (error) { fail(error); throw error; }
};
