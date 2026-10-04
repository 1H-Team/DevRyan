import React from 'react';
import { Button } from '@/components/ui/button';
import { isDesktopShell, isTauriShell, startDesktopWindowDrag } from '@/lib/desktop';
import { desktopHostsGet, desktopHostsSet } from '@/lib/desktopHosts';
import { useI18n } from '@/lib/i18n';
import { RemoteConnectionForm } from './RemoteConnectionForm';
import { BundledRuntimeSetup } from './BundledRuntimeSetup';

type ChooserScreenProps = { onCliAvailable?: () => void };
export function ChooserScreen({ onCliAvailable }: ChooserScreenProps) {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = React.useState<'local' | 'remote'>('local');
  const canChooseRemote = isDesktopShell() && isTauriShell();
  const announceAvailable = React.useCallback(async () => {
    if (isTauriShell()) { const config = await desktopHostsGet(); await desktopHostsSet({ ...config, defaultHostId: 'local', initialHostChoiceCompleted: true }); }
    onCliAvailable?.();
  }, [onCliAvailable]);
  return <div className="h-full overflow-y-auto flex items-center justify-center bg-transparent p-8" onMouseDown={event => {
    if (event.button === 0 && isDesktopShell() && !(event.target instanceof HTMLElement && event.target.closest('button,a,input'))) void startDesktopWindowDrag();
  }}><div className="w-full max-w-md space-y-6">
    <header><h1 className="typography-ui-header">{t('onboarding.chooser.title')}</h1><p className="typography-body text-muted-foreground">{t('onboarding.chooser.description')}</p></header>
    {canChooseRemote && <div className="flex gap-2"><Button variant={activeTab === 'local' ? 'secondary' : 'outline'} onClick={() => setActiveTab('local')}>{t('onboarding.chooser.tabs.localInstall')}</Button><Button variant={activeTab === 'remote' ? 'secondary' : 'outline'} onClick={() => setActiveTab('remote')}>{t('onboarding.chooser.tabs.connectRemote')}</Button></div>}
    {canChooseRemote && activeTab === 'remote' ? <RemoteConnectionForm onBack={() => setActiveTab('local')} showBackButton={false} onSwitchToLocal={() => setActiveTab('local')} /> : <BundledRuntimeSetup onAvailable={announceAvailable} />}
  </div></div>;
}
