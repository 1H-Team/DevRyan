import { describe, expect, test } from 'bun:test';
import {
  getAutoClosedAfterPanelVisibilityChange,
  getResponsivePanelDecision,
} from './responsivePanels';

const baseState = {
  width: 1280,
  height: 800,
  isMobile: false,
  isTablet: false,
  isRightSidebarOpen: true,
  isBottomTerminalOpen: true,
  rightSidebarAutoClosed: false,
  bottomTerminalAutoClosed: false,
};

describe('getResponsivePanelDecision', () => {
  test('auto-closes the right sidebar below the narrow viewport threshold', () => {
    const decision = getResponsivePanelDecision({
      ...baseState,
      width: 1139,
    });

    expect(decision.rightSidebarAction).toBe('close');
    expect(decision.rightSidebarAutoClosed).toBe(true);
  });

  test('auto-reopens the right sidebar only when a previous responsive close is pending', () => {
    const pendingRestore = getResponsivePanelDecision({
      ...baseState,
      width: 1220,
      isRightSidebarOpen: false,
      rightSidebarAutoClosed: true,
    });

    const manualClose = getResponsivePanelDecision({
      ...baseState,
      width: 1220,
      isRightSidebarOpen: false,
      rightSidebarAutoClosed: false,
    });

    expect(pendingRestore.rightSidebarAction).toBe('open');
    expect(pendingRestore.rightSidebarAutoClosed).toBe(false);
    expect(manualClose.rightSidebarAction).toBe('none');
    expect(manualClose.rightSidebarAutoClosed).toBe(false);
  });

  test('does not auto-reopen in the right sidebar deadband', () => {
    const decision = getResponsivePanelDecision({
      ...baseState,
      width: 1180,
      isRightSidebarOpen: false,
      rightSidebarAutoClosed: true,
    });

    expect(decision.rightSidebarAction).toBe('none');
    expect(decision.rightSidebarAutoClosed).toBe(true);
  });

  test('keeps bottom terminal responsive collapse desktop-only', () => {
    const desktopDecision = getResponsivePanelDecision({
      ...baseState,
      height: 639,
    });
    const mobileDecision = getResponsivePanelDecision({
      ...baseState,
      height: 639,
      isMobile: true,
    });

    expect(desktopDecision.bottomTerminalAction).toBe('close');
    expect(desktopDecision.bottomTerminalAutoClosed).toBe(true);
    expect(mobileDecision.bottomTerminalAction).toBe('none');
    expect(mobileDecision.bottomTerminalAutoClosed).toBe(false);
  });

  test('closes the right sidebar when an open Browser would compress chat', () => {
    const decision = getResponsivePanelDecision({
      ...baseState,
      width: 1632,
      leftSidebarWidth: 318,
      rightSidebarWidth: 300,
      browserPanelOpen: true,
      browserPanelPreferredWidth: 750,
    });

    expect(decision.rightSidebarAction).toBe('close');
    expect(decision.rightSidebarAutoClosed).toBe(true);
  });

  test('restores a Browser-induced close only after the fit buffer is available', () => {
    const pending = getResponsivePanelDecision({
      ...baseState,
      width: 1440,
      isRightSidebarOpen: false,
      rightSidebarAutoClosed: true,
      leftSidebarWidth: 220,
      rightSidebarWidth: 300,
      browserPanelOpen: true,
      browserPanelPreferredWidth: 600,
    });
    const ready = getResponsivePanelDecision({
      ...baseState,
      width: 1520,
      isRightSidebarOpen: false,
      rightSidebarAutoClosed: true,
      leftSidebarWidth: 220,
      rightSidebarWidth: 300,
      browserPanelOpen: true,
      browserPanelPreferredWidth: 600,
    });

    expect(pending.rightSidebarAction).toBe('none');
    expect(ready.rightSidebarAction).toBe('open');
  });
});

describe('getAutoClosedAfterPanelVisibilityChange', () => {
  test('preserves pending restore for responsive changes', () => {
    expect(getAutoClosedAfterPanelVisibilityChange({
      autoClosed: true,
      didVisibilityChange: true,
      isResponsiveChange: true,
    })).toBe(true);
  });

  test('clears pending restore for manual changes', () => {
    const afterManualOpen = getAutoClosedAfterPanelVisibilityChange({
      autoClosed: true,
      didVisibilityChange: true,
      isResponsiveChange: false,
    });
    const resizeWiderAfterManualClose = getResponsivePanelDecision({
      ...baseState,
      width: 1220,
      isRightSidebarOpen: false,
      rightSidebarAutoClosed: afterManualOpen,
    });

    expect(afterManualOpen).toBe(false);
    expect(resizeWiderAfterManualClose.rightSidebarAction).toBe('none');
  });
});
