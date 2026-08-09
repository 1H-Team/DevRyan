const DEFAULT_SPLASH_BG_LIGHT = '#f5f5f4';
const DEFAULT_SPLASH_FG_LIGHT = '#1c1917';
const DEFAULT_SPLASH_BG_DARK = '#0c0a09';
const DEFAULT_SPLASH_FG_DARK = '#fafaf9';

const DEVRYAN_ICON_CLIP_PATH = 'M48.18,50.68v425.54h497.18V50.68H48.18ZM346.33,85.39c-34.03,14.36-61.01,41.46-74.79,55.3-2.21,2.22-4.31,4.34-6.32,6.38-17.58,17.79-25.6,25.91-44.71,34.43-12.61,5.62-18.28,20.4-12.66,33.01,4.15,9.31,13.28,14.83,22.85,14.83,3.4,0,6.86-.7,10.16-2.17,27.72-12.35,41.23-26.03,59.94-44.97,1.96-1.99,4.01-4.06,6.18-6.24,8.23-8.26,22.56-22.65,39.36-33.88v18.52c-12.32,9.47-22.84,20.03-28.73,25.94-1.95,1.96-3.8,3.83-5.59,5.64l-.55.56c-19.11,19.34-34.2,34.62-64.5,48.12-5.17,2.3-10.64,3.47-16.27,3.47-15.78,0-30.13-9.31-36.55-23.73-8.98-20.15.11-43.84,20.26-52.82,16.54-7.37,22.96-13.88,40.14-31.27,2.03-2.05,4.13-4.19,6.36-6.42,15.32-15.39,45.92-46.11,85.42-60.88v16.16Z';
const DEVRYAN_ICON_PATH = 'M295.81,323.54v-113.1s0-26.82,0-26.82c0-16.33-4-30.24-12.69-43.26-4.31-6.45-9.94-12.34-16.48-17.49-17.21-13.54-40.75-21.94-63.27-21.94-55.78,0-100.99,45.21-100.99,100.99,0,93.03,90.44,176.35,188.66,222.77,3.63,1.72,7.83,1.72,11.46,0,98.22-46.42,188.66-129.73,188.66-222.77,0-55.78-45.21-100.99-100.99-100.99-42.15,0-80.16,36.55-100.92,57.39-22.14,22.24-32.59,34.43-58.57,46';

const readStringSetting = (settings, key, fallback) => {
  const value = settings && typeof settings[key] === 'string' ? settings[key].trim() : '';
  return value || fallback;
};

const escapeHtml = (value) => String(value || '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');

export const resolveStartupSplashVariant = (settings = {}) => {
  if (settings.themeMode === 'light') return 'light';
  if (settings.themeMode === 'dark') return 'dark';
  if (settings.themeMode === 'system' || settings.useSystemTheme === true) return 'system';
  if (settings.themeVariant === 'light') return 'light';
  if (settings.themeVariant === 'dark') return 'dark';
  return 'system';
};

const renderLogoSvg = (className, stroke) => `
      <svg class="${className}" width="169" height="169" viewBox="0 0 593.11 516.12" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="DevRyan loading icon">
        <defs>
          <clipPath id="${className}-clip">
            <path d="${DEVRYAN_ICON_CLIP_PATH}"/>
          </clipPath>
        </defs>
        <g clip-path="url(#${className}-clip)">
          <path d="${DEVRYAN_ICON_PATH}" stroke="${stroke}" stroke-linecap="round" stroke-linejoin="round" stroke-width="50"/>
        </g>
      </svg>`;

export const buildStartupSplashHtml = (settings = {}) => {
  const splashBgLight = readStringSetting(settings, 'splashBgLight', DEFAULT_SPLASH_BG_LIGHT);
  const splashFgLight = readStringSetting(settings, 'splashFgLight', DEFAULT_SPLASH_FG_LIGHT);
  const splashBgDark = readStringSetting(settings, 'splashBgDark', DEFAULT_SPLASH_BG_DARK);
  const splashFgDark = readStringSetting(settings, 'splashFgDark', DEFAULT_SPLASH_FG_DARK);
  const splashVariant = resolveStartupSplashVariant(settings);

  return `<!doctype html>
  <html data-splash-variant="${splashVariant}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      :root { color-scheme: light dark; }
      :root {
        --splash-background: ${splashBgLight};
        --splash-stroke: ${splashFgLight};
        --splash-face-fill: rgba(0, 0, 0, 0.15);
        --splash-cell-fill: rgba(0, 0, 0, 0.4);
      }
      html[data-splash-variant="dark"] {
        --splash-background: ${splashBgDark};
        --splash-stroke: ${splashFgDark};
        --splash-face-fill: rgba(255, 255, 255, 0.15);
        --splash-cell-fill: rgba(255, 255, 255, 0.35);
      }
      html[data-splash-variant="dark"] .splash-logo-light {
        display: none;
      }
      html[data-splash-variant="dark"] .splash-logo-dark {
        display: block;
      }
      html[data-splash-variant="light"] .splash-logo-dark,
      html[data-splash-variant="system"] .splash-logo-dark {
        display: none;
      }
      @media (prefers-color-scheme: dark) {
        html[data-splash-variant="system"] {
          --splash-background: ${splashBgDark};
          --splash-stroke: ${splashFgDark};
          --splash-face-fill: rgba(255, 255, 255, 0.15);
          --splash-cell-fill: rgba(255, 255, 255, 0.35);
        }
        html[data-splash-variant="system"] .splash-logo-light {
          display: none;
        }
        html[data-splash-variant="system"] .splash-logo-dark {
          display: block;
        }
      }
      @supports (color: color-mix(in srgb, white 50%, transparent)) {
        :root {
          --splash-face-fill: color-mix(in srgb, var(--splash-stroke) 15%, transparent);
          --splash-cell-fill: color-mix(in srgb, var(--splash-stroke) 35%, transparent);
        }
      }
      body {
        margin: 0;
        font-family: "IBM Plex Sans", sans-serif;
        display: grid;
        place-items: center;
        height: 100vh;
        background: var(--splash-background);
        color: var(--splash-stroke);
      }
      .stack {
        display: grid;
        justify-items: center;
      }
    </style>
  </head>
  <body>
    <div class="stack">
${renderLogoSvg('splash-logo-light', '#1e2a38')}
${renderLogoSvg('splash-logo-dark', '#fff')}
    </div>
  </body>
  </html>`;
};

export const buildStartupErrorHtml = (settings = {}, { message = '' } = {}) => {
  const splashBgLight = readStringSetting(settings, 'splashBgLight', DEFAULT_SPLASH_BG_LIGHT);
  const splashFgLight = readStringSetting(settings, 'splashFgLight', DEFAULT_SPLASH_FG_LIGHT);
  const splashBgDark = readStringSetting(settings, 'splashBgDark', DEFAULT_SPLASH_BG_DARK);
  const splashFgDark = readStringSetting(settings, 'splashFgDark', DEFAULT_SPLASH_FG_DARK);
  const splashVariant = resolveStartupSplashVariant(settings);
  const detail = escapeHtml(message || 'The local service could not be started.');

  return `<!doctype html>
  <html data-splash-variant="${splashVariant}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      :root { color-scheme: light dark; --background: ${splashBgLight}; --foreground: ${splashFgLight}; }
      html[data-splash-variant="dark"] { --background: ${splashBgDark}; --foreground: ${splashFgDark}; }
      @media (prefers-color-scheme: dark) {
        html[data-splash-variant="system"] { --background: ${splashBgDark}; --foreground: ${splashFgDark}; }
      }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: var(--background);
        color: var(--foreground);
        font-family: "IBM Plex Sans", -apple-system, BlinkMacSystemFont, sans-serif;
      }
      main { width: min(520px, calc(100vw - 64px)); text-align: center; }
      h1 { margin: 0 0 12px; font-size: 24px; font-weight: 600; }
      p { margin: 0 auto 24px; max-width: 460px; opacity: .72; line-height: 1.5; overflow-wrap: anywhere; }
      a {
        display: inline-block;
        padding: 10px 18px;
        border: 1px solid color-mix(in srgb, var(--foreground) 24%, transparent);
        border-radius: 8px;
        color: inherit;
        text-decoration: none;
        font-weight: 600;
      }
      a:hover { background: color-mix(in srgb, var(--foreground) 8%, transparent); }
    </style>
  </head>
  <body>
    <main>
      <h1>DevRyan couldn’t start</h1>
      <p>${detail}</p>
      <a href="openchamber://retry-startup">Retry</a>
    </main>
  </body>
  </html>`;
};
