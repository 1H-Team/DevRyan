import { describe, expect, it, vi } from 'vitest';
import type { WebviewHtmlOptions } from './webviewHtml';

vi.mock('vscode', () => ({
  ColorThemeKind: {
    Light: 1,
    Dark: 2,
    HighContrast: 3,
    HighContrastLight: 4,
  },
  Uri: {
    joinPath: (...parts: Array<{ toString(): string } | string>) => ({
      toString: () => parts.map((part) => String(part)).join('/'),
    }),
  },
  window: {
    activeColorTheme: { kind: 2 },
  },
}));

const { getWebviewHtml } = await import('./webviewHtml');

const createOptions = (devServerUrl?: string): WebviewHtmlOptions => ({
  webview: {
    cspSource: 'vscode-webview://unit-test',
    asWebviewUri: (uri: { toString(): string }) => ({ toString: () => uri.toString() }),
  } as unknown as WebviewHtmlOptions['webview'],
  extensionUri: { toString: () => 'extension-root' } as unknown as WebviewHtmlOptions['extensionUri'],
  workspaceFolder: '/workspace',
  initialStatus: 'connected' as const,
  cliAvailable: true,
  devServerUrl,
});

const readCsp = (html: string) => html.match(/Content-Security-Policy" content="([^"]+)"/)?.[1] ?? '';

describe('VS Code webview CSP', () => {
  it('allows production workers only from the webview source', () => {
    const csp = readCsp(getWebviewHtml(createOptions()));
    expect(csp).toContain('worker-src vscode-webview://unit-test;');
    expect(csp).not.toMatch(/worker-src[^;]*(?:\*|data:|blob:)/);
  });

  it('adds only the explicit development origin to worker-src', () => {
    const csp = readCsp(getWebviewHtml(createOptions('http://localhost:5173/path/')));
    expect(csp).toContain('worker-src vscode-webview://unit-test http://localhost:5173;');
    expect(csp).not.toMatch(/worker-src[^;]*(?:\*|data:|blob:)/);
  });
});
