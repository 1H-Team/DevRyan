import React from 'react';

import type { SettingsPageSlug } from '@/lib/settings/metadata';
import {
  isSettingsSectionReady,
  preloadSettingsSection,
  preloadSettingsSectionsWhenIdle,
} from './settingsSectionLoaders';

export const createPreparedSettingsNavigationCoordinator = <Slug extends SettingsPageSlug>({
  isReady,
  preload,
  onPendingChange,
}: {
  isReady: (slug: Slug) => boolean;
  preload: (slug: Slug) => Promise<void>;
  onPendingChange: (slug: Slug | null) => void;
}) => {
  let request = 0;
  return {
    navigate({ currentSlug, slug, commit }: { currentSlug: Slug; slug: Slug; commit: () => void }) {
      const currentRequest = request + 1;
      request = currentRequest;
      if (slug === currentSlug || isReady(slug)) {
        onPendingChange(null);
        commit();
        return;
      }

      onPendingChange(slug);
      void preload(slug)
        .catch(() => undefined)
        .then(() => {
          if (request === currentRequest) commit();
        })
        .finally(() => {
          if (request === currentRequest) onPendingChange(null);
        });
    },
    cancel() {
      request += 1;
    },
  };
};

export const usePreparedSettingsNavigation = <Slug extends SettingsPageSlug>({
  requestedSlug,
  preloadSlugs,
}: {
  requestedSlug: Slug;
  preloadSlugs: readonly Slug[];
}) => {
  const [displayedSlug, setDisplayedSlug] = React.useState<Slug>(requestedSlug);
  const [pendingSlug, setPendingSlug] = React.useState<Slug | null>(null);
  const displayedSlugRef = React.useRef(displayedSlug);
  const coordinatorRef = React.useRef<ReturnType<typeof createPreparedSettingsNavigationCoordinator<Slug>> | null>(null);
  if (!coordinatorRef.current) {
    coordinatorRef.current = createPreparedSettingsNavigationCoordinator<Slug>({
      isReady: isSettingsSectionReady,
      preload: preloadSettingsSection,
      onPendingChange: setPendingSlug,
    });
  }
  displayedSlugRef.current = displayedSlug;
  const preloadKey = preloadSlugs.join('\u0000');

  React.useEffect(() => {
    const slugs = preloadKey ? preloadKey.split('\u0000') as Slug[] : [];
    return preloadSettingsSectionsWhenIdle(slugs);
  }, [preloadKey]);

  React.useLayoutEffect(() => {
    coordinatorRef.current?.navigate({
      currentSlug: displayedSlugRef.current,
      slug: requestedSlug,
      commit: () => setDisplayedSlug(requestedSlug),
    });
  }, [requestedSlug]);

  React.useEffect(() => () => coordinatorRef.current?.cancel(), []);

  const prepareAndCommit = React.useCallback((slug: Slug, commit: () => void) => {
    coordinatorRef.current?.navigate({ currentSlug: displayedSlugRef.current, slug, commit });
  }, []);

  return { displayedSlug, pendingSlug, prepareAndCommit };
};
