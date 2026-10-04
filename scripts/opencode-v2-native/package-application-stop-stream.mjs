// Observe the production projected stream; retain only a bounded prefix in memory.
const prefix = '1. Synthetic cancellation case.';
const identity = value => typeof value === 'string' && /^[A-Za-z0-9_:-]{1,160}$/.test(value);
const failure = code => Object.assign(new Error(code), { code });

export async function openApplicationStopStream({ origin, headers, directory, sessionID, deadline, fetchImpl = fetch }) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), Math.max(1, deadline - Date.now()));
  let response;
  try {
    response = await fetchImpl(`${origin}/api/global/event`, { headers: { ...headers, 'x-devryan-subscription-ready': '1' }, signal: abort.signal });
    if (!response.ok || !response.body) throw failure('application_stop_stream_unavailable');
  } catch {
    clearTimeout(timer); abort.abort(); await response?.body?.cancel().catch(() => {});
    throw failure('application_stop_stream_unavailable');
  }
  let readyAt, streamFailure, closing = false, bytes = 0, blocks = 0;
  const parts = new Map(), terminal = new Set();
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const requireOpen = () => { if (Date.now() >= deadline) throw failure('application_stop_stream_deadline'); if (streamFailure) throw streamFailure; if (closing || !readyAt) throw failure('application_stop_stream_not_open'); };
  const consume = block => {
    const lines = block.split(/\r?\n/);
    const event = lines.find(line => line.startsWith('event:'))?.slice(6).trim();
    const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
    if (event === 'devryan.replay-gap') throw failure('application_stop_stream_gap');
    if (!data) return;
    let envelope;
    try { envelope = JSON.parse(data); } catch { throw failure('application_stop_stream_invalid'); }
    if (event === 'devryan.subscription-ready') {
      if (readyAt || lines.some(line => line.startsWith('id:')) || envelope?.type !== 'ready' || envelope.scope !== 'global') throw failure('application_stop_stream_invalid_ready');
      readyAt = Date.now(); clearTimeout(timer); resolveReady(); return;
    }
    if (!readyAt || envelope?.directory !== directory) return;
    const payload = envelope.payload, properties = payload?.properties;
    if (payload?.type === 'message.updated' && properties?.info?.sessionID === sessionID
      && properties.info.time?.completed && identity(properties.info.id)) {
      terminal.add(properties.info.id);
      if (terminal.size > 64) throw failure('application_stop_stream_record_limit');
    }
    if (payload?.type === 'message.part.updated') {
      const part = properties?.part;
      if (part?.sessionID !== sessionID || !identity(part.id) || !identity(part.messageID)) return;
      const prior = parts.get(part.id);
      if (prior && prior.messageID !== part.messageID) throw failure('application_stop_stream_identity_changed');
      if (!prior && parts.size >= 64) throw failure('application_stop_stream_record_limit');
      parts.set(part.id, { messageID: part.messageID, text: prior?.text ?? '', deltaCount: prior?.deltaCount ?? 0,
        deltaBytes: prior?.deltaBytes ?? 0, observedAt: prior?.observedAt,
        inactive: prior?.inactive === true || part.type !== 'text' || part.synthetic === true || part.time?.end !== undefined });
    }
    if (payload?.type === 'message.part.delta' && properties?.sessionID === sessionID && properties.field === 'text'
      && typeof properties.delta === 'string') {
      const part = parts.get(properties.partID);
      if (!part || part.inactive || terminal.has(part.messageID) || part.messageID !== properties.messageID) return;
      part.text = (part.text + properties.delta).slice(0, prefix.length);
      part.deltaBytes += Buffer.byteLength(properties.delta); part.deltaCount++;
      if (!part.observedAt && part.text === prefix) part.observedAt = Date.now();
    }
    if (payload?.type === 'message.part.removed' && properties?.sessionID === sessionID) {
      const part = parts.get(properties.partID); if (part && part.messageID === properties.messageID) part.inactive = true;
    }
  };
  const work = (async () => {
    const decoder = new TextDecoder(); let pending = '';
    for await (const chunk of response.body) {
      bytes += chunk.byteLength; pending += decoder.decode(chunk, { stream: true });
      if (bytes > 4 * 1024 * 1024 || Buffer.byteLength(pending) > 256 * 1024) throw failure('application_stop_stream_byte_limit');
      let boundary;
      while ((boundary = /\r?\n\r?\n/.exec(pending))) {
        const block = pending.slice(0, boundary.index); pending = pending.slice(boundary.index + boundary[0].length);
        if (++blocks > 4096) throw failure('application_stop_stream_frame_limit');
        consume(block);
      }
    }
    if (!closing) throw failure('application_stop_stream_ended');
  })().catch(error => {
    if (!closing) {
      streamFailure = typeof error?.code === 'string' && error.code.startsWith('application_stop_stream_') ? error : failure('application_stop_stream_failed');
      rejectReady(streamFailure);
    }
  });
  const close = async () => { closing = true; clearTimeout(timer); abort.abort(); await work; if (streamFailure) throw streamFailure; };
  try { await ready; requireOpen(); } catch (error) { await close().catch(() => {}); throw error; }
  return { close, requireOpen, witness(messageID, canonicalParts) {
    requireOpen();
    if (terminal.has(messageID)) return null;
    for (const canonical of canonicalParts ?? []) {
      const part = parts.get(canonical.id);
      if (canonical.type !== 'text' || canonical.synthetic === true || !part || part.inactive || part.messageID !== messageID || !part.observedAt) continue;
      return { source: 'production-global-event-text-delta', sessionID, messageID, partID: canonical.id,
        readyAt, observedAt: part.observedAt, deltaCount: part.deltaCount, deltaBytes: part.deltaBytes };
    }
    return null;
  } };
}
