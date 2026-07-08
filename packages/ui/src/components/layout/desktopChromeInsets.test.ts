import { describe, expect, test } from 'bun:test';
import {
  DESKTOP_CHROME_DEFAULT_INSET,
  DESKTOP_CHROME_TRAFFIC_LIGHT_INSET,
  getDesktopChromeLeftInset,
  getDesktopChromeLeftInsetClassName,
} from './desktopChromeInsets';

describe('desktopChromeInsets', () => {
  test('uses traffic-light inset when macOS desktop chrome should avoid controls', () => {
    expect(getDesktopChromeLeftInset({ avoidMacTrafficLights: true })).toBe(DESKTOP_CHROME_TRAFFIC_LIGHT_INSET);
    expect(getDesktopChromeLeftInsetClassName({ avoidMacTrafficLights: true })).toBe('left-[5.5rem]');
  });

  test('uses default inset otherwise', () => {
    expect(getDesktopChromeLeftInset({ avoidMacTrafficLights: false })).toBe(DESKTOP_CHROME_DEFAULT_INSET);
    expect(getDesktopChromeLeftInsetClassName({ avoidMacTrafficLights: false })).toBe('left-3');
  });
});
