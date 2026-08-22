import http from 'node:http';
import https from 'node:https';
import { afterEach, describe, expect, it } from 'vitest';
import { createProxyMiddleware } from 'http-proxy-middleware';

import {
  OPEN_CODE_PROXY_AGENT_OPTIONS,
  createOpenCodeProxyAgentResolver,
  defineDynamicProxyAgent,
  resolveOpenCodeProxyTarget,
} from './proxy.js';

const openServers = new Set();
const openAgents = new Set();

const listen = async (server) => {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  openServers.add(server);
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
};

afterEach(async () => {
  for (const agent of openAgents) agent.destroy();
  openAgents.clear();
  await Promise.all([...openServers].map((server) => new Promise((resolve) => server.close(resolve))));
  openServers.clear();
});

describe('OpenCode proxy keep-alive agents', () => {
  it('does not call the managed URL builder while the port is absent', () => {
    let builderCalls = 0;
    let runtime = { openCodePort: null, openCodeBaseUrl: 'https://external.example.test/' };
    const resolve = () => resolveOpenCodeProxyTarget({
      getRuntime: () => runtime,
      buildOpenCodeUrl: () => {
        builderCalls += 1;
        return 'http://127.0.0.1:4096/';
      },
      fallbackTarget: 'http://127.0.0.1:3902',
    });

    expect(resolve()).toBe('https://external.example.test');
    expect(builderCalls).toBe(0);
    runtime = { openCodePort: 4096, openCodeBaseUrl: 'https://external.example.test/' };
    expect(resolve()).toBe('http://127.0.0.1:4096');
    expect(builderCalls).toBe(1);
    runtime = { openCodePort: null, openCodeBaseUrl: '' };
    expect(resolve()).toBe('http://127.0.0.1:3902');
    expect(builderCalls).toBe(1);
  });

  it('memoizes one correctly configured agent per target scheme', () => {
    let target = 'http://127.0.0.1:3902';
    const resolveAgent = createOpenCodeProxyAgentResolver(() => target);
    const httpAgent = resolveAgent();
    target = 'https://opencode.example.test';
    const httpsAgent = resolveAgent();

    expect(httpAgent).toBeInstanceOf(http.Agent);
    expect(httpsAgent).toBeInstanceOf(https.Agent);
    expect(resolveAgent()).toBe(httpsAgent);
    expect(httpAgent.options).toMatchObject(OPEN_CODE_PROXY_AGENT_OPTIONS);
    expect(httpsAgent.options).toMatchObject(OPEN_CODE_PROXY_AGENT_OPTIONS);
    resolveAgent.destroy();
  });

  it('relies on the installed middleware rereading the option getter and reuses a socket', async () => {
    let connections = 0;
    const upstream = http.createServer((_req, res) => res.end('upstream'));
    upstream.on('connection', () => { connections += 1; });
    const target = await listen(upstream);

    const resolveAgent = createOpenCodeProxyAgentResolver(() => target);
    openAgents.add({ destroy: resolveAgent.destroy });
    let getterReads = 0;
    const options = defineDynamicProxyAgent({
      target,
      router: () => target,
    }, () => {
      getterReads += 1;
      return resolveAgent();
    });
    const middleware = createProxyMiddleware(options);
    expect(getterReads).toBe(0);

    const proxy = http.createServer((req, res) => middleware(req, res, () => res.end('next')));
    const proxyUrl = await listen(proxy);
    expect(await (await fetch(`${proxyUrl}/one`)).text()).toBe('upstream');
    expect(await (await fetch(`${proxyUrl}/two`)).text()).toBe('upstream');

    expect(getterReads).toBe(2);
    expect(connections).toBe(1);
  });

  it('supports concurrent requests and dynamic target changes', async () => {
    let active = 0;
    let maxActive = 0;
    const first = http.createServer((_req, res) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      setTimeout(() => {
        active -= 1;
        res.end('first');
      }, 20);
    });
    const second = http.createServer((_req, res) => res.end('second'));
    const firstUrl = await listen(first);
    const secondUrl = await listen(second);
    let target = firstUrl;
    const resolveAgent = createOpenCodeProxyAgentResolver(() => target);
    openAgents.add({ destroy: resolveAgent.destroy });
    const middleware = createProxyMiddleware(defineDynamicProxyAgent({
      target,
      router: () => target,
    }, resolveAgent));
    const proxy = http.createServer((req, res) => middleware(req, res, () => res.end('next')));
    const proxyUrl = await listen(proxy);

    const concurrent = await Promise.all(
      Array.from({ length: 8 }, async (_, index) => (await fetch(`${proxyUrl}/${index}`)).text()),
    );
    expect(concurrent).toEqual(Array(8).fill('first'));
    expect(maxActive).toBeGreaterThan(1);

    target = secondUrl;
    expect(await (await fetch(`${proxyUrl}/moved`)).text()).toBe('second');
  });
});
