export const DESKTOP_CHROME_TRAFFIC_LIGHT_INSET = '5.5rem';
export const DESKTOP_CHROME_DEFAULT_INSET = '0.75rem';

export type DesktopChromeInsetOptions = {
  avoidMacTrafficLights: boolean;
};

export const getDesktopChromeLeftInset = ({
  avoidMacTrafficLights,
}: DesktopChromeInsetOptions): string => {
  return avoidMacTrafficLights ? DESKTOP_CHROME_TRAFFIC_LIGHT_INSET : DESKTOP_CHROME_DEFAULT_INSET;
};

export const getDesktopChromeLeftInsetClassName = ({
  avoidMacTrafficLights,
}: DesktopChromeInsetOptions): string => {
  return avoidMacTrafficLights ? 'left-[5.5rem]' : 'left-3';
};

/** Width reserved in the center header so title does not sit under fixed left chrome. */
export const DESKTOP_LEFT_CHROME_CLUSTER_WIDTH = 'calc(5.5rem + 4.75rem)';
