import React from 'react';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { useDeviceInfo } from '@/lib/device';
import { isDesktopLocalOriginActive, isDesktopShell, isWebRuntime } from '@/lib/desktop';
import { OpenChamberVisualSettings } from './OpenChamberVisualSettings';
import { AboutSettings } from './AboutSettings';
import { PasskeySettings } from './PasskeySettings';
import { DefaultsSettings } from './DefaultsSettings';
import { AgentModelDefaultsSettings } from './AgentModelDefaultsSettings';
import { OpenCodeCliSettings } from './OpenCodeCliSettings';
import { DesktopKeepAwakeSettings } from './DesktopKeepAwakeSettings';
import { AgentBrowserControlSettings } from './AgentBrowserControlSettings';
import { DesktopNetworkSettings } from './DesktopNetworkSettings';

/** Preserves the combined section-less page without coupling normal destinations. */
export const LegacyOpenChamberContent: React.FC = () => {
    const { isMobile } = useDeviceInfo();
    const showAbout = isMobile && isWebRuntime();
    const showDesktopNetworkSettings = isDesktopShell() && isDesktopLocalOriginActive();
        return (
            <ScrollableOverlay
                outerClassName="h-full"
                className="w-full"
            >
                <div className="openchamber-page-body mx-auto max-w-3xl space-y-3 p-3 sm:space-y-6 sm:p-6 sm:pt-8">
                    <OpenChamberVisualSettings />
                    <div className="border-t border-border/40 pt-6">
                        <DefaultsSettings />
                    </div>
                    <AgentModelDefaultsSettings />
                    {(
                        <div className="border-t border-border/40 pt-6">
                            <OpenCodeCliSettings />
                        </div>
                    )}
                    {showDesktopNetworkSettings && (
                        <div className="border-t border-border/40 pt-6">
                            <DesktopKeepAwakeSettings />
                            <AgentBrowserControlSettings />
                            <DesktopNetworkSettings />
                        </div>
                    )}
                    <div className="border-t border-border/40 pt-6">
                        <PasskeySettings />
                    </div>
                    {showAbout && (
                        <div className="border-t border-border/40 pt-6">
                            <AboutSettings />
                        </div>
                    )}
                </div>
            </ScrollableOverlay>
        );

};
