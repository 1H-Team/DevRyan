import * as React from 'react';

import { canEditSettingsPage, useAuthPrincipal } from '@/lib/authSession';
import { SettingsPermissionContext } from '@/lib/settings/permission-state';
import { cn } from '@/lib/utils';

export const SettingsPagePermissionBoundary: React.FC<{
  slug: string;
  children: React.ReactNode;
}> = ({ slug, children }) => {
  const principal = useAuthPrincipal();
  const canEdit = canEditSettingsPage(principal, slug);

  const blockMutationClick = React.useCallback((event: React.SyntheticEvent) => {
    if (canEdit) return;
    const target = event.target as Element | null;
    const interactive = target?.closest('[data-settings-mutating="true"], button[type="submit"], [aria-pressed], [role="switch"], [role="checkbox"], [role="radio"], [role="option"], [role="slider"], [role="menuitemcheckbox"]');
    if (!interactive || interactive.closest('[data-settings-readonly-allowed="true"]')) return;
    event.preventDefault();
    event.stopPropagation();
  }, [canEdit]);

  const blockMutationChange = React.useCallback((event: React.SyntheticEvent) => {
    if (canEdit) return;
    const target = event.target as Element | null;
    const interactive = target?.closest('input:not([type="search"]), select, textarea, [aria-pressed], [role="switch"], [role="checkbox"], [role="radio"], [role="option"], [role="slider"], [role="menuitemcheckbox"]');
    if (!interactive || interactive.closest('[data-settings-readonly-allowed="true"]')) return;
    event.preventDefault();
    event.stopPropagation();
  }, [canEdit]);

  return (
    <SettingsPermissionContext.Provider value={{ slug, canEdit }}>
      <div className="flex h-full min-h-0 flex-col">
        {!canEdit && slug !== 'home' ? (
          <div className="shrink-0 border-b border-border/60 bg-[var(--surface-subtle)]/45 px-4 py-2 typography-meta text-muted-foreground">
            Read-only access. Ask an administrator for Edit permission to change this section.
          </div>
        ) : null}
        <div
          data-settings-read-only={canEdit ? undefined : 'true'}
          onClickCapture={blockMutationClick}
          onSubmitCapture={blockMutationClick}
          onChangeCapture={blockMutationChange}
          className={cn(
            'min-h-0 flex-1',
            !canEdit && '[&_input:not([type="search"])]:opacity-60 [&_select]:opacity-60 [&_textarea]:opacity-60 [&_[aria-pressed]]:opacity-60 [&_[role="switch"]]:opacity-60 [&_[role="checkbox"]]:opacity-60 [&_[role="radio"]]:opacity-60 [&_[role="option"]]:opacity-60 [&_[role="slider"]]:opacity-60 [&_[role="menuitemcheckbox"]]:opacity-60 [&_[data-settings-mutating="true"]]:opacity-60',
          )}
        >
          {children}
        </div>
      </div>
    </SettingsPermissionContext.Provider>
  );
};
