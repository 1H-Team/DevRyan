// The driver's HTTP client (BH2; design file 31 §3 "HTTP client in the
// harness", §5.3 step 2): one exchange on its own loopback connection, with the
// request bytes written exactly as the scenario gives them and the response
// read to its end. It is the same for every arm, so the arms are seen from the
// same vantage. Nothing is decoded but the transfer coding: the body is the
// bytes the arm sent (a compressed body stays compressed).
//
// A request is `{ method, target, headers: [[name, value], ...], body: Buffer | null }`.
// The client adds, in this order and only when the scenario did not give
// them, `Host`, `Connection: close` and `Content-Length` (when there is a body).
// Every wait has a deadline that names the exchange.
import net from 'node:net';
import { DeadlineError } from './tree.mjs';

export const HTTP_LIMITS = Object.freeze({ exchangeMs: 120_000, connectMs: 60_000 });
// One counter for every wire event of this process: `sentOrder` (the request handed to the socket) and
// `firstByteOrder` (the first response byte read) say in what order things happened, with no clock.
let wireEvents = 0;

const has = (headers, name) => headers.some(([key]) => key.toLowerCase() === name);
/** The request's bytes, as the arm receives them. */
export function encodeRequest({ method, target, headers = [], body = null }, port) {
  const lines = [`${method} ${target} HTTP/1.1`];
  const all = [...headers];
  if (!has(all, 'host')) all.unshift(['Host', `127.0.0.1:${port}`]);
  if (!has(all, 'connection')) all.push(['Connection', 'close']);
  if (body && !has(all, 'content-length') && !has(all, 'transfer-encoding')) all.push(['Content-Length', String(body.length)]);
  for (const [name, value] of all) lines.push(`${name}: ${value}`);
  const head = Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'latin1');
  return { bytes: body ? Buffer.concat([head, body]) : head, headers: all };
}

/**
 * An incremental HTTP/1.1 response reader: the head (interim 1xx answers are
 * kept apart), then the body by Content-Length, chunked coding or the end of
 * the connection. `onBody(bytes)` sees each decoded piece as it arrives.
 */
class ResponseReader {
  constructor({ method, onHead = () => {}, onBody = () => {} }) {
    this.method = method; this.onHead = onHead; this.onBody = onBody;
    this.buffer = Buffer.alloc(0); this.state = 'head'; this.interim = []; this.head = null; this.body = []; this.complete = false; this.trailers = null;
  }
  feed(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.state === 'head') {
        const at = this.buffer.indexOf('\r\n\r\n');
        if (at < 0) return;
        const text = this.buffer.subarray(0, at).toString('latin1');
        this.buffer = this.buffer.subarray(at + 4);
        const [statusLine, ...rest] = text.split('\r\n');
        const match = /^HTTP\/(\d\.\d) (\d{3})(?: (.*))?$/.exec(statusLine);
        if (!match) throw new Error(`not an HTTP response: ${JSON.stringify(statusLine.slice(0, 80))}`);
        const headers = rest.map((line) => { const colon = line.indexOf(':'); return [line.slice(0, colon), line.slice(colon + 1).trim()]; });
        const status = Number(match[2]);
        if (status >= 100 && status < 200 && status !== 101) { this.interim.push({ status, headers }); continue; }
        this.head = { httpVersion: match[1], status, reason: match[3] ?? '', headers, raw: text };
        const value = (name) => headers.find(([key]) => key.toLowerCase() === name)?.[1];
        if (this.method === 'HEAD' || status === 204 || status === 304) { this.state = 'done'; this.complete = true; }
        else if (/\bchunked\b/i.test(value('transfer-encoding') ?? '')) this.state = 'chunk-size';
        else if (value('content-length') !== undefined) { this.remaining = Number(value('content-length')); this.state = this.remaining === 0 ? 'done' : 'length'; if (this.remaining === 0) this.complete = true; }
        else this.state = 'close';
        this.onHead(this.head);
        continue;
      }
      if (this.state === 'length') {
        if (!this.buffer.length) return;
        const piece = this.buffer.subarray(0, this.remaining);
        this.buffer = this.buffer.subarray(piece.length);
        this.remaining -= piece.length;
        this.take(piece);
        if (this.remaining === 0) { this.state = 'done'; this.complete = true; }
        continue;
      }
      if (this.state === 'chunk-size') {
        const at = this.buffer.indexOf('\r\n');
        if (at < 0) return;
        const size = Number.parseInt(this.buffer.subarray(0, at).toString('latin1').split(';')[0], 16);
        if (!Number.isInteger(size)) throw new Error('a malformed chunk size');
        this.buffer = this.buffer.subarray(at + 2);
        if (size === 0) { this.state = 'trailers'; continue; }
        this.remaining = size; this.state = 'chunk';
        continue;
      }
      if (this.state === 'chunk') {
        if (this.buffer.length < this.remaining + 2) {
          if (this.buffer.length > 0 && this.buffer.length <= this.remaining) { const piece = this.buffer; this.buffer = Buffer.alloc(0); this.remaining -= piece.length; this.take(piece); }
          return;
        }
        const piece = this.buffer.subarray(0, this.remaining);
        this.buffer = this.buffer.subarray(this.remaining + 2);
        this.take(piece);
        this.state = 'chunk-size';
        continue;
      }
      if (this.state === 'trailers') {
        const at = this.buffer.indexOf('\r\n');
        if (at < 0) return;
        const line = this.buffer.subarray(0, at).toString('latin1');
        this.buffer = this.buffer.subarray(at + 2);
        if (line === '') { this.state = 'done'; this.complete = true; continue; }
        (this.trailers ??= []).push(line);
        continue;
      }
      if (this.state === 'close') { if (this.buffer.length) { const piece = this.buffer; this.buffer = Buffer.alloc(0); this.take(piece); } return; }
      // done: anything more is bytes after the response (kept, never body)
      return;
    }
  }
  take(piece) { if (piece.length) { this.body.push(Buffer.from(piece)); this.onBody(piece); } }
  /** The connection ended: a close-delimited body is complete now. */
  ended() { if (this.state === 'close') { this.state = 'done'; this.complete = true; } }
}

/**
 * Opens one exchange: connects (resolving `connected` with the local port),
 * then `send()` writes the request; `done` resolves with the result once the
 * response is complete and the connection closed, or the deadline passed
 * (`error` names it). Hooks: `onSent` after the request bytes are written,
 * `onHead(head)` when the status line and headers arrived, `onBody(bytes)`.
 */
export function openExchange(port, request, { deadlineMs = HTTP_LIMITS.exchangeMs, onSent = () => {}, onHead = () => {}, onBody = () => {} } = {}) {
  const encoded = encodeRequest(request, port);
  const socket = net.connect({ host: '127.0.0.1', port });
  const chunks = [];
  let t0 = null;
  let t1 = null;
  let error = null;
  let localPort = null;
  let sentOrder = null;
  let firstByteOrder = null;
  const reader = new ResponseReader({ method: request.method, onHead: (head) => { onHead(head); }, onBody });
  let settleDone;
  const done = new Promise((resolve) => { settleDone = resolve; });
  const timer = setTimeout(() => { error ??= new DeadlineError(`no complete answer to ${request.method} ${request.target} from 127.0.0.1:${port}`, deadlineMs); socket.destroy(); }, deadlineMs);
  const connected = new Promise((resolve, reject) => {
    socket.once('connect', () => { localPort = socket.localPort; resolve(localPort); });
    socket.once('error', reject);
  });
  connected.catch(() => {});
  socket.on('data', (chunk) => {
    firstByteOrder ??= ++wireEvents;
    chunks.push(chunk);
    try { reader.feed(chunk); } catch (failure) { error ??= failure; socket.destroy(); }
  });
  socket.on('error', (failure) => { error ??= failure; });
  socket.once('close', () => {
    clearTimeout(timer);
    reader.ended();
    t1 = Date.now();
    const head = reader.head;
    settleDone({
      localPort, t0, t1, sentOrder, firstByteOrder, error: error ? String(error.message ?? error) : null, deadline: error instanceof DeadlineError ? error.what : null,
      request: { method: request.method, target: request.target, headers: encoded.headers, bytes: encoded.bytes.toString('base64') },
      status: head?.status ?? null, reason: head?.reason ?? null, httpVersion: head?.httpVersion ?? null, headers: head?.headers ?? null, head: head?.raw ?? null,
      interim: reader.interim, trailers: reader.trailers, body: Buffer.concat(reader.body), complete: reader.complete && !error,
      bytesAfterResponse: reader.state === 'done' ? reader.buffer.length : 0, wire: Buffer.concat(chunks).length,
    });
  });
  return {
    connected,
    /** Writes the request (once). */
    send() {
      t0 = Date.now();
      sentOrder = ++wireEvents;
      socket.write(encoded.bytes, () => { onSent(); });
    },
    done,
    /** Ends the exchange from the client side (a stream closed by the scenario, a teardown). */
    close() { socket.destroy(); },
    get socket() { return socket; },
  };
}

/** One exchange, connected, sent and read to its end. */
export async function exchange(port, request, options) {
  const open = openExchange(port, request, options);
  try { await open.connected; } catch (failure) { open.close(); return { ...(await open.done), error: `cannot connect to 127.0.0.1:${port}: ${failure.code ?? failure.message}` }; }
  open.send();
  return open.done;
}

/**
 * Server-sent events from body bytes: complete items (the text up to a blank
 * line) and the bytes after the last complete item.
 */
export function sseItems(bytes) {
  const text = bytes.toString('utf8').replace(/\r\n/g, '\n');
  const parts = text.split('\n\n');
  const rest = parts.pop();
  return { items: parts, rest };
}
