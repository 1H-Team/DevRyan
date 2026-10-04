import * as React from 'react';
import { useI18n } from '@/lib/i18n';
import { OpenCodeVersionSection } from './OpenCodeVersionSection';
/** Compatibility component identity; runtime selection belongs to the verified bundle owner. */
export const OpenCodeCliSettings: React.FC = () => {
  const { t } = useI18n();
  return <div className="mb-8"><h3 className="typography-ui-header font-medium">{t('settings.openchamber.opencodeCli.title')}</h3><OpenCodeVersionSection compact /></div>;
};
