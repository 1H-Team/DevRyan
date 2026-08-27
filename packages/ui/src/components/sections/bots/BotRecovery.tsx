import React from 'react';
import {
  RiArchiveLine,
  RiDownloadCloud2Line,
  RiErrorWarningLine,
  RiUploadCloud2Line,
} from '@remixicon/react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import {
  botsDesktopApi,
  type BotsDesktopApi,
} from '@/lib/botsDesktopApi';
import { buildBotRecoveryExportRequest } from './botRecoveryPresentation';

const messageFromError = (error: unknown): string => (
  error instanceof Error ? error.message : 'Bot recovery could not be completed.'
);

const RecoveryChoice: React.FC<{
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  detail: string;
  disabled?: boolean;
  risk?: boolean;
}> = ({ checked, onChange, label, detail, disabled = false, risk = false }) => (
  <label className="flex items-start gap-3 rounded-lg border border-border/70 p-3">
    <Checkbox
      checked={checked}
      onChange={onChange}
      disabled={disabled}
      ariaLabel={label}
      className="mt-0.5"
    />
    <span className="min-w-0">
      <span className="block typography-ui-label font-medium text-foreground">{label}</span>
      <span className={risk
        ? 'mt-0.5 block typography-micro text-[var(--status-warning)]'
        : 'mt-0.5 block typography-micro text-muted-foreground'}>
        {detail}
      </span>
    </span>
  </label>
);

export type BotRecoveryProps = {
  botId: string;
  botName: string;
  canManage: boolean;
  canRestore?: boolean;
  desktopApi?: BotsDesktopApi;
  onRestored?: () => void;
};

export const BotRecovery: React.FC<BotRecoveryProps> = ({
  botId,
  botName,
  canManage,
  canRestore = false,
  desktopApi = botsDesktopApi,
  onRestored,
}) => {
  const [exportPassphrase, setExportPassphrase] = React.useState('');
  const [exportConfirmation, setExportConfirmation] = React.useState('');
  const [includeLibraryObjects, setIncludeLibraryObjects] = React.useState(true);
  const [includeWorkspaceObjects, setIncludeWorkspaceObjects] = React.useState(true);
  const [includeConnectorVault, setIncludeConnectorVault] = React.useState(false);
  const [confirmConnectorVault, setConfirmConnectorVault] = React.useState(false);
  const [includeEnvironmentSecrets, setIncludeEnvironmentSecrets] = React.useState(false);
  const [confirmEnvironmentSecrets, setConfirmEnvironmentSecrets] = React.useState(false);
  const [includeBrowserProfiles, setIncludeBrowserProfiles] = React.useState(false);
  const [confirmBrowserProfiles, setConfirmBrowserProfiles] = React.useState(false);
  const [restorePassphrase, setRestorePassphrase] = React.useState('');
  const [restoreMode, setRestoreMode] = React.useState<'empty' | 'merge'>('empty');
  const [confirmRestore, setConfirmRestore] = React.useState(false);
  const [busy, setBusy] = React.useState<'export' | 'restore' | null>(null);
  const [notice, setNotice] = React.useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const available = canManage && desktopApi.isAvailable();

  const runExport = async () => {
    setBusy('export');
    setNotice(null);
    try {
      const request = buildBotRecoveryExportRequest({
        passphrase: exportPassphrase,
        passphraseConfirmation: exportConfirmation,
        includeLibraryObjects,
        includeWorkspaceObjects,
        includeConnectorVault,
        confirmConnectorVault,
        includeEnvironmentSecrets,
        confirmEnvironmentSecrets,
        includeBrowserProfiles,
        confirmBrowserProfiles,
      });
      const result = await desktopApi.exportRecovery(botId, request);
      if (result.cancelled) {
        setNotice({ kind: 'success', text: 'Recovery export was cancelled before writing a file.' });
        return;
      }
      setExportPassphrase('');
      setExportConfirmation('');
      setNotice({
        kind: 'success',
        text: result.fileName
          ? `Encrypted recovery bundle saved as ${result.fileName}.`
          : 'Encrypted recovery bundle saved.',
      });
    } catch (error) {
      setNotice({ kind: 'error', text: messageFromError(error) });
    } finally {
      setBusy(null);
    }
  };

  const runRestore = async () => {
    setBusy('restore');
    setNotice(null);
    try {
      if (restorePassphrase.length < 12 || restorePassphrase.length > 1_024) {
        throw new Error('Recovery passphrase must contain 12–1,024 characters.');
      }
      if (restorePassphrase.includes('\0')
        || restorePassphrase.includes('\r')
        || restorePassphrase.includes('\n')) {
        throw new Error('Recovery passphrase cannot contain line breaks.');
      }
      if (!confirmRestore) throw new Error('Restore requires explicit mutation confirmation.');
      const result = await desktopApi.restoreRecovery(restorePassphrase, restoreMode);
      if (result.cancelled) {
        setNotice({ kind: 'success', text: 'Recovery restore was cancelled before a file was opened.' });
        return;
      }
      setRestorePassphrase('');
      setConfirmRestore(false);
      setNotice({ kind: 'success', text: 'Recovery bundle validated and restored.' });
      onRestored?.();
    } catch (error) {
      setNotice({ kind: 'error', text: messageFromError(error) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="space-y-5" aria-labelledby="bot-recovery-heading">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-[var(--surface-elevated)] text-muted-foreground">
          <RiArchiveLine className="h-4.5 w-4.5" aria-hidden />
        </span>
        <div>
          <h3 id="bot-recovery-heading" className="typography-ui-header font-semibold text-foreground">Recovery Bundle</h3>
          <p className="typography-ui text-muted-foreground">
            Export a versioned, passphrase-encrypted backup for {botName}, or restore a compatible bundle through a native file dialog.
          </p>
        </div>
      </div>

      {!canManage ? (
        <p className="rounded-lg border border-border/70 p-3 typography-ui text-muted-foreground">
          Bot Manager access is required for recovery export and restore.
        </p>
      ) : !available ? (
        <p className="rounded-lg border border-border/70 p-3 typography-ui text-muted-foreground">
          Recovery files are available only in the local DevRyan macOS app. Bundle material is never exposed to the web renderer.
        </p>
      ) : (
        <>
          <div className="space-y-4 rounded-xl border border-border/70 p-4">
            <div>
              <h4 className="typography-ui-label font-semibold text-foreground">Export Encrypted Bundle</h4>
              <p className="mt-1 typography-micro text-muted-foreground">
                Bot configuration and the deployment key are always included. Library and private workspace objects remain encrypted inside the bundle.
              </p>
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              <RecoveryChoice
                checked={includeLibraryObjects}
                onChange={setIncludeLibraryObjects}
                label="Include Library Objects"
                detail="Selected published Library ciphertext and metadata."
                disabled={busy !== null}
              />
              <RecoveryChoice
                checked={includeWorkspaceObjects}
                onChange={setIncludeWorkspaceObjects}
                label="Include Private Workspace Objects"
                detail="Selected private artifact ciphertext and metadata."
                disabled={busy !== null}
              />
              <RecoveryChoice
                checked={includeConnectorVault}
                onChange={(checked) => {
                  setIncludeConnectorVault(checked);
                  if (!checked) setConfirmConnectorVault(false);
                }}
                label="Include Connector Vault"
                detail="High risk: copies deployment-encrypted connector credentials."
                disabled={busy !== null}
                risk
              />
              <RecoveryChoice
                checked={includeBrowserProfiles}
                onChange={(checked) => {
                  setIncludeBrowserProfiles(checked);
                  if (!checked) setConfirmBrowserProfiles(false);
                }}
                label="Include Browser Profiles"
                detail="High risk: copies cookies, local storage, and authenticated browser state."
                disabled={busy !== null}
                risk
              />
              <RecoveryChoice
                checked={includeEnvironmentSecrets}
                onChange={(checked) => {
                  setIncludeEnvironmentSecrets(checked);
                  if (!checked) setConfirmEnvironmentSecrets(false);
                }}
                label="Include Environment Secrets"
                detail="High risk: copies Bot-wide reasoning environment values."
                disabled={busy !== null}
                risk
              />
            </div>

            {includeConnectorVault ? (
              <RecoveryChoice
                checked={confirmConnectorVault}
                onChange={setConfirmConnectorVault}
                label="I Confirm Connector Secret Export"
                detail="The bundle can unlock connector accounts when restored with its passphrase."
                disabled={busy !== null}
                risk
              />
            ) : null}
            {includeBrowserProfiles ? (
              <RecoveryChoice
                checked={confirmBrowserProfiles}
                onChange={setConfirmBrowserProfiles}
                label="I Confirm Authenticated Browser State Export"
                detail="The bundle may contain active website sessions and account data."
                disabled={busy !== null}
                risk
              />
            ) : null}
            {includeEnvironmentSecrets ? (
              <RecoveryChoice
                checked={confirmEnvironmentSecrets}
                onChange={setConfirmEnvironmentSecrets}
                label="I Confirm Environment Secret Export"
                detail="The Bot and its tools can read these values after restore."
                disabled={busy !== null}
                risk
              />
            ) : null}

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1 typography-meta text-muted-foreground">
                <span>Bundle Passphrase</span>
                <Input
                  type="password"
                  autoComplete="new-password"
                  maxLength={1_024}
                  value={exportPassphrase}
                  onChange={(event) => setExportPassphrase(event.target.value)}
                  disabled={busy !== null}
                />
              </label>
              <label className="space-y-1 typography-meta text-muted-foreground">
                <span>Confirm Passphrase</span>
                <Input
                  type="password"
                  autoComplete="new-password"
                  maxLength={1_024}
                  value={exportConfirmation}
                  onChange={(event) => setExportConfirmation(event.target.value)}
                  disabled={busy !== null}
                />
              </label>
            </div>
            <div className="flex justify-end">
              <Button
                type="button"
                size="sm"
                disabled={busy !== null
                  || exportPassphrase.length < 12
                  || exportPassphrase !== exportConfirmation
                  || (includeConnectorVault && !confirmConnectorVault)
                  || (includeEnvironmentSecrets && !confirmEnvironmentSecrets)
                  || (includeBrowserProfiles && !confirmBrowserProfiles)}
                onClick={() => void runExport()}
              >
                <RiDownloadCloud2Line className="h-4 w-4" aria-hidden />
                {busy === 'export' ? 'Exporting…' : 'Choose Save Location'}
              </Button>
            </div>
          </div>

          {canRestore ? (
          <div className="space-y-4 rounded-xl border border-[var(--status-warning)]/35 p-4">
            <div className="flex items-start gap-2">
              <RiErrorWarningLine className="mt-0.5 h-4 w-4 shrink-0 text-[var(--status-warning)]" aria-hidden />
              <div>
                <h4 className="typography-ui-label font-semibold text-foreground">Restore Compatible Bundle</h4>
                <p className="mt-1 typography-micro text-muted-foreground">
                  The entire bundle is authenticated and validated before mutation. Empty Restore rejects an occupied target; Explicit Merge rejects every ID collision.
                </p>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1 typography-meta text-muted-foreground">
                <span>Bundle Passphrase</span>
                <Input
                  type="password"
                  autoComplete="current-password"
                  maxLength={1_024}
                  value={restorePassphrase}
                  onChange={(event) => setRestorePassphrase(event.target.value)}
                  disabled={busy !== null}
                />
              </label>
              <label className="space-y-1 typography-meta text-muted-foreground">
                <span>Restore Mode</span>
                <select
                  value={restoreMode}
                  onChange={(event) => setRestoreMode(event.target.value as 'empty' | 'merge')}
                  disabled={busy !== null}
                  className="h-8 w-full rounded-lg border border-input bg-background px-2 typography-ui-label text-foreground"
                >
                  <option value="empty">Empty Deployment Only</option>
                  <option value="merge">Explicit Collision-Safe Merge</option>
                </select>
              </label>
            </div>
            <RecoveryChoice
              checked={confirmRestore}
              onChange={setConfirmRestore}
              label="I Confirm Recovery Mutation"
              detail="Restore may install a deployment key and recreate Bot, Library, workspace, connector, and browser state."
              disabled={busy !== null}
              risk
            />
            <div className="flex justify-end">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy !== null || restorePassphrase.length < 12 || !confirmRestore}
                onClick={() => void runRestore()}
              >
                <RiUploadCloud2Line className="h-4 w-4" aria-hidden />
                {busy === 'restore' ? 'Restoring…' : 'Choose Bundle to Restore'}
              </Button>
            </div>
          </div>
          ) : (
            <p className="rounded-lg border border-border/70 p-3 typography-ui text-muted-foreground">
              Recovery restore is deployment-wide and requires a global administrator. Bot Managers can export this Bot without receiving restore authority.
            </p>
          )}
        </>
      )}

      {notice ? (
        <p
          role={notice.kind === 'error' ? 'alert' : 'status'}
          className={notice.kind === 'error'
            ? 'rounded-lg border border-[var(--status-error)]/35 p-3 typography-ui text-[var(--status-error)]'
            : 'rounded-lg border border-[var(--status-success)]/35 p-3 typography-ui text-foreground'}
        >
          {notice.text}
        </p>
      ) : null}
    </section>
  );
};
