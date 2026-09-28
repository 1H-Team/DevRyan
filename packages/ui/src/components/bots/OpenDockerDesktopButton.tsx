import React from 'react';

import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { botsDesktopApi, type BotsDesktopApi } from '@/lib/botsDesktopApi';
import { useI18n } from '@/lib/i18n';

export const DOCKER_DESKTOP_PROBE_INTERVAL_MS = 5_000;
export const DOCKER_DESKTOP_PROBE_WINDOW_MS = 120_000;

type OpenDockerDesktopButtonProps = {
  /** Re-reads capabilities with a fresh host probe. */
  onRefresh: () => void;
  desktopApi?: BotsDesktopApi;
  size?: 'xs' | 'sm';
  variant?: 'default' | 'outline' | 'ghost';
  className?: string;
};

// Rendered only while Docker Desktop is stopped, so it unmounts (and stops
// probing) as soon as capabilities report anything else.
export const OpenDockerDesktopButton: React.FC<OpenDockerDesktopButtonProps> = ({
  onRefresh,
  desktopApi = botsDesktopApi,
  size = 'xs',
  variant = 'default',
  className,
}) => {
  const { t } = useI18n();
  const [opening, setOpening] = React.useState(false);
  const [waiting, setWaiting] = React.useState(false);
  const mounted = React.useRef(true);
  const refresh = React.useRef(onRefresh);
  refresh.current = onRefresh;

  React.useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  React.useEffect(() => {
    if (!waiting) return undefined;
    const interval = setInterval(() => refresh.current(), DOCKER_DESKTOP_PROBE_INTERVAL_MS);
    const deadline = setTimeout(() => setWaiting(false), DOCKER_DESKTOP_PROBE_WINDOW_MS);
    return () => {
      clearInterval(interval);
      clearTimeout(deadline);
    };
  }, [waiting]);

  const open = async () => {
    if (!desktopApi.openDockerDesktop) return;
    setOpening(true);
    try {
      const result = await desktopApi.openDockerDesktop();
      if (!mounted.current) return;
      if (result.opened) setWaiting(true);
      else toast.error(t('bots.runtime.openDockerFailed'));
    } catch {
      if (mounted.current) toast.error(t('bots.runtime.openDockerFailed'));
    } finally {
      if (mounted.current) setOpening(false);
    }
  };

  return (
    <Button
      type="button"
      size={size}
      variant={variant}
      className={className}
      disabled={opening || waiting}
      aria-busy={waiting || undefined}
      onClick={() => void open()}
    >
      {waiting ? t('bots.runtime.openDockerWaiting') : t('bots.runtime.openDocker')}
    </Button>
  );
};
