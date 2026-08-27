import React from 'react';

import {
  SidebarLeftCollapseIcon,
  SidebarLeftExpandIcon,
  SidebarRightCollapseIcon,
  SidebarRightExpandIcon,
} from '@/components/icons/ToolbarIcons';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import {
  DESKTOP_HEADER_ICON_BUTTON_CLASS,
  HeaderIconActionButton,
} from './headerIconButton';

type BotSidebarControlButtonProps = {
  side: 'left' | 'right';
  open: boolean;
  onToggle: () => void;
  mobile?: boolean;
};

export const BotSidebarControlButton: React.FC<BotSidebarControlButtonProps> = ({
  side,
  open,
  onToggle,
  mobile = false,
}) => {
  const { t } = useI18n();
  const isLeft = side === 'left';
  let title: string;
  let Icon = SidebarLeftExpandIcon;

  if (isLeft) {
    title = open
      ? t('sessions.sidebar.header.actions.closeSessions')
      : t('header.actions.openSessionsAria');
    Icon = open ? SidebarLeftCollapseIcon : SidebarLeftExpandIcon;
  } else {
    title = open
      ? t('bots.header.closeOperations')
      : t('bots.header.openOperations');
    Icon = open ? SidebarRightCollapseIcon : SidebarRightExpandIcon;
  }

  if (mobile) {
    return (
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          'app-region-no-drag pointer-events-auto inline-flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
          'hover:bg-interactive-hover hover:text-foreground',
          open && 'bg-interactive-selection text-interactive-selection-foreground',
        )}
        aria-label={title}
        aria-expanded={open}
        data-bot-sidebar-control={side}
      >
        <Icon className="h-5 w-5" />
      </button>
    );
  }

  return (
    <HeaderIconActionButton
      title={title}
      ariaLabel={title}
      onClick={onToggle}
      className={DESKTOP_HEADER_ICON_BUTTON_CLASS}
      Icon={Icon}
    />
  );
};
