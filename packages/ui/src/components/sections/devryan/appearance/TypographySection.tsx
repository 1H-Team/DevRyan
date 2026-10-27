import React from 'react';

import { SettingsField } from '@/components/sections/shared/SettingsField';
import { CODE_FONT_OPTIONS, UI_FONT_OPTIONS } from '@/lib/fontOptions';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { APPEARANCE_DEFAULTS, FONT_SIZE_RANGE, TERMINAL_FONT_SIZE_RANGE } from './appearanceDefaults';
import { AppearanceSectionShell, FontSelect, UnitNumberInput, type AppearanceSectionProps } from './controls';

export const TypographySection = React.memo(function TypographySection({ rows }: AppearanceSectionProps) {
    const { t } = useI18n();
    const uiFont = useUIStore((state) => state.uiFont);
    const setUiFont = useUIStore((state) => state.setUiFont);
    const monoFont = useUIStore((state) => state.monoFont);
    const setMonoFont = useUIStore((state) => state.setMonoFont);
    const fontSize = useUIStore((state) => state.fontSize);
    const setFontSize = useUIStore((state) => state.setFontSize);
    const terminalFontSize = useUIStore((state) => state.terminalFontSize);
    const setTerminalFontSize = useUIStore((state) => state.setTerminalFontSize);

    return (
        <AppearanceSectionShell
            title={t('settings.devryan.visual.section.typography')}
            description={t('settings.devryan.visual.section.typographyDescription')}
        >
            {rows.includes('fontSize') && (
                <SettingsField
                    label={t('settings.devryan.visual.field.interfaceFont')}
                    description={t('settings.devryan.visual.field.interfaceFontDescription')}
                    reset={{
                        onReset: () => setUiFont(APPEARANCE_DEFAULTS.uiFont),
                        disabled: uiFont === APPEARANCE_DEFAULTS.uiFont,
                        ariaLabel: t('settings.devryan.visual.actions.resetInterfaceFontAria'),
                    }}
                >
                    {({ labelId, describedBy }) => (
                        <FontSelect value={uiFont} options={UI_FONT_OPTIONS} onValueChange={setUiFont} labelId={labelId} describedBy={describedBy} />
                    )}
                </SettingsField>
            )}

            {rows.includes('codeFont') && (
                <SettingsField
                    label={t('settings.devryan.visual.field.codeFont')}
                    description={t('settings.devryan.visual.field.codeFontDescription')}
                    reset={{
                        onReset: () => setMonoFont(APPEARANCE_DEFAULTS.monoFont),
                        disabled: monoFont === APPEARANCE_DEFAULTS.monoFont,
                        ariaLabel: t('settings.devryan.visual.actions.resetCodeFontAria'),
                    }}
                >
                    {({ labelId, describedBy }) => (
                        <FontSelect value={monoFont} options={CODE_FONT_OPTIONS} onValueChange={setMonoFont} labelId={labelId} describedBy={describedBy} />
                    )}
                </SettingsField>
            )}

            {rows.includes('fontSize') && (
                <SettingsField
                    label={t('settings.devryan.visual.field.interfaceFontSize')}
                    description={t('settings.devryan.visual.field.interfaceFontSizeDescription')}
                    reset={{
                        onReset: () => setFontSize(APPEARANCE_DEFAULTS.fontSize),
                        disabled: fontSize === APPEARANCE_DEFAULTS.fontSize,
                        ariaLabel: t('settings.devryan.visual.actions.resetFontSizeAria'),
                    }}
                >
                    {({ labelId, describedBy }) => (
                        <UnitNumberInput
                            value={fontSize}
                            onValueChange={setFontSize}
                            {...FONT_SIZE_RANGE}
                            unit="%"
                            ariaLabel={t('settings.devryan.visual.field.fontSizePercentageAria')}
                            labelId={labelId}
                            describedBy={describedBy}
                        />
                    )}
                </SettingsField>
            )}

            {rows.includes('terminalFontSize') && (
                <SettingsField
                    label={t('settings.devryan.visual.field.terminalFontSize')}
                    description={t('settings.devryan.visual.field.terminalFontSizeDescription')}
                    reset={{
                        onReset: () => setTerminalFontSize(APPEARANCE_DEFAULTS.terminalFontSize),
                        disabled: terminalFontSize === APPEARANCE_DEFAULTS.terminalFontSize,
                        ariaLabel: t('settings.devryan.visual.actions.resetTerminalFontSizeAria'),
                    }}
                >
                    {({ labelId, describedBy }) => (
                        <UnitNumberInput
                            value={terminalFontSize}
                            onValueChange={setTerminalFontSize}
                            {...TERMINAL_FONT_SIZE_RANGE}
                            unit="px"
                            ariaLabel={t('settings.devryan.visual.field.terminalFontSizeAria')}
                            labelId={labelId}
                            describedBy={describedBy}
                        />
                    )}
                </SettingsField>
            )}
        </AppearanceSectionShell>
    );
});
