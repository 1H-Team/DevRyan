import React from 'react';

import { useAuthPrincipal } from '@/lib/authSession';
import { isDesktopShell, isWebRuntime } from '@/lib/desktop';
import { useDeviceInfo } from '@/lib/device';
import { supportsMobileKeyboardResizeContent } from '@/lib/mobileKeyboardMode';
import { cn } from '@/lib/utils';
import { usePwaDetection } from '@/hooks/usePwaDetection';
import { AppearancePreview } from './appearance/AppearancePreview';
import { CodeAndFilesSection } from './appearance/CodeAndFilesSection';
import { ComposerSection } from './appearance/ComposerSection';
import { ConversationSection } from './appearance/ConversationSection';
import type { AppearanceSectionProps } from './appearance/controls';
import { LayoutSection } from './appearance/LayoutSection';
import { MobileInstallSection } from './appearance/MobileInstallSection';
import { RegionalSection } from './appearance/RegionalSection';
import { ThemeSection } from './appearance/ThemeSection';
import { TypographySection } from './appearance/TypographySection';
import { getAppearanceSections, type AppearanceSectionId, type VisibleSetting } from './appearance/visibleSettings';
import { isVisualSettingAllowedByPolicy } from './visualSettingsPolicy';

export type { VisibleSetting } from './appearance/visibleSettings';

const SECTION_COMPONENTS: Record<AppearanceSectionId, React.ComponentType<AppearanceSectionProps>> = {
    theme: ThemeSection,
    typography: TypographySection,
    layout: LayoutSection,
    conversation: ConversationSection,
    codeAndFiles: CodeAndFilesSection,
    composer: ComposerSection,
    regional: RegionalSection,
    mobileInstall: MobileInstallSection,
};

interface OpenChamberVisualSettingsProps {
    /** Which settings to show. If undefined, shows all. */
    visibleSettings?: readonly VisibleSetting[];
    /** Show the live Appearance preview beside (wide) or above (narrow) the settings. */
    preview?: boolean;
}

export const OpenChamberVisualSettings: React.FC<OpenChamberVisualSettingsProps> = ({ visibleSettings, preview = false }) => {
    const { isMobile } = useDeviceInfo();
    const { browserTab } = usePwaDetection();
    const principal = useAuthPrincipal();
    const webRuntime = isWebRuntime();
    const desktopShell = isDesktopShell();
    const keyboardResize = supportsMobileKeyboardResizeContent();

    const sections = React.useMemo(() => getAppearanceSections(
        (setting) => isVisualSettingAllowedByPolicy(setting, principal)
            && (!visibleSettings || visibleSettings.includes(setting)),
        {
            isMobile,
            isWebRuntime: webRuntime,
            isDesktopShell: desktopShell,
            isBrowserTab: browserTab,
            supportsKeyboardResize: keyboardResize,
        },
    ), [browserTab, desktopShell, isMobile, keyboardResize, principal, visibleSettings, webRuntime]);

    return (
        <div className="@container">
            <div className={cn(preview && '@4xl:grid @4xl:grid-cols-[minmax(0,1fr)_18rem] @4xl:items-start @4xl:gap-8')}>
                {preview ? (
                    <AppearancePreview
                        showChatWidth={!isMobile}
                        className="mb-8 @4xl:sticky @4xl:top-4 @4xl:col-start-2 @4xl:row-start-1 @4xl:mb-0"
                    />
                ) : null}
                <div className="flex min-w-0 flex-col gap-8 @4xl:col-start-1 @4xl:row-start-1">
                    {sections.map((section) => {
                        const Section = SECTION_COMPONENTS[section.id];
                        return <Section key={section.id} rows={section.rows} isMobile={isMobile} />;
                    })}
                </div>
            </div>
        </div>
    );
};
