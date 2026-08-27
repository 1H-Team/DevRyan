import { hasAuthCapability, type AuthPrincipal } from '@/lib/authSession';

import type { VisibleSetting } from './OpenChamberVisualSettings';

export const isVisualSettingAllowedByPolicy = (
    setting: VisibleSetting,
    principal: AuthPrincipal,
): boolean => (
    (setting !== 'terminalFontSize' && setting !== 'terminalQuickKeys')
    || hasAuthCapability(principal, 'terminal')
);
