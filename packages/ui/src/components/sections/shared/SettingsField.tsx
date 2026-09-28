import React from 'react';
import { RiRestartLine } from '@remixicon/react';

import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { useI18n } from '@/lib/i18n';
import { useSettingsPagePermission } from '@/lib/settings/permission-state';
import { cn } from '@/lib/utils';

export interface SettingsFieldControlProps {
  /** Id for the control; the field label targets it when `labelTargetsControl` is set. */
  controlId: string;
  labelId: string;
  /** Space-separated description and badge ids for `aria-describedby`. */
  describedBy: string | undefined;
}

export interface SettingsResetAction {
  onReset: () => void;
  /** True when the value already equals its default. */
  disabled: boolean;
  ariaLabel: string;
}

interface SettingsFieldProps {
  label: React.ReactNode;
  description?: React.ReactNode;
  /** Short qualifier beside the label, e.g. a `SettingsBadge` reading "Mobile Only". */
  badge?: React.ReactNode;
  /** `inline` puts the control beside the text from `sm` up; `stacked` always puts it below. */
  layout?: 'inline' | 'stacked';
  /** Render the label as `<label htmlFor={controlId}>` for native or hidden-input controls. */
  labelTargetsControl?: boolean;
  reset?: SettingsResetAction;
  className?: string;
  children: (control: SettingsFieldControlProps) => React.ReactNode;
}

interface SettingsResetButtonProps {
  onReset: () => void;
  disabled?: boolean;
  ariaLabel: string;
}

/** Icon button that restores a setting's default; disabled for read-only viewers. */
export const SettingsResetButton: React.FC<SettingsResetButtonProps> = ({ onReset, disabled = false, ariaLabel }) => {
  const { t } = useI18n();
  const { canEdit } = useSettingsPagePermission();

  return (
    <Button
      size="sm"
      type="button"
      variant="ghost"
      onClick={onReset}
      disabled={disabled || !canEdit}
      className="h-7 w-7 shrink-0 px-0 text-muted-foreground hover:text-foreground"
      aria-label={ariaLabel}
      title={t('settings.common.actions.reset')}
      data-settings-mutating="true"
    >
      <RiRestartLine className="h-3.5 w-3.5" aria-hidden="true" />
    </Button>
  );
};

/**
 * One settings row: label, optional badge, visible description, the control and
 * an optional reset button. The control receives ids to wire its accessible name
 * and description.
 *
 * @example
 * <SettingsField label="Code Font" description="Used for code blocks." reset={reset}>
 *   {({ labelId, describedBy }) => <Select aria-labelledby={labelId} aria-describedby={describedBy} />}
 * </SettingsField>
 */
export const SettingsField: React.FC<SettingsFieldProps> = ({
  label,
  description,
  badge,
  layout = 'inline',
  labelTargetsControl = false,
  reset,
  className,
  children,
}) => {
  const baseId = React.useId();
  const controlId = `${baseId}-control`;
  const labelId = `${baseId}-label`;
  const descriptionId = description ? `${baseId}-description` : undefined;
  const badgeId = badge ? `${baseId}-badge` : undefined;
  const describedBy = [descriptionId, badgeId].filter(Boolean).join(' ') || undefined;
  const LabelTag = labelTargetsControl ? 'label' : 'span';

  return (
    <div
      className={cn(
        'flex min-w-0 flex-col gap-2 py-2.5',
        layout === 'inline' && 'sm:flex-row sm:items-center sm:justify-between sm:gap-6',
        className,
      )}
      data-settings-field
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <LabelTag
            id={labelId}
            htmlFor={labelTargetsControl ? controlId : undefined}
            className={cn('typography-ui-label font-medium text-foreground', labelTargetsControl && 'cursor-pointer')}
          >
            {label}
          </LabelTag>
          {badge ? <span id={badgeId} className="inline-flex">{badge}</span> : null}
        </div>
        {description ? (
          <p id={descriptionId} className="typography-meta text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      <div className={cn('flex min-w-0 items-center gap-1.5', layout === 'inline' ? 'sm:shrink-0' : 'w-full')}>
        {children({ controlId, labelId, describedBy })}
        {reset ? (
          <SettingsResetButton onReset={reset.onReset} disabled={reset.disabled} ariaLabel={reset.ariaLabel} />
        ) : null}
      </div>
    </div>
  );
};

interface SettingsSwitchFieldProps {
  label: React.ReactNode;
  description?: React.ReactNode;
  badge?: React.ReactNode;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
}

/** A boolean setting: text on the left, a switch on the right, the label toggles it. */
export const SettingsSwitchField: React.FC<SettingsSwitchFieldProps> = ({
  label,
  description,
  badge,
  checked,
  onCheckedChange,
  disabled = false,
  className,
}) => {
  const { canEdit } = useSettingsPagePermission();

  return (
    <SettingsField
      label={label}
      description={description}
      badge={badge}
      labelTargetsControl
      className={cn('flex-row items-center justify-between gap-6', className)}
    >
      {({ controlId, labelId, describedBy }) => (
        <Switch
          id={controlId}
          checked={checked}
          // Base UI passes event details as a second argument; forward only the value.
          onCheckedChange={(next) => onCheckedChange(next)}
          disabled={disabled}
          readOnly={!canEdit}
          aria-labelledby={labelId}
          aria-describedby={describedBy}
        />
      )}
    </SettingsField>
  );
};
