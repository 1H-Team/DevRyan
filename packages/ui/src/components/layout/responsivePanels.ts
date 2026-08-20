import { getBrowserSidebarFit } from './browserPanelLayout';

export const RIGHT_SIDEBAR_AUTO_CLOSE_WIDTH = 1140;
export const RIGHT_SIDEBAR_AUTO_OPEN_WIDTH = 1220;
export const BOTTOM_TERMINAL_AUTO_CLOSE_HEIGHT = 640;
export const BOTTOM_TERMINAL_AUTO_OPEN_HEIGHT = 700;

export type ResponsivePanelAction = 'close' | 'open' | 'none';

export interface ResponsivePanelState {
  width: number;
  height: number;
  isMobile: boolean;
  isTablet: boolean;
  isRightSidebarOpen: boolean;
  isBottomTerminalOpen: boolean;
  rightSidebarAutoClosed: boolean;
  bottomTerminalAutoClosed: boolean;
  browserPanelOpen?: boolean;
  browserPanelExpanded?: boolean;
  browserPanelPreferredWidth?: number;
  contextPanelWidth?: number;
  leftSidebarWidth?: number;
  rightSidebarWidth?: number;
}

export interface ResponsivePanelDecision {
  rightSidebarAction: ResponsivePanelAction;
  rightSidebarAutoClosed: boolean;
  bottomTerminalAction: ResponsivePanelAction;
  bottomTerminalAutoClosed: boolean;
}

export interface ResponsivePanelVisibilityChangeState {
  autoClosed: boolean;
  didVisibilityChange: boolean;
  isResponsiveChange: boolean;
}

export const getAutoClosedAfterPanelVisibilityChange = ({
  autoClosed,
  didVisibilityChange,
  isResponsiveChange,
}: ResponsivePanelVisibilityChangeState): boolean => {
  if (!didVisibilityChange || isResponsiveChange) {
    return autoClosed;
  }

  return false;
};

export const getResponsivePanelDecision = ({
  width,
  height,
  isMobile,
  isTablet,
  isRightSidebarOpen,
  isBottomTerminalOpen,
  rightSidebarAutoClosed,
  bottomTerminalAutoClosed,
  browserPanelOpen = false,
  browserPanelExpanded = false,
  browserPanelPreferredWidth = 600,
  contextPanelWidth = 0,
  leftSidebarWidth = 0,
  rightSidebarWidth = 0,
}: ResponsivePanelState): ResponsivePanelDecision => {
  let rightSidebarAction: ResponsivePanelAction = 'none';
  let nextRightSidebarAutoClosed = rightSidebarAutoClosed;

  const browserFit = browserPanelOpen && !browserPanelExpanded
    ? getBrowserSidebarFit({
      windowWidth: width,
      leftSidebarWidth,
      rightSidebarWidth,
      contextPanelWidth,
      browserPreferredWidth: browserPanelPreferredWidth,
    })
    : null;

  if (width < RIGHT_SIDEBAR_AUTO_CLOSE_WIDTH || browserFit?.fits === false) {
    if (isRightSidebarOpen) {
      rightSidebarAction = 'close';
      nextRightSidebarAutoClosed = true;
    }
  } else if (
    width >= RIGHT_SIDEBAR_AUTO_OPEN_WIDTH
    && rightSidebarAutoClosed
    && (browserFit === null || browserFit.fitsWithRestoreBuffer)
  ) {
    rightSidebarAction = 'open';
    nextRightSidebarAutoClosed = false;
  }

  let bottomTerminalAction: ResponsivePanelAction = 'none';
  let nextBottomTerminalAutoClosed = bottomTerminalAutoClosed;

  // Touch keyboards resize the visual viewport frequently, so keep bottom-terminal
  // auto-collapse desktop-only rather than treating mobile viewport churn as intent.
  if (!isMobile && !isTablet) {
    if (height < BOTTOM_TERMINAL_AUTO_CLOSE_HEIGHT) {
      if (isBottomTerminalOpen) {
        bottomTerminalAction = 'close';
        nextBottomTerminalAutoClosed = true;
      }
    } else if (height >= BOTTOM_TERMINAL_AUTO_OPEN_HEIGHT && bottomTerminalAutoClosed) {
      bottomTerminalAction = 'open';
      nextBottomTerminalAutoClosed = false;
    }
  }

  return {
    rightSidebarAction,
    rightSidebarAutoClosed: nextRightSidebarAutoClosed,
    bottomTerminalAction,
    bottomTerminalAutoClosed: nextBottomTerminalAutoClosed,
  };
};
