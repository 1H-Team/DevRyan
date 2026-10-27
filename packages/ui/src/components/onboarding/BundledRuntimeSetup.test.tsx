import {expect,test} from 'bun:test';
import {renderToStaticMarkup} from 'react-dom/server';
import {I18nProvider} from '@/lib/i18n';
import {LocalSetupScreen} from './LocalSetupScreen';
import {ChooserScreen} from './ChooserScreen';
import {getDesktopRecoveryConfig} from './desktopRecoveryConfig';
test('local and recovery setup expose bundled readiness and the existing DevRyan updater',()=>{
 const markup=renderToStaticMarkup(<I18nProvider><LocalSetupScreen onBack={()=>{}} isFromRecovery onSwitchToRemote={()=>{}} /></I18nProvider>);
 expect(markup).toContain('DevRyan includes OpenCode');expect(markup).toContain('Retry and Continue');expect(markup).toContain('Check Updates');expect(markup).toContain('Connect to Remote Server');
 expect(/curl|opencode.ai\/install|OPENCODE_BINARY|type="text"|WSL/.test(markup)).toBe(false);
 expect(/curl|opencode.ai\/install|OPENCODE_BINARY|WSL/.test(renderToStaticMarkup(<I18nProvider><ChooserScreen /></I18nProvider>))).toBe(false);
 expect(getDesktopRecoveryConfig('local-unavailable').description).toContain('bundled runtime');
});
