import React from 'react';
import type { RemixiconComponentType } from '@remixicon/react';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

export const DESKTOP_HEADER_ICON_BUTTON_CLASS = 'app-region-no-drag inline-flex h-8 w-8 items-center justify-center gap-2 rounded-md typography-ui-label font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:pointer-events-none disabled:opacity-50 hover:bg-interactive-hover transition-colors';

type HeaderIconActionButtonProps = {
  visible?: boolean;
  title: string;
  ariaLabel: string;
  onClick: () => void;
  className?: string;
  Icon: RemixiconComponentType;
  iconClassName?: string;
};

export const HeaderIconActionButton = React.memo(function HeaderIconActionButton({
  visible = true,
  title,
  ariaLabel,
  onClick,
  className,
  Icon,
  iconClassName,
}: HeaderIconActionButtonProps) {
  if (!visible) {
    return null;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-label={ariaLabel}
          className={className ?? DESKTOP_HEADER_ICON_BUTTON_CLASS}
        >
          <Icon className={iconClassName ?? 'h-[18px] w-[18px]'} />
        </button>
      </TooltipTrigger>
      <TooltipContent>
        <p>{title}</p>
      </TooltipContent>
    </Tooltip>
  );
});
