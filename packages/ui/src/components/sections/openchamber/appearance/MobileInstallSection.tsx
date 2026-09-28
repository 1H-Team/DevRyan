import React from 'react';

import { SettingsBadge } from '@/components/sections/shared/SettingsBadge';
import { SettingsField, SettingsSwitchField } from '@/components/sections/shared/SettingsField';
import { SettingsOptionCardGroup } from '@/components/sections/shared/SettingsOptionCardGroup';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/lib/i18n';
import { normalizeMobileKeyboardMode, type MobileKeyboardMode } from '@/lib/mobileKeyboardMode';
import { updateDesktopSettings } from '@/lib/persistence';
import { useSettingsPagePermission } from '@/lib/settings/permission-state';
import { useUIStore } from '@/stores/useUIStore';
import { APPEARANCE_DEFAULTS, INPUT_BAR_OFFSET_RANGE } from './appearanceDefaults';
import {
    DEFAULT_PWA_INSTALL_NAME,
    MOBILE_KEYBOARD_MODE_OPTIONS,
    normalizePwaInstallName,
    normalizePwaOrientation,
    PWA_ORIENTATION_OPTIONS,
    toOptionCards,
    type PwaOrientation,
} from './appearanceOptions';
import { AppearanceSectionShell, OptionSelect, UnitNumberInput, type AppearanceSectionProps } from './controls';

type PwaInstallNameWindow = Window & {
    __OPENCHAMBER_SET_PWA_INSTALL_NAME__?: (value: string) => string;
    __OPENCHAMBER_SET_PWA_ORIENTATION__?: (value: PwaOrientation) => PwaOrientation;
    __OPENCHAMBER_UPDATE_PWA_MANIFEST__?: () => void;
};

export const MobileInstallSection = React.memo(function MobileInstallSection({ rows, isMobile }: AppearanceSectionProps) {
    const { t } = useI18n();
    const { canEdit } = useSettingsPagePermission();
    const showMobileSessionStatusBar = useUIStore((state) => state.showMobileSessionStatusBar);
    const setShowMobileSessionStatusBar = useUIStore((state) => state.setShowMobileSessionStatusBar);
    const inputBarOffset = useUIStore((state) => state.inputBarOffset);
    const setInputBarOffset = useUIStore((state) => state.setInputBarOffset);
    const mobileKeyboardMode = useUIStore((state) => state.mobileKeyboardMode);
    const setMobileKeyboardMode = useUIStore((state) => state.setMobileKeyboardMode);

    const showPwaInstallName = rows.includes('pwaInstallName');
    const showPwaOrientation = rows.includes('pwaOrientation');
    const showMobileKeyboardMode = rows.includes('mobileKeyboardMode');
    const [pwaInstallName, setPwaInstallName] = React.useState('');
    const [pwaOrientation, setPwaOrientation] = React.useState<PwaOrientation>('system');

    const keyboardModeCards = React.useMemo(() => toOptionCards(MOBILE_KEYBOARD_MODE_OPTIONS, t), [t]);

    const applyPwaInstallName = React.useCallback(async (value: string) => {
        if (typeof window === 'undefined') {
            return;
        }

        const win = window as PwaInstallNameWindow;
        const persistedValue = normalizePwaInstallName(value);

        await updateDesktopSettings({ pwaAppName: persistedValue });

        if (typeof win.__OPENCHAMBER_SET_PWA_INSTALL_NAME__ === 'function') {
            const resolved = win.__OPENCHAMBER_SET_PWA_INSTALL_NAME__(persistedValue);
            setPwaInstallName(resolved);
            return;
        }

        setPwaInstallName(persistedValue || DEFAULT_PWA_INSTALL_NAME);
        win.__OPENCHAMBER_UPDATE_PWA_MANIFEST__?.();
    }, []);

    const applyPwaOrientation = React.useCallback(async (value: PwaOrientation) => {
        if (typeof window === 'undefined') {
            return;
        }

        const win = window as PwaInstallNameWindow;
        const normalized = normalizePwaOrientation(value);

        await updateDesktopSettings({ pwaOrientation: normalized });

        if (typeof win.__OPENCHAMBER_SET_PWA_ORIENTATION__ === 'function') {
            const resolved = win.__OPENCHAMBER_SET_PWA_ORIENTATION__(normalized);
            setPwaOrientation(resolved);
            return;
        }

        setPwaOrientation(normalized);
        win.__OPENCHAMBER_UPDATE_PWA_MANIFEST__?.();
    }, []);

    const handlePwaOrientationChange = React.useCallback((value: PwaOrientation) => {
        setPwaOrientation(value);
        void applyPwaOrientation(value);
    }, [applyPwaOrientation]);

    const handleMobileKeyboardModeChange = React.useCallback((mode: MobileKeyboardMode) => {
        setMobileKeyboardMode(mode);
        void updateDesktopSettings({ mobileKeyboardMode: mode });
    }, [setMobileKeyboardMode]);

    React.useEffect(() => {
        if (typeof window === 'undefined' || (!showPwaInstallName && !showPwaOrientation && !showMobileKeyboardMode)) {
            return;
        }

        let cancelled = false;

        const loadPwaSettings = async () => {
            try {
                const response = await fetch('/api/config/settings', {
                    method: 'GET',
                    headers: { Accept: 'application/json' },
                    cache: 'no-store',
                });

                if (!response.ok) {
                    if (!cancelled) {
                        setPwaInstallName(DEFAULT_PWA_INSTALL_NAME);
                    }
                    return;
                }

                const settings = await response.json().catch(() => ({}));
                const raw = typeof settings?.pwaAppName === 'string' ? settings.pwaAppName : '';
                const normalized = normalizePwaInstallName(raw);
                const orientation = normalizePwaOrientation(settings?.pwaOrientation);
                const nextMobileKeyboardMode = normalizeMobileKeyboardMode(settings?.mobileKeyboardMode);

                if (!cancelled) {
                    if (showPwaInstallName) {
                        setPwaInstallName(normalized || DEFAULT_PWA_INSTALL_NAME);
                    }
                    if (showPwaOrientation) {
                        setPwaOrientation(orientation);
                    }
                    if (showMobileKeyboardMode) {
                        setMobileKeyboardMode(nextMobileKeyboardMode);
                    }
                }
            } catch {
                if (!cancelled) {
                    if (showPwaInstallName) {
                        setPwaInstallName(DEFAULT_PWA_INSTALL_NAME);
                    }
                    if (showPwaOrientation) {
                        setPwaOrientation('system');
                    }
                    if (showMobileKeyboardMode) {
                        setMobileKeyboardMode('native');
                    }
                }
            }
        };

        void loadPwaSettings();

        return () => {
            cancelled = true;
        };
    }, [setMobileKeyboardMode, showMobileKeyboardMode, showPwaInstallName, showPwaOrientation]);

    return (
        <AppearanceSectionShell
            title={t('settings.openchamber.visual.section.mobileInstall')}
            description={t('settings.openchamber.visual.section.mobileInstallDescription')}
        >
            {rows.includes('mobileStatusBar') && (
                <SettingsSwitchField
                    label={t('settings.openchamber.visual.field.showMobileStatusBar')}
                    description={t('settings.openchamber.visual.field.showMobileStatusBarDescription')}
                    checked={showMobileSessionStatusBar}
                    onCheckedChange={setShowMobileSessionStatusBar}
                />
            )}

            {rows.includes('inputBarOffset') && (
                <SettingsField
                    label={t('settings.openchamber.visual.field.inputBarOffset')}
                    description={t('settings.openchamber.visual.field.inputBarOffsetDescription')}
                    badge={isMobile ? undefined : <SettingsBadge>{t('settings.openchamber.visual.field.mobileOnlyBadge')}</SettingsBadge>}
                    reset={{
                        onReset: () => setInputBarOffset(APPEARANCE_DEFAULTS.inputBarOffset),
                        disabled: inputBarOffset === APPEARANCE_DEFAULTS.inputBarOffset,
                        ariaLabel: t('settings.openchamber.visual.actions.resetInputBarOffsetAria'),
                    }}
                >
                    {({ labelId, describedBy }) => (
                        <UnitNumberInput
                            value={inputBarOffset}
                            onValueChange={setInputBarOffset}
                            {...INPUT_BAR_OFFSET_RANGE}
                            unit="px"
                            ariaLabel={t('settings.openchamber.visual.field.inputBarOffsetAria')}
                            labelId={labelId}
                            describedBy={describedBy}
                        />
                    )}
                </SettingsField>
            )}

            {showMobileKeyboardMode && (
                <SettingsField
                    layout="stacked"
                    label={t('settings.openchamber.visual.field.mobileKeyboardMode')}
                    description={t('settings.openchamber.visual.field.mobileKeyboardModeDescription')}
                >
                    {({ labelId, describedBy }) => (
                        <SettingsOptionCardGroup
                            columns={2}
                            value={mobileKeyboardMode}
                            options={keyboardModeCards}
                            onValueChange={handleMobileKeyboardModeChange}
                            aria-labelledby={labelId}
                            aria-describedby={describedBy}
                        />
                    )}
                </SettingsField>
            )}

            {showPwaInstallName && (
                <SettingsField
                    label={t('settings.openchamber.visual.field.installAppName')}
                    description={t('settings.openchamber.visual.field.installAppNameDescription')}
                    reset={{
                        onReset: () => {
                            setPwaInstallName(DEFAULT_PWA_INSTALL_NAME);
                            void applyPwaInstallName('');
                        },
                        disabled: false,
                        ariaLabel: t('settings.openchamber.visual.actions.resetInstallAppNameAria'),
                    }}
                >
                    {({ labelId, describedBy }) => (
                        <Input
                            value={pwaInstallName}
                            onChange={(event) => setPwaInstallName(event.target.value)}
                            onBlur={() => {
                                if (canEdit) void applyPwaInstallName(pwaInstallName);
                            }}
                            onKeyDown={(event) => {
                                if (event.key === 'Enter' && canEdit) {
                                    event.preventDefault();
                                    void applyPwaInstallName(pwaInstallName);
                                }
                            }}
                            readOnly={!canEdit}
                            className="h-7 w-56 typography-ui-label"
                            maxLength={64}
                            aria-labelledby={labelId}
                            aria-describedby={describedBy}
                        />
                    )}
                </SettingsField>
            )}

            {showPwaOrientation && (
                <SettingsField
                    label={t('settings.openchamber.visual.field.installOrientation')}
                    description={t('settings.openchamber.visual.field.installOrientationDescription')}
                    reset={{
                        onReset: () => handlePwaOrientationChange('system'),
                        disabled: pwaOrientation === 'system',
                        ariaLabel: t('settings.openchamber.visual.actions.resetInstallOrientationAria'),
                    }}
                >
                    {({ labelId, describedBy }) => (
                        <OptionSelect
                            value={pwaOrientation}
                            options={PWA_ORIENTATION_OPTIONS}
                            onValueChange={handlePwaOrientationChange}
                            labelId={labelId}
                            describedBy={describedBy}
                        />
                    )}
                </SettingsField>
            )}
        </AppearanceSectionShell>
    );
});
