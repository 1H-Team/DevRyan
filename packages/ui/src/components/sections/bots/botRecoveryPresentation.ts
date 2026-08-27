import type { BotRecoveryExportRequest } from '@/lib/botsDesktopApi';

export type BotRecoveryExportForm = {
  passphrase: string;
  passphraseConfirmation: string;
  includeLibraryObjects: boolean;
  includeWorkspaceObjects: boolean;
  includeConnectorVault: boolean;
  confirmConnectorVault: boolean;
  includeEnvironmentSecrets: boolean;
  confirmEnvironmentSecrets: boolean;
  includeBrowserProfiles: boolean;
  confirmBrowserProfiles: boolean;
};

export const buildBotRecoveryExportRequest = (
  form: BotRecoveryExportForm,
): BotRecoveryExportRequest => {
  if (form.passphrase.length < 12 || form.passphrase.length > 1_024) {
    throw new Error('Recovery passphrase must contain 12–1,024 characters.');
  }
  if (form.passphrase.includes('\0')
    || form.passphrase.includes('\r')
    || form.passphrase.includes('\n')) {
    throw new Error('Recovery passphrase cannot contain line breaks.');
  }
  if (form.passphrase !== form.passphraseConfirmation) {
    throw new Error('Recovery passphrases do not match.');
  }
  if (form.includeConnectorVault && !form.confirmConnectorVault) {
    throw new Error('Connector vault export requires its separate high-risk confirmation.');
  }
  if (form.includeEnvironmentSecrets && !form.confirmEnvironmentSecrets) {
    throw new Error('Environment-secret export requires its separate high-risk confirmation.');
  }
  if (form.includeBrowserProfiles && !form.confirmBrowserProfiles) {
    throw new Error('Browser profile export requires its separate high-risk confirmation.');
  }
  return Object.freeze({
    passphrase: form.passphrase,
    includeLibraryObjects: form.includeLibraryObjects,
    includeWorkspaceObjects: form.includeWorkspaceObjects,
    includeConnectorVault: form.includeConnectorVault,
    confirmConnectorVault: form.includeConnectorVault && form.confirmConnectorVault,
    includeEnvironmentSecrets: form.includeEnvironmentSecrets,
    confirmEnvironmentSecrets: form.includeEnvironmentSecrets && form.confirmEnvironmentSecrets,
    includeBrowserProfiles: form.includeBrowserProfiles,
    confirmBrowserProfiles: form.includeBrowserProfiles && form.confirmBrowserProfiles,
  });
};
