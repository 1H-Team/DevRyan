import React from 'react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { isDesktopShell, startDesktopWindowDrag } from '@/lib/desktop';
import { BundledRuntimeSetup } from './BundledRuntimeSetup';

type LocalSetupScreenProps = { onBack: () => void; onCliAvailable?: () => void; isFromRecovery?: boolean; onSwitchToRemote?: () => void };
export function LocalSetupScreen({ onBack, onCliAvailable, isFromRecovery = false, onSwitchToRemote }: LocalSetupScreenProps) {
  const { t } = useI18n();
  return <div className="h-full overflow-y-auto flex items-center justify-center bg-transparent p-8" onMouseDown={event => {
    if (event.button === 0 && isDesktopShell() && !(event.target instanceof HTMLElement && event.target.closest('button,a,input'))) void startDesktopWindowDrag();
  }}><div className="w-full max-w-lg space-y-4">
    <Button variant="ghost" onClick={onBack}>{t('onboarding.common.actions.back')}</Button>
    <h1 className="typography-ui-header text-foreground">{t('onboarding.localSetup.title')}</h1>
    <BundledRuntimeSetup onAvailable={onCliAvailable} />
    {isFromRecovery && onSwitchToRemote && <Button variant="link" onClick={onSwitchToRemote}>{t('onboarding.localSetup.actions.connectRemoteServer')}</Button>}
  </div></div>;
}
