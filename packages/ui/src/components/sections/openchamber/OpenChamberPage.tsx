import React from 'react';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import type { OpenChamberSection } from './types';
import { openChamberSectionResources, PreparedLegacyOpenChamberContent } from './openChamberSectionResources';

interface OpenChamberPageProps {
  /** Undefined retains the combined mobile/legacy page. */
  section?: OpenChamberSection;
}

export const OpenChamberPage: React.FC<OpenChamberPageProps> = ({ section }) => {
  if (!section) return <PreparedLegacyOpenChamberContent />;
  const Content = openChamberSectionResources[section].Component;
  return (
    <ScrollableOverlay outerClassName="h-full" className="w-full">
      <div className="openchamber-page-body mx-auto max-w-3xl space-y-6 p-3 sm:p-6 sm:pt-8">
        <Content />
      </div>
    </ScrollableOverlay>
  );
};
