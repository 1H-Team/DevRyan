import React from 'react';

import { SettingsDetailSection } from '@/components/sections/shared/SettingsDetailSection';
import { NumberInput } from '@/components/ui/number-input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { FontOptionDefinition } from '@/lib/fontOptions';
import { useI18n } from '@/lib/i18n';
import { useSettingsPagePermission } from '@/lib/settings/permission-state';
import { cn } from '@/lib/utils';
import type { AppearanceOption } from './appearanceOptions';
import type { VisibleSetting } from './visibleSettings';

export interface AppearanceSectionProps {
    /** Settings this section renders, already filtered for policy and host. */
    rows: readonly VisibleSetting[];
    isMobile: boolean;
}

interface AppearanceSectionShellProps {
    title: React.ReactNode;
    description: React.ReactNode;
    actions?: React.ReactNode;
    children: React.ReactNode;
}

/** Titled Appearance section whose rows are separated by hairlines. */
export const AppearanceSectionShell: React.FC<AppearanceSectionShellProps> = ({ title, description, actions, children }) => (
    <SettingsDetailSection
        title={title}
        description={description}
        actions={actions}
        bodyClassName="divide-y divide-border/50 px-1 pb-0"
    >
        {children}
    </SettingsDetailSection>
);

interface UnitNumberInputProps {
    value: number;
    onValueChange: (value: number) => void;
    min: number;
    max: number;
    step: number;
    /** Visible unit suffix such as `%` or `px`; the aria label spells it out. */
    unit: string;
    ariaLabel: string;
    labelId: string;
    describedBy: string | undefined;
}

/** Number stepper with a visible unit, named by its field even on mobile. */
export const UnitNumberInput: React.FC<UnitNumberInputProps> = ({
    value,
    onValueChange,
    min,
    max,
    step,
    unit,
    ariaLabel,
    labelId,
    describedBy,
}) => {
    const { canEdit } = useSettingsPagePermission();

    return (
        <div role="group" aria-labelledby={labelId} aria-describedby={describedBy} className="flex items-center gap-1.5">
            <NumberInput
                value={value}
                onValueChange={onValueChange}
                min={min}
                max={max}
                step={step}
                disabled={!canEdit}
                aria-label={ariaLabel}
            />
            <span aria-hidden="true" className="min-w-[2ch] typography-meta text-muted-foreground">{unit}</span>
        </div>
    );
};

interface OptionSelectProps<T extends string> {
    value: T;
    options: readonly AppearanceOption<T>[];
    onValueChange: (value: T) => void;
    labelId: string;
    describedBy: string | undefined;
    className?: string;
}

/** Select for a fixed option list; maps the chosen value back to a typed option. */
export function OptionSelect<T extends string>({
    value,
    options,
    onValueChange,
    labelId,
    describedBy,
    className,
}: OptionSelectProps<T>): React.ReactElement {
    const { t } = useI18n();
    const selected = options.find((option) => option.id === value);

    return (
        <Select
            value={value}
            onValueChange={(next) => {
                const match = options.find((option) => option.id === next);
                if (match) onValueChange(match.id);
            }}
        >
            <SelectTrigger aria-labelledby={labelId} aria-describedby={describedBy} className={cn('w-fit min-w-[9rem]', className)}>
                <SelectValue>{selected ? t(selected.labelKey) : null}</SelectValue>
            </SelectTrigger>
            <SelectContent>
                {options.map((option) => (
                    <SelectItem key={option.id} value={option.id}>{t(option.labelKey)}</SelectItem>
                ))}
            </SelectContent>
        </Select>
    );
}

interface FontSelectProps<T extends string> {
    value: T;
    options: readonly FontOptionDefinition<T>[];
    onValueChange: (value: T) => void;
    labelId: string;
    describedBy: string | undefined;
}

/** Font picker whose trigger and items render in their own typeface. */
export function FontSelect<T extends string>({
    value,
    options,
    onValueChange,
    labelId,
    describedBy,
}: FontSelectProps<T>): React.ReactElement {
    const selected = options.find((option) => option.id === value);

    return (
        <Select
            value={value}
            onValueChange={(next) => {
                const match = options.find((option) => option.id === next);
                if (match) onValueChange(match.id);
            }}
        >
            <SelectTrigger aria-labelledby={labelId} aria-describedby={describedBy} className="w-[13rem]">
                <SelectValue>
                    {selected ? <span style={{ fontFamily: selected.stack }}>{selected.label}</span> : null}
                </SelectValue>
            </SelectTrigger>
            <SelectContent>
                {options.map((option) => (
                    <SelectItem key={option.id} value={option.id}>
                        <span style={{ fontFamily: option.stack }}>{option.label}</span>
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    );
}
