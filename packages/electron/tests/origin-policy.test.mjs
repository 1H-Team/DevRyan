import { describe, expect, test } from 'bun:test';
import {
  collectAllowedContentOrigins,
  isAllowedElectronContentUrl,
  isPrivilegedRendererOrigin,
  isPrivilegedRendererUrl,
  normalizeHttpOrigin,
  privilegedOriginGuardJs,
} from '../origin-policy.mjs';

const LOCAL_ORIGIN = 'http://127.0.0.1:57123';

describe('origin-policy', () => {
  test('exact state.localOrigin is privileged', () => {
    expect(isPrivilegedRendererOrigin(LOCAL_ORIGIN, LOCAL_ORIGIN)).toBe(true);
    expect(isPrivilegedRendererUrl(`${LOCAL_ORIGIN}/`, LOCAL_ORIGIN)).toBe(true);
  });

  test('another localhost port is not privileged', () => {
    expect(isPrivilegedRendererOrigin('http://127.0.0.1:9999', LOCAL_ORIGIN)).toBe(false);
    expect(isPrivilegedRendererUrl('http://127.0.0.1:9999/', LOCAL_ORIGIN)).toBe(false);
  });

  test('localhost hostname is not privileged unless it matches localOrigin', () => {
    const localWithLocalhost = 'http://localhost:57123';
    expect(isPrivilegedRendererOrigin('http://localhost:57123', localWithLocalhost)).toBe(true);
    expect(isPrivilegedRendererOrigin(LOCAL_ORIGIN, localWithLocalhost)).toBe(false);
  });

  test('file:// and about:blank surfaces are privileged', () => {
    expect(isPrivilegedRendererUrl('file:///tmp/devryan/index.html', LOCAL_ORIGIN)).toBe(true);
    expect(isPrivilegedRendererUrl('about:blank', LOCAL_ORIGIN)).toBe(true);
    expect(isPrivilegedRendererOrigin('null', LOCAL_ORIGIN)).toBe(true);
  });

  test('configured remote localhost is allowed for navigation but not privileged IPC', () => {
    const remoteTunnel = 'http://127.0.0.1:8080';
    const policy = {
      localOrigin: LOCAL_ORIGIN,
      hostUrls: [remoteTunnel],
      envServerUrl: null,
    };
    expect(isAllowedElectronContentUrl(remoteTunnel, policy)).toBe(true);
    expect(isPrivilegedRendererOrigin(normalizeHttpOrigin(remoteTunnel), LOCAL_ORIGIN)).toBe(false);
  });

  test('unconfigured localhost is denied for Electron content navigation', () => {
    const policy = {
      localOrigin: LOCAL_ORIGIN,
      hostUrls: [],
      envServerUrl: null,
    };
    expect(isAllowedElectronContentUrl('http://127.0.0.1:8080/', policy)).toBe(false);
    expect(isAllowedElectronContentUrl('http://localhost:3000/', policy)).toBe(false);
  });

  test('env server override origin is allowed for navigation', () => {
    const envOrigin = 'http://192.168.1.10:4096';
    const policy = {
      localOrigin: LOCAL_ORIGIN,
      hostUrls: [],
      envServerUrl: envOrigin,
    };
    expect(collectAllowedContentOrigins(policy).has(normalizeHttpOrigin(envOrigin))).toBe(true);
    expect(isAllowedElectronContentUrl(`${envOrigin}/settings`, policy)).toBe(true);
  });

  test('init-script guard does not trust arbitrary loopback hosts', () => {
    const guard = privilegedOriginGuardJs();
    expect(guard).not.toContain('localhost');
    expect(guard).not.toContain('127.0.0.1');
    expect(guard).toContain("__oc_origin==='null'");
    expect(guard).toContain('__oc_local');
  });
});

describe('buildInitScript privileged globals', () => {
  test('remote origins do not receive desktop server or home globals in init script', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const mainPath = fileURLToPath(new URL('../main.mjs', import.meta.url));
    const source = readFileSync(mainPath, 'utf8');
    // Home and the desktop server are set (under both names) only behind the local-origin guard.
    expect(source).toContain("if(__oc_is_local){__oc_set('HOME',");
    expect(source).toContain("if(__oc_is_local&&__oc_server){__oc_set('DESKTOP_SERVER',");
    expect(source).toContain("window['__DEVRYAN_'+n+'__']=v;window['__OPENCHAMBER_'+n+'__']=v;");
    expect(source).not.toMatch(/window\.__(?:DEVRYAN|OPENCHAMBER)_(?:HOME|DESKTOP_SERVER)__=/);
    expect(source).not.toMatch(/localhost\|127\\\.0\.0\.1/);
  });
});
