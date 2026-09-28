import React from 'react';
import { RiCheckLine } from '@remixicon/react';
import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';

import { useSettingsPagePermission } from '@/lib/settings/permission-state';
import { cn } from '@/lib/utils';

export interface SettingsOptionCard<T extends string> {
  value: T;
  label: React.ReactNode;
  description?: React.ReactNode;
  /** Decorative preview drawn above the label (default size only). */
  illustration?: React.ReactNode;
  /** Small leading icon (compact size) or corner icon (default size). */
  icon?: React.ReactNode;
  badge?: React.ReactNode;
}

interface SettingsOptionCardGroupProps<T extends string> {
  value: T;
  options: readonly SettingsOptionCard<T>[];
  onValueChange: (value: T) => void;
  /** `compact` renders one-line chips; `default` renders cards with description and illustration. */
  size?: 'compact' | 'default';
  /** Maximum columns for `default` cards; fewer are used in narrow containers. */
  columns?: 2 | 3 | 4;
  disabled?: boolean;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
  className?: string;
}

const COLUMN_CLASSES: Record<2 | 3 | 4, string> = {
  2: 'grid-cols-1 @xs:grid-cols-2',
  3: 'grid-cols-1 @xs:grid-cols-2 @lg:grid-cols-3',
  4: 'grid-cols-2 @md:grid-cols-3 @xl:grid-cols-4',
};

const CARD_BASE = cn(
  'relative cursor-pointer select-none rounded-lg border text-left outline-none transition-colors',
  'border-[var(--interactive-border)] bg-[var(--surface-elevated)] hover:border-[var(--interactive-border-hover)]',
  'focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-background',
  'data-[checked]:border-[var(--primary-base)] data-[checked]:bg-[var(--interactive-selection)] data-[checked]:ring-1 data-[checked]:ring-[var(--primary-base)]',
  'data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 data-[readonly]:cursor-default',
);

/**
 * A single-choice setting shown as selectable cards. Arrow keys move between
 * options (Base UI radio group); selection flows through the hidden radio input
 * so read-only settings pages can block it.
 *
 * @example
 * <SettingsOptionCardGroup
 *   aria-labelledby={labelId}
 *   value={diffLayout}
 *   onValueChange={setDiffLayout}
 *   options={[{ value: 'inline', label: 'Always Inline', description: 'Show as a single unified view.' }]}
 * />
 */
export function SettingsOptionCardGroup<T extends string>({
  value,
  options,
  onValueChange,
  size = 'default',
  columns = 3,
  disabled = false,
  className,
  ...aria
}: SettingsOptionCardGroupProps<T>): React.ReactElement {
  const { canEdit } = useSettingsPagePermission();

  const handleValueChange = React.useCallback((next: unknown) => {
    const match = options.find((option) => option.value === next);
    if (match) onValueChange(match.value);
  }, [onValueChange, options]);

  const group = (
    <RadioGroup
      value={value}
      onValueChange={handleValueChange}
      disabled={disabled}
      readOnly={!canEdit}
      aria-label={aria['aria-label']}
      aria-labelledby={aria['aria-labelledby']}
      aria-describedby={aria['aria-describedby']}
      className={cn(
        'relative',
        size === 'compact' ? 'flex flex-wrap gap-1.5' : cn('grid gap-2', COLUMN_CLASSES[columns]),
        className,
      )}
    >
      {options.map((option) => (
        <Radio.Root
          key={option.value}
          value={option.value}
          className={cn(
            CARD_BASE,
            size === 'compact'
              ? 'inline-flex min-h-8 items-center gap-1.5 px-2.5 py-1 [.mobile-pointer_&]:min-h-9'
              : 'flex min-h-9 min-w-0 flex-col gap-1.5 p-2.5',
          )}
        >
          {size === 'compact' ? (
            <>
              {option.icon ? <span className="flex shrink-0 text-muted-foreground" aria-hidden="true">{option.icon}</span> : null}
              <span className="typography-ui-label text-foreground">{option.label}</span>
              {option.badge}
            </>
          ) : (
            <>
              {option.illustration ? (
                <span className="block overflow-hidden rounded-md" aria-hidden="true">{option.illustration}</span>
              ) : null}
              <span className="flex min-w-0 items-center gap-1.5">
                {option.icon ? <span className="flex shrink-0 text-muted-foreground" aria-hidden="true">{option.icon}</span> : null}
                <span className="min-w-0 typography-ui-label font-medium text-foreground">{option.label}</span>
                {option.badge}
                <Radio.Indicator className="ml-auto flex shrink-0 text-[var(--primary-base)]">
                  <RiCheckLine className="h-3.5 w-3.5" aria-hidden="true" />
                </Radio.Indicator>
              </span>
              {option.description ? (
                <span className="typography-micro text-muted-foreground">{option.description}</span>
              ) : null}
            </>
          )}
        </Radio.Root>
      ))}
    </RadioGroup>
  );

  // Default cards size their grid from the available width, not the viewport. An inline-size
  // container has no intrinsic width, so it must be told to fill its parent.
  return size === 'compact' ? group : <div className="@container w-full min-w-0">{group}</div>;
}
