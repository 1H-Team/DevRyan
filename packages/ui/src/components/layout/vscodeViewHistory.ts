export type VSCodeView = 'sessions' | 'chat' | 'settings';
export type VSCodeContentView = Exclude<VSCodeView, 'settings'>;

export const rememberViewBeforeSettings = (
  currentView: VSCodeView,
  rememberedView: VSCodeContentView | null,
): VSCodeContentView | null => currentView === 'settings' ? rememberedView : currentView;

export const resolveViewAfterSettings = (
  rememberedView: VSCodeContentView | null,
  fallback: VSCodeContentView,
): VSCodeContentView => rememberedView ?? fallback;
