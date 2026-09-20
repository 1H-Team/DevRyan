import React from 'react';
import { isDesktopShell, isDesktopLocalOriginActive } from '@/lib/desktop';
import { DefaultsSettings } from './DefaultsSettings';
import { AgentModelDefaultsSettings } from './AgentModelDefaultsSettings';
import { OpenCodeCliSettings } from './OpenCodeCliSettings';
import { DesktopKeepAwakeSettings } from './DesktopKeepAwakeSettings';
import { AgentBrowserControlSettings } from './AgentBrowserControlSettings';
import { DesktopNetworkSettings } from './DesktopNetworkSettings';

export const SessionsSectionContent: React.FC = () => {

    const showDesktopNetworkSettings = isDesktopShell() && isDesktopLocalOriginActive();
    return (
        <div className="space-y-6">
            <DefaultsSettings />
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
        </div>
    );
};
