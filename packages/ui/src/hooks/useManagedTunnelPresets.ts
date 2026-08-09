import * as React from 'react';

export interface ManagedTunnelPreset {
  id: string;
  name: string;
  hostname: string;
  originPort?: number | null;
}

interface TunnelStatusPayload {
  active?: boolean;
  url?: string | null;
  managedRemoteTunnelPresets?: ManagedTunnelPreset[];
}

export interface ManagedTunnelPresetsState {
  presets: ManagedTunnelPreset[];
  active: boolean;
  activeUrl: string | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
  isPresetActive: (preset: ManagedTunnelPreset) => boolean;
}

const activeHostname = (url: string | null): string | null => {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
};

export const useManagedTunnelPresets = (enabled = true): ManagedTunnelPresetsState => {
  const [presets, setPresets] = React.useState<ManagedTunnelPreset[]>([]);
  const [active, setActive] = React.useState(false);
  const [activeUrl, setActiveUrl] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(enabled);
  const [error, setError] = React.useState<string | null>(null);
  const [refreshToken, setRefreshToken] = React.useState(0);

  React.useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const response = await fetch('/api/openchamber/tunnel/status', { signal: controller.signal });
        if (!response.ok) throw new Error(`Tunnel status failed (${response.status})`);
        const payload = await response.json() as TunnelStatusPayload;
        if (cancelled) return;
        setPresets(Array.isArray(payload.managedRemoteTunnelPresets)
          ? payload.managedRemoteTunnelPresets.filter((entry) => entry?.id && entry?.hostname)
          : []);
        setActive(payload.active === true);
        setActiveUrl(typeof payload.url === 'string' && payload.url ? payload.url : null);
        setError(null);
      } catch (fetchError) {
        if (cancelled || controller.signal.aborted) return;
        setError(fetchError instanceof Error ? fetchError.message : 'Failed to load tunnel status');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [enabled, refreshToken]);

  const refresh = React.useCallback(() => setRefreshToken((token) => token + 1), []);

  const isPresetActive = React.useCallback((preset: ManagedTunnelPreset) => {
    const host = activeHostname(activeUrl);
    return active && Boolean(host) && host === preset.hostname.toLowerCase();
  }, [active, activeUrl]);

  return { presets, active, activeUrl, loading, error, refresh, isPresetActive };
};
