import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '@/styles/fonts';
import '@/index.css';
import { ThemeProvider } from '@/components/providers/ThemeProvider';
import { ThemeSystemProvider } from '@/contexts/ThemeSystemContext';
import { initializeLocale, I18nProvider } from '@/lib/i18n';
import { initializeAppearancePreferences, syncDesktopSettings } from '@/lib/persistence';
import { BrowserPopoutApp } from '@/components/layout/DesktopBrowserPane';

export const renderBrowserPopoutApp = (): void => {
  initializeLocale();
  void initializeAppearancePreferences().then(() => syncDesktopSettings()).catch(() => undefined);
  const root = document.getElementById('root');
  if (!root) throw new Error('Root element not found');
  createRoot(root).render(
    <StrictMode>
      <I18nProvider>
        <ThemeSystemProvider>
          <ThemeProvider>
            <BrowserPopoutApp />
          </ThemeProvider>
        </ThemeSystemProvider>
      </I18nProvider>
    </StrictMode>,
  );
};
