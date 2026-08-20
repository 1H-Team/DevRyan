export const BROWSER_PANEL_MIN_WIDTH = 360;
export const BROWSER_PANEL_MAX_WIDTH = 1400;
export const BROWSER_PRIMARY_RESERVE_PX = 320;
export const BROWSER_CONSTRAINED_SHARE = 0.45;
export const BROWSER_SIDEBAR_RESTORE_HYSTERESIS_PX = 80;

const finiteNonNegative = (value: number): number => (
  Number.isFinite(value) ? Math.max(0, value) : 0
);

export const clampBrowserPanelPreferredWidth = (value: number): number => {
  if (!Number.isFinite(value)) return 600;
  return Math.min(BROWSER_PANEL_MAX_WIDTH, Math.max(BROWSER_PANEL_MIN_WIDTH, Math.round(value)));
};

export type BrowserPanelWidthInput = {
  preferredWidth: number;
  availableWidth: number;
  expanded?: boolean;
};

export const resolveBrowserPanelWidth = ({
  preferredWidth,
  availableWidth,
  expanded = false,
}: BrowserPanelWidthInput): number => {
  const available = finiteNonNegative(availableWidth);
  if (expanded) return Math.round(available);

  const preferred = clampBrowserPanelPreferredWidth(preferredWidth);
  const primaryReserve = available >= BROWSER_PRIMARY_RESERVE_PX + BROWSER_PANEL_MIN_WIDTH
    ? BROWSER_PRIMARY_RESERVE_PX
    : available * (1 - BROWSER_CONSTRAINED_SHARE);
  const maximum = Math.max(0, available - primaryReserve);
  return Math.round(Math.min(preferred, maximum));
};

export type BrowserSidebarFitInput = {
  windowWidth: number;
  leftSidebarWidth: number;
  rightSidebarWidth: number;
  contextPanelWidth: number;
  browserPreferredWidth: number;
};

export const getBrowserSidebarFit = ({
  windowWidth,
  leftSidebarWidth,
  rightSidebarWidth,
  contextPanelWidth,
  browserPreferredWidth,
}: BrowserSidebarFitInput): { fits: boolean; fitsWithRestoreBuffer: boolean } => {
  const workspaceWithSidebar = finiteNonNegative(windowWidth)
    - finiteNonNegative(leftSidebarWidth)
    - finiteNonNegative(rightSidebarWidth)
    - finiteNonNegative(contextPanelWidth);
  const required = clampBrowserPanelPreferredWidth(browserPreferredWidth) + BROWSER_PRIMARY_RESERVE_PX;
  return {
    fits: workspaceWithSidebar >= required,
    fitsWithRestoreBuffer: workspaceWithSidebar >= required + BROWSER_SIDEBAR_RESTORE_HYSTERESIS_PX,
  };
};
