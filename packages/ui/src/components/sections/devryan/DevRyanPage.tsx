import React from 'react';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { cn } from '@/lib/utils';
import type { DevRyanSection } from './types';
import { devRyanSectionResources } from './devRyanSectionResources';

interface DevRyanPageProps {
  section: DevRyanSection;
}

export const DevRyanPage: React.FC<DevRyanPageProps> = ({ section }) => {
  const Content = devRyanSectionResources[section].Component;
  return (
    <ScrollableOverlay outerClassName="h-full" className="w-full">
      {/* Appearance is wider so its live preview can sit beside the settings. */}
      <div className={cn('devryan-page-body mx-auto space-y-6 p-3 sm:p-6 sm:pt-8', section === 'visual' ? 'max-w-6xl' : 'max-w-3xl')}>
        <Content />
      </div>
    </ScrollableOverlay>
  );
};
