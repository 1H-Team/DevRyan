export type ManagedRemoteConnectorState = 'connecting' | 'healthy' | 'degraded' | 'stopped';

interface ManagedRemoteStatusLike {
  active: boolean;
  mode?: string | null;
  providerMetadata?: {
    connectorState?: ManagedRemoteConnectorState;
    publicReachabilityVerified?: boolean;
  } | null;
}

export const isManagedRemoteStatusDegraded = (status: ManagedRemoteStatusLike): boolean => {
  if (!status.active || status.mode !== 'managed-remote') {
    return false;
  }

  const connectorState = status.providerMetadata?.connectorState;
  if (connectorState === 'connecting' || connectorState === 'degraded' || connectorState === 'stopped') {
    return true;
  }

  return status.providerMetadata?.publicReachabilityVerified === false;
};

export const isManagedAccountLoginAvailable = (scope: string | null | undefined): boolean => (
  scope === 'managed'
);
