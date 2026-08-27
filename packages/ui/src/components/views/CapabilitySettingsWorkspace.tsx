import React from 'react';

import { SettingsPagePermissionBoundary } from '@/lib/settings/permission-context';
import { cn } from '@/lib/utils';
import type { ProductAudience } from '@/stores/useMainSidebarAudienceStore';

export type CapabilitySettingsSlug = 'skills.installed' | 'mcp';

export const CapabilityMutationBoundary: React.FC<{
  slug: CapabilitySettingsSlug;
  audience: ProductAudience;
  children: React.ReactNode;
}> = ({ slug, children }) => (
  <SettingsPagePermissionBoundary slug={slug}>{children}</SettingsPagePermissionBoundary>
);

export const CapabilitySettingsWorkspace: React.FC<{
  slug: CapabilitySettingsSlug;
  audience: ProductAudience;
  onAudienceChange: (audience: ProductAudience) => void;
  idPrefix: string;
  panelClassName?: string;
  children: React.ReactNode;
}> = ({ slug, panelClassName, children }) => {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div
        className={cn('min-h-0 flex-1 overflow-hidden', panelClassName)}
      >
        <CapabilityMutationBoundary slug={slug} audience="coding-agents">
          {children}
        </CapabilityMutationBoundary>
      </div>
    </div>
  );
};
