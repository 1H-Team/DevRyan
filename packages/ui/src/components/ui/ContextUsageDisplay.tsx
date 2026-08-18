import React from 'react';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { useI18n } from '@/lib/i18n';
import { RiInformationLine, RiLoader4Line } from '@remixicon/react';
import type { SessionContextUsage } from '@/stores/types/sessionTypes';
import type { ContextUsageAvailability } from '@/lib/contextUsagePresentation';

interface ContextUsageProgressIconProps {
  percentage: number;
  className?: string;
}

const ContextUsageProgressIcon: React.FC<ContextUsageProgressIconProps> = ({ percentage, className }) => {
  const radius = 8;
  const circumference = 2 * Math.PI * radius;
  const clampedPercentage = Math.min(Math.max(percentage, 0), 100);
  const strokeDashoffset = circumference * (1 - clampedPercentage / 100);

  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      className={cn('flex-shrink-0', className)}
      aria-hidden="true"
    >
      <circle
        cx="10"
        cy="10"
        r={radius}
        stroke="currentColor"
        strokeWidth="2.25"
        opacity="0.22"
      />
      <circle
        cx="10"
        cy="10"
        r={radius}
        stroke="currentColor"
        strokeWidth="2.25"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={strokeDashoffset}
        transform="rotate(-90 10 10)"
      />
    </svg>
  );
};

interface ContextUsageDisplayProps {
  usage: SessionContextUsage | null;
  availability?: ContextUsageAvailability;
  size?: 'default' | 'compact';
  isMobile?: boolean;
  hideIcon?: boolean;
  hideValue?: boolean;
  showPercentIcon?: boolean;
  className?: string;
  valueClassName?: string;
  percentIconClassName?: string;
  onClick?: () => void;
  pressed?: boolean;
  buttonRef?: React.Ref<HTMLButtonElement>;
}

export const ContextUsageDisplay: React.FC<ContextUsageDisplayProps> = ({
  usage,
  availability,
  size = 'default',
  isMobile = false,
  hideIcon = false,
  hideValue = false,
  showPercentIcon = false,
  className,
  valueClassName,
  percentIconClassName,
  onClick,
  pressed = false,
  buttonRef,
}) => {
  const { t } = useI18n();
  const [mobileTooltipOpen, setMobileTooltipOpen] = React.useState(false);
  let effectiveAvailability: ContextUsageAvailability = availability ?? (usage ? 'available' : 'unavailable');
  if (effectiveAvailability === 'available' && !usage) effectiveAvailability = 'unavailable';
  const hasMeasuredUsage = Boolean(usage && effectiveAvailability === 'available');
  const activeInputTokens = usage?.activeInputTokens ?? 0;
  const percentage = usage?.percentage ?? null;
  const capacityLimit = usage?.capacityLimit ?? null;
  const contextLimit = usage?.contextLimit ?? null;
  const outputLimit = usage?.outputLimit ?? null;

  const formatTokens = (tokens: number) => {
    if (tokens >= 1_000_000) {
      return `${(tokens / 1_000_000).toFixed(1)}M`;
    }
    if (tokens >= 1_000) {
      return `${(tokens / 1_000).toFixed(1)}K`;
    }
    return tokens.toFixed(1).replace(/\.0$/, '');
  };

  const hasKnownCapacity = hasMeasuredUsage && percentage !== null && capacityLimit !== null;
  const displayPercentage = hasKnownCapacity ? percentage.toFixed(1) : null;
  let tooltipLines: string[];
  if (effectiveAvailability === 'idle') {
    tooltipLines = [t('contextUsage.status.noSession')];
  } else if (effectiveAvailability === 'loading') {
    tooltipLines = [t('contextUsage.status.loading')];
  } else if (effectiveAvailability === 'unavailable') {
    tooltipLines = [t('contextUsage.status.notMeasured')];
  } else if (hasKnownCapacity) {
    tooltipLines = [
      `${t('contextUsage.mobile.usage')}: ${displayPercentage}%`,
      t('contextUsage.tooltip.usedTokens', { tokens: formatTokens(activeInputTokens) }),
      t('contextUsage.tooltip.usableInputCapacity', { tokens: formatTokens(capacityLimit) }),
      ...(contextLimit !== null
        ? [t('contextUsage.tooltip.contextLimit', { tokens: formatTokens(contextLimit) })]
        : []),
      ...(outputLimit !== null
        ? [t('contextUsage.tooltip.outputLimit', { tokens: formatTokens(outputLimit) })]
        : []),
    ];
  } else {
    tooltipLines = [
      t('contextUsage.unavailable.title'),
      t('contextUsage.tooltip.usedTokens', { tokens: formatTokens(activeInputTokens) }),
      t('contextUsage.unavailable.description'),
      ...(outputLimit !== null
        ? [t('contextUsage.tooltip.outputLimit', { tokens: formatTokens(outputLimit) })]
        : []),
    ];
  }
  const ariaLabel = `${t('contextUsage.aria.label')}: ${tooltipLines.join(', ')}`;

  const isInteractive = !isMobile && typeof onClick === 'function';

  const contextContent = (
    <>
      {!isMobile && !hideIcon && (
        effectiveAvailability === 'loading' ? (
          <RiLoader4Line className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden="true" />
        ) : hasKnownCapacity ? (
          <ContextUsageProgressIcon
            percentage={percentage}
            className="h-4 w-4 text-muted-foreground"
          />
        ) : (
          <RiInformationLine className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        )
      )}
      {!hideValue && (
        <span className={cn('font-medium inline-flex items-center gap-1.5', valueClassName)}>
          {showPercentIcon ? (
            <>
              {effectiveAvailability === 'loading' ? (
                <RiLoader4Line
                  className={cn('h-3.5 w-3.5 animate-spin text-muted-foreground', percentIconClassName)}
                  aria-hidden="true"
                />
              ) : hasKnownCapacity ? (
                <ContextUsageProgressIcon
                  percentage={percentage}
                  className={cn('h-3.5 w-3.5 text-muted-foreground', percentIconClassName)}
                />
              ) : (
                <RiInformationLine
                  className={cn('h-3.5 w-3.5 text-muted-foreground', percentIconClassName)}
                  aria-hidden="true"
                />
              )}
              <span className="text-foreground">
                {hasMeasuredUsage
                  ? (hasKnownCapacity ? `${displayPercentage}%` : formatTokens(activeInputTokens))
                  : t('contextUsage.unavailable.value')}
              </span>
            </>
          ) : (
            <span className="text-foreground">
              {hasMeasuredUsage
                ? (hasKnownCapacity ? `${displayPercentage}%` : formatTokens(activeInputTokens))
                : t('contextUsage.unavailable.value')}
            </span>
          )}
        </span>
      )}
      {hideValue && showPercentIcon && (
        effectiveAvailability === 'loading' ? (
          <RiLoader4Line
            className={cn('h-3.5 w-3.5 animate-spin text-muted-foreground', percentIconClassName)}
            aria-hidden="true"
          />
        ) : hasKnownCapacity ? (
          <ContextUsageProgressIcon
            percentage={percentage}
            className={cn('h-3.5 w-3.5 text-muted-foreground', percentIconClassName)}
          />
        ) : (
          <RiInformationLine
            className={cn('h-3.5 w-3.5 text-muted-foreground', percentIconClassName)}
            aria-hidden="true"
          />
        )
      )}
    </>
  );

  const sharedClassName = cn(
    'app-region-no-drag flex items-center gap-1.5 select-none',
    size === 'compact' ? 'typography-micro' : 'typography-meta',
    isInteractive
      ? cn(
        'rounded-md px-2 py-1.5 text-foreground transition-colors',
        'hover:bg-interactive-hover',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary'
      )
      : 'text-muted-foreground/60',
    className,
  );

  const contextElement = isInteractive ? (
    <button
      ref={buttonRef}
      type="button"
      className={sharedClassName}
      aria-label={ariaLabel}
      aria-pressed={pressed}
      aria-busy={effectiveAvailability === 'loading' || undefined}
      onClick={onClick}
    >
      {contextContent}
    </button>
  ) : isMobile ? (
    <button
      type="button"
      className={cn(sharedClassName, 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary')}
      aria-label={ariaLabel}
      aria-busy={effectiveAvailability === 'loading' || undefined}
      onClick={() => setMobileTooltipOpen(true)}
    >
      {contextContent}
    </button>
  ) : (
    <div
      className={sharedClassName}
      aria-label={ariaLabel}
      aria-busy={effectiveAvailability === 'loading' || undefined}
    >
      {contextContent}
    </div>
  );

  if (isMobile) {
    return (
      <>
        {contextElement}
        <MobileOverlayPanel
          open={mobileTooltipOpen}
          onClose={() => setMobileTooltipOpen(false)}
          title={t('contextUsage.mobile.title')}
        >
          {!hasMeasuredUsage ? (
            <div className="rounded-xl border border-border/40 bg-sidebar/30 px-3 py-3 typography-meta text-muted-foreground">
              {tooltipLines[0]}
            </div>
          ) : (
          <div className="flex flex-col gap-1.5">
            <div className="rounded-xl border border-border/40 bg-sidebar/30 px-3 py-2 space-y-1">
              <div className="flex justify-between items-center">
                <span className="typography-meta text-muted-foreground">{t('contextUsage.mobile.usedTokens')}</span>
                <span className="typography-meta text-foreground font-medium">{formatTokens(activeInputTokens)}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="typography-meta text-muted-foreground">{t('contextUsage.mobile.capacity')}</span>
                <span className="typography-meta text-foreground font-medium">
                  {capacityLimit !== null ? formatTokens(capacityLimit) : t('contextUsage.unavailable.value')}
                </span>
              </div>
              {contextLimit !== null ? (
                <div className="flex justify-between items-center">
                  <span className="typography-meta text-muted-foreground">{t('contextUsage.mobile.contextLimit')}</span>
                  <span className="typography-meta text-foreground font-medium">{formatTokens(contextLimit)}</span>
                </div>
              ) : null}
              {outputLimit !== null ? (
                <div className="flex justify-between items-center">
                  <span className="typography-meta text-muted-foreground">{t('contextUsage.mobile.outputLimit')}</span>
                  <span className="typography-meta text-foreground font-medium">{formatTokens(outputLimit)}</span>
                </div>
              ) : null}
              <div className="flex justify-between items-center pt-1 border-t border-border/40">
                <span className="typography-meta text-muted-foreground">{t('contextUsage.mobile.usage')}</span>
                <span className="typography-meta font-semibold text-foreground">
                  {displayPercentage !== null ? `${displayPercentage}%` : t('contextUsage.unavailable.value')}
                </span>
              </div>
            </div>
          </div>
          )}
        </MobileOverlayPanel>
      </>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{contextElement}</TooltipTrigger>
      <TooltipContent side="top" align="center" sideOffset={6} className="whitespace-nowrap text-center">
        <div>
          {tooltipLines.map((line) => (
            <p key={line} className="typography-micro leading-tight">{line}</p>
          ))}
        </div>
      </TooltipContent>
    </Tooltip>
  );
};
