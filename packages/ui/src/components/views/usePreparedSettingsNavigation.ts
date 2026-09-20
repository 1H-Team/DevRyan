import React from 'react';
import { getAuthPrincipal, useAuthPrincipal } from '@/lib/authSession';
import { canPrepareSettingsSection } from './SettingsView.access';

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
  canNavigate = () => true,
}: {
  isReady: (slug: Slug) => boolean;
  preload: (slug: Slug) => Promise<void>;
  onPendingChange: (slug: Slug | null) => void;
  canNavigate?: (slug: Slug) => boolean;
}) => {
  let request = 0;
  return {
    navigate({ currentSlug, slug, commit }: { currentSlug: Slug; slug: Slug; commit: () => void }) {
      const currentRequest = request + 1;
      request = currentRequest;
      if (!canNavigate(slug)) {
        onPendingChange(null);
        return;
      }
      if (slug === currentSlug || isReady(slug)) {
        onPendingChange(null);
        commit();
        return;
      }

      onPendingChange(slug);
      void preload(slug)
        .catch(() => undefined)
        .then(() => {
          if (request === currentRequest && canNavigate(slug)) commit();
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
  const principal = useAuthPrincipal();
  const [displayedSlug, setDisplayedSlug] = React.useState<Slug>(requestedSlug);
  const [pendingSlug, setPendingSlug] = React.useState<Slug | null>(null);
  const allowedRef = React.useRef(preloadSlugs);
  allowedRef.current = preloadSlugs;
  const safeDisplayedSlug = displayedSlug === 'home' || (preloadSlugs.includes(displayedSlug)
    && canPrepareSettingsSection(principal, displayedSlug)) ? displayedSlug : requestedSlug;
  const displayedSlugRef = React.useRef(safeDisplayedSlug);
  const coordinatorRef = React.useRef<ReturnType<typeof createPreparedSettingsNavigationCoordinator<Slug>> | null>(null);
  if (!coordinatorRef.current) {
    coordinatorRef.current = createPreparedSettingsNavigationCoordinator<Slug>({
      isReady: isSettingsSectionReady,
      preload: preloadSettingsSection,
      onPendingChange: setPendingSlug,
      canNavigate: (slug) => (slug === 'home' || allowedRef.current.includes(slug))
        && canPrepareSettingsSection(getAuthPrincipal(), slug),
    });
  }
  displayedSlugRef.current = safeDisplayedSlug;
  const preloadKey = preloadSlugs.join('\u0000');

  React.useEffect(() => {
    const slugs = preloadKey ? preloadKey.split('\u0000') as Slug[] : [];
    return preloadSettingsSectionsWhenIdle(slugs);
  }, [preloadKey, principal]);

  React.useLayoutEffect(() => {
    // Also prepare cold initial/direct entries; their frame is already visible.
    void preloadSettingsSection(requestedSlug).catch(() => undefined);
    coordinatorRef.current?.navigate({
      currentSlug: displayedSlugRef.current,
      slug: requestedSlug,
      commit: () => setDisplayedSlug(requestedSlug),
    });
    return () => coordinatorRef.current?.cancel();
  }, [requestedSlug, principal, preloadKey]);

  React.useEffect(() => () => coordinatorRef.current?.cancel(), []);

  const prepareAndCommit = React.useCallback((slug: Slug, commit: () => void) => {
    coordinatorRef.current?.navigate({ currentSlug: displayedSlugRef.current, slug, commit });
  }, []);

  const cancelPending = React.useCallback(() => {
    coordinatorRef.current?.cancel();
    setPendingSlug(null);
  }, []);

  return { displayedSlug: safeDisplayedSlug, pendingSlug, prepareAndCommit, cancelPending };
};
