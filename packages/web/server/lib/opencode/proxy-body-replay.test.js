import { describe, expect, it } from 'vitest';

import { replayParsedRequestBody } from './proxy.js';

const createProxyReq = () => {
  const headers = {};
  const chunks = [];
  return {
    headers,
    chunks,
    setHeader: (name, value) => {
      headers[name] = value;
    },
    write: (chunk) => {
      chunks.push(chunk);
    },
  };
};

const jsonHeaders = (bytes) => ({
  'content-type': 'application/json',
  'content-length': String(bytes),
});

describe('replayParsedRequestBody', () => {
  it('reuses the raw bytes captured by the express.json verify hook', () => {
    const rawBody = Buffer.from('{"parts":[{"type":"text","text":"hi"}]}', 'utf8');
    const req = {
      headers: jsonHeaders(rawBody.byteLength),
      body: JSON.parse(rawBody.toString('utf8')),
      rawBody,
    };
    const proxyReq = createProxyReq();
    replayParsedRequestBody(proxyReq, req);
    expect(proxyReq.chunks).toHaveLength(1);
    expect(proxyReq.chunks[0]).toBe(rawBody);
    expect(proxyReq.headers['content-length']).toBe(String(rawBody.byteLength));
  });

  it('falls back to re-serializing the parsed body when no raw bytes exist', () => {
    const body = { parts: [{ type: 'text', text: 'hi' }] };
    const serialized = JSON.stringify(body);
    const req = {
      headers: jsonHeaders(serialized.length),
      body,
    };
    const proxyReq = createProxyReq();
    replayParsedRequestBody(proxyReq, req);
    expect(proxyReq.chunks).toHaveLength(1);
    expect(proxyReq.chunks[0].toString('utf8')).toBe(serialized);
    expect(proxyReq.headers['content-length']).toBe(String(Buffer.byteLength(serialized)));
  });

  it('forwards Buffer bodies untouched', () => {
    const body = Buffer.from('{"a":1}', 'utf8');
    const req = {
      headers: jsonHeaders(body.byteLength),
      body,
      rawBody: Buffer.from('{"stale":true}', 'utf8'),
    };
    const proxyReq = createProxyReq();
    replayParsedRequestBody(proxyReq, req);
    expect(proxyReq.chunks[0]).toBe(body);
  });

  it('skips non-JSON and body-less requests', () => {
    const noBody = createProxyReq();
    replayParsedRequestBody(noBody, { headers: {}, body: undefined });
    expect(noBody.chunks).toHaveLength(0);

    const nonJson = createProxyReq();
    replayParsedRequestBody(nonJson, {
      headers: { 'content-type': 'text/plain', 'content-length': '2' },
      body: 'hi',
    });
    expect(nonJson.chunks).toHaveLength(0);
  });
});
