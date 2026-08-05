let installed = false;

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export const installApiFetchSecurity = (): void => {
  if (installed || typeof window === 'undefined' || typeof globalThis.fetch !== 'function') return;
  installed = true;
  const originalFetch = globalThis.fetch.bind(globalThis);

  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : null;
    const rawUrl = request?.url ?? String(input);
    const method = String(init?.method ?? request?.method ?? 'GET').toUpperCase();
    let url: URL;
    try {
      url = new URL(rawUrl, window.location.href);
    } catch {
      return originalFetch(input, init);
    }
    if (url.origin !== window.location.origin || !url.pathname.startsWith('/api/') || !MUTATION_METHODS.has(method)) {
      return originalFetch(input, init);
    }

    const headers = new Headers(init?.headers ?? request?.headers);
    headers.set('X-DevRyan-CSRF', '1');
    if (request) return originalFetch(new Request(request, { ...init, headers, method }));
    return originalFetch(input, { ...init, headers, method });
  };
};
