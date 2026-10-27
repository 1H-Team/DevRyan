import React from 'react';

import { SettingsPagePermissionBoundary } from '@/lib/settings/permission-context';
import { cn } from '@/lib/utils';

export type CapabilitySettingsSlug = 'skills.installed' | 'mcp';

export const CapabilityMutationBoundary: React.FC<{
  slug: CapabilitySettingsSlug;
  children: React.ReactNode;
}> = ({ slug, children }) => (
  <SettingsPagePermissionBoundary slug={slug}>{children}</SettingsPagePermissionBoundary>
);

export const CapabilitySettingsWorkspace: React.FC<{
  slug: CapabilitySettingsSlug;
  panelClassName?: string;
  children: React.ReactNode;
}> = ({ slug, panelClassName, children }) => {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div
        className={cn('min-h-0 flex-1 overflow-hidden', panelClassName)}
      >
        <CapabilityMutationBoundary slug={slug}>
          {children}
        </CapabilityMutationBoundary>
      </div>
    </div>
  );
};
