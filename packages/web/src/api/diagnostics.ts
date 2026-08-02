import type {
  DiagnosticsAPI,
  DiagnosticsExportResult,
  DiagnosticsExportScope,
} from '@openchamber/ui/lib/api/types';

const getNativeInvoke = () => {
  const tauri = (window as unknown as {
    __TAURI__?: {
      core?: {
        invoke?: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
      };
    };
  }).__TAURI__;
  return tauri?.core?.invoke;
};

const parseFileName = (response: Response): string => {
  const disposition = response.headers.get('content-disposition') || '';
  const match = disposition.match(/filename="([^"]+)"/i);
  return match?.[1] || 'DevRyan-diagnostics.zip';
};

const downloadResponse = async (response: Response): Promise<DiagnosticsExportResult> => {
  const blob = await response.blob();
  const fileName = parseFileName(response);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return { cancelled: false, fileName };
};

export const createWebDiagnosticsAPI = (): DiagnosticsAPI => ({
  async getStatus() {
    const response = await fetch('/api/diagnostics/status', {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    if (!response.ok) {
      throw new Error(`Failed to read diagnostics status (${response.status})`);
    }
    return response.json();
  },

  async export(scope: DiagnosticsExportScope) {
    const invoke = getNativeInvoke();
    if (invoke && window.__OPENCHAMBER_ELECTRON__) {
      return invoke<DiagnosticsExportResult>('desktop_export_diagnostics', { scope });
    }

    const response = await fetch('/api/diagnostics/export', {
      method: 'POST',
      headers: {
        Accept: 'application/zip',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(scope),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { error?: string } | null;
      throw new Error(payload?.error || `Failed to export diagnostics (${response.status})`);
    }
    return downloadResponse(response);
  },

  async sanitizeText(text: string) {
    const response = await fetch('/api/diagnostics/sanitize', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text }),
    });
    if (!response.ok) throw new Error(`Failed to sanitize diagnostics (${response.status})`);
    const payload = await response.json() as { text?: unknown };
    return typeof payload.text === 'string' ? payload.text : '';
  },

  async clear() {
    const response = await fetch('/api/diagnostics', {
      method: 'DELETE',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { error?: string } | null;
      throw new Error(payload?.error || `Failed to clear diagnostics (${response.status})`);
    }
    return response.json();
  },
});
