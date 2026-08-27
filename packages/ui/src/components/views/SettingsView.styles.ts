import { cn } from '@/lib/utils';
import type { SettingsPageSlug } from '@/lib/settings/metadata';

export function getSettingsFullPageOverlayClassName(): string {
  return 'app-region-no-drag absolute inset-0 z-20 bg-background';
}

export function getSettingsBackButtonClassName({
  avoidMacTrafficLights = false,
  placement = 'floating',
}: { avoidMacTrafficLights?: boolean; placement?: 'floating' | 'inline' } = {}): string {
  return cn(
    placement === 'floating' && 'absolute top-3 z-50',
    placement === 'floating' && (avoidMacTrafficLights ? 'left-[5.5rem]' : 'left-3'),
    'inline-flex h-9 items-center rounded-lg',
    placement === 'inline'
      ? 'flex h-8 w-full items-center gap-2 rounded-md px-2'
      : 'w-9 justify-center p-2',
    'text-muted-foreground hover:text-foreground hover:bg-interactive-hover/50',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary'
  );
}

export function getSettingsBackButtonHeaderClassName({
  avoidMacTrafficLights = false,
}: { avoidMacTrafficLights?: boolean } = {}): string {
  return cn(
    'shrink-0 z-30 border-b border-border',
    avoidMacTrafficLights ? 'pt-14' : 'pt-2'
  );
}

export function getSettingsBackButtonHeaderContentClassName(): string {
  return 'px-2 pb-2';
}

export function getSettingsNavButtonClassName(selected: boolean): string {
  return cn(
    'flex h-8 w-full items-center gap-2 rounded-md px-2 text-left overflow-hidden',
    selected
      ? 'bg-interactive-selection text-foreground'
      : 'text-foreground hover:bg-interactive-hover'
  );
}

export function getSettingsNavScrollClassName({ reserveTopChrome = false }: { reserveTopChrome?: boolean } = {}): string {
  return cn(
    'flex-1 min-h-0 overflow-y-auto overflow-x-hidden',
    reserveTopChrome ? 'pt-14' : ''
  );
}

export function getSettingsPageSidebarClassName(slug: SettingsPageSlug): string {
  if (slug === 'skills.installed') {
    return 'w-[334px] min-w-[334px] max-w-[334px]';
  }

  return 'w-[264px] min-w-[264px] max-w-[264px]';
}
