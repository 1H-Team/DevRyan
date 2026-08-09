import * as React from 'react';
import { RiErrorWarningLine, RiGlobalLine } from '@remixicon/react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useManagedTunnelPresets, type ManagedTunnelPreset } from '@/hooks/useManagedTunnelPresets';

export interface TunnelPresetSelection {
  tunnelPresetId: string | null;
  hostname: string | null;
  tunnelName: string | null;
  tunnelActive: boolean;
}

interface TunnelPresetPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  busy?: boolean;
  onCreate: (selection: TunnelPresetSelection) => void;
}

const LOCAL_ORIGIN_OPTION = '__local-origin__';

export const TunnelPresetPickerDialog: React.FC<TunnelPresetPickerDialogProps> = ({
  open,
  onOpenChange,
  busy = false,
  onCreate,
}) => {
  const { presets, loading, error, isPresetActive } = useManagedTunnelPresets(open);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [userSelected, setUserSelected] = React.useState(false);

  React.useEffect(() => {
    if (!open) {
      setSelectedId(null);
      setUserSelected(false);
      return;
    }
    // Follow the loaded data until the admin picks explicitly: the first
    // saved tunnel is the default once presets arrive.
    if (!loading && !userSelected) {
      setSelectedId(presets[0]?.id ?? LOCAL_ORIGIN_OPTION);
    }
  }, [open, loading, presets, userSelected]);

  const choose = (id: string) => {
    setUserSelected(true);
    setSelectedId(id);
  };

  const selectedPreset: ManagedTunnelPreset | null = React.useMemo(
    () => presets.find((preset) => preset.id === selectedId) || null,
    [presets, selectedId],
  );
  const selectedPresetInactive = Boolean(selectedPreset) && !isPresetActive(selectedPreset as ManagedTunnelPreset);

  const submit = () => {
    if (selectedPreset) {
      onCreate({
        tunnelPresetId: selectedPreset.id,
        hostname: selectedPreset.hostname,
        tunnelName: selectedPreset.name,
        tunnelActive: isPresetActive(selectedPreset),
      });
      return;
    }
    onCreate({ tunnelPresetId: null, hostname: null, tunnelName: null, tunnelActive: false });
  };

  const optionClassName = (checked: boolean) => [
    'flex w-full cursor-pointer items-start gap-3 rounded-lg border px-3 py-2 text-left transition-colors',
    checked
      ? 'border-[var(--interactive-focus-ring)] bg-[var(--surface-elevated)]'
      : 'border-border/60 hover:border-border',
  ].join(' ');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Create Access Link</DialogTitle>
          <DialogDescription>
            Choose the address the single-use invitation link should use.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          {loading && (
            <p className="typography-meta text-muted-foreground">Loading managed remote tunnels…</p>
          )}
          {!loading && error && (
            <p className="typography-meta text-[var(--status-warning)]">{error}</p>
          )}
          {!loading && !error && presets.length === 0 && (
            <p className="typography-meta text-muted-foreground">
              No managed remote tunnels are saved. Configure one in Settings → Tunnel to issue remotely reachable links.
            </p>
          )}
          {!loading && presets.map((preset) => {
            const checked = selectedId === preset.id;
            const presetActive = isPresetActive(preset);
            return (
              <label key={preset.id} className={optionClassName(checked)}>
                <input
                  type="radio"
                  name="tunnel-preset"
                  className="mt-1 size-3.5 accent-[var(--interactive-focus-ring)]"
                  checked={checked}
                  onChange={() => choose(preset.id)}
                  disabled={busy}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 typography-ui-label font-medium text-foreground">
                    {preset.name}
                    <span className={presetActive
                      ? 'rounded px-1.5 py-0.5 typography-micro bg-[var(--status-success)]/10 text-[var(--status-success)]'
                      : 'rounded px-1.5 py-0.5 typography-micro bg-[var(--status-warning)]/10 text-[var(--status-warning)]'}
                    >
                      {presetActive ? 'Active' : 'Not Running'}
                    </span>
                  </span>
                  <span className="block truncate typography-meta text-muted-foreground">{`https://${preset.hostname}`}</span>
                </span>
              </label>
            );
          })}
          {!loading && (
            <label className={optionClassName(selectedId === LOCAL_ORIGIN_OPTION)}>
              <input
                type="radio"
                name="tunnel-preset"
                className="mt-1 size-3.5 accent-[var(--interactive-focus-ring)]"
                checked={selectedId === LOCAL_ORIGIN_OPTION}
                onChange={() => choose(LOCAL_ORIGIN_OPTION)}
                disabled={busy}
              />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 typography-ui-label font-medium text-foreground">
                  <RiGlobalLine className="h-4 w-4 text-muted-foreground" /> This Server
                </span>
                <span className="block truncate typography-meta text-muted-foreground">{window.location.origin}</span>
                <span className="block typography-micro text-muted-foreground">
                  Only Reachable from Devices That Can Already Reach This Address.
                </span>
              </span>
            </label>
          )}
          {selectedPresetInactive && (
            <p className="flex items-start gap-2 rounded-lg border border-[var(--status-warning)]/30 bg-[var(--status-warning)]/10 p-2 typography-meta text-foreground">
              <RiErrorWarningLine className="mt-0.5 h-4 w-4 shrink-0 text-[var(--status-warning)]" />
              This tunnel is not running. The link will use its saved hostname, but the recipient cannot connect until the tunnel is started.
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={busy || loading || selectedId === null}>
            Create Link
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
