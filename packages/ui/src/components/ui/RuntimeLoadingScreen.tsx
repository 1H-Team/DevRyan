import React from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const DEVRYAN_ICON_CLIP_PATH = 'M48.18,50.68v425.54h497.18V50.68H48.18ZM346.33,85.39c-34.03,14.36-61.01,41.46-74.79,55.3-2.21,2.22-4.31,4.34-6.32,6.38-17.58,17.79-25.6,25.91-44.71,34.43-12.61,5.62-18.28,20.4-12.66,33.01,4.15,9.31,13.28,14.83,22.85,14.83,3.4,0,6.86-.7,10.16-2.17,27.72-12.35,41.23-26.03,59.94-44.97,1.96-1.99,4.01-4.06,6.18-6.24,8.23-8.26,22.56-22.65,39.36-33.88v18.52c-12.32,9.47-22.84,20.03-28.73,25.94-1.95,1.96-3.8,3.83-5.59,5.64l-.55.56c-19.11,19.34-34.2,34.62-64.5,48.12-5.17,2.3-10.64,3.47-16.27,3.47-15.78,0-30.13-9.31-36.55-23.73-8.98-20.15.11-43.84,20.26-52.82,16.54-7.37,22.96-13.88,40.14-31.27,2.03-2.05,4.13-4.19,6.36-6.42,15.32-15.39,45.92-46.11,85.42-60.88v16.16Z';
const DEVRYAN_ICON_PATH = 'M295.81,323.54v-113.1s0-26.82,0-26.82c0-16.33-4-30.24-12.69-43.26-4.31-6.45-9.94-12.34-16.48-17.49-17.21-13.54-40.75-21.94-63.27-21.94-55.78,0-100.99,45.21-100.99,100.99,0,93.03,90.44,176.35,188.66,222.77,3.63,1.72,7.83,1.72,11.46,0,98.22-46.42,188.66-129.73,188.66-222.77,0-55.78-45.21-100.99-100.99-100.99-42.15,0-80.16,36.55-100.92,57.39-22.14,22.24-32.59,34.43-58.57,46';

export interface RuntimeLoadingScreenProps {
  message: string;
  mode?: 'page' | 'overlay';
  state?: 'loading' | 'error';
  onRetry?: () => void;
  isRetrying?: boolean;
}

const DevRyanLoadingMark: React.FC = () => (
  <svg
    width="169"
    height="169"
    viewBox="0 0 593.11 516.12"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
    focusable="false"
    className="pointer-events-none shrink-0 text-foreground"
    style={{ width: 'min(169px, 42vw)', height: 'min(169px, 42vw)' }}
  >
    <defs>
      <clipPath id="runtime-loading-devryan-clip">
        <path d={DEVRYAN_ICON_CLIP_PATH} />
      </clipPath>
    </defs>
    <g clipPath="url(#runtime-loading-devryan-clip)">
      <path
        d={DEVRYAN_ICON_PATH}
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="50"
      />
    </g>
  </svg>
);

export const RuntimeLoadingScreen: React.FC<RuntimeLoadingScreenProps> = ({
  message,
  mode = 'page',
  state = 'loading',
  onRetry,
  isRetrying = false,
}) => {
  const isError = state === 'error';

  return (
    <div
      data-runtime-loading-screen=""
      data-mode={mode}
      aria-busy={!isError}
      className={cn(
        'flex items-center justify-center bg-background px-6 text-foreground',
        mode === 'overlay' ? 'fixed inset-0 z-[9999]' : 'h-full min-h-0 w-full',
      )}
    >
      <div className="flex w-full max-w-md flex-col items-center text-center">
        <DevRyanLoadingMark />

        {isError ? (
          <div role="alert" className="mt-6 flex w-full flex-col items-center gap-2">
            <h1 className="typography-title text-foreground">Startup needs attention</h1>
            <p className="max-w-full [overflow-wrap:anywhere] typography-body text-destructive">
              {message}
            </p>
            {onRetry ? (
              <Button type="button" className="mt-2" onClick={onRetry} disabled={isRetrying}>
                {isRetrying ? 'Retrying…' : 'Retry'}
              </Button>
            ) : null}
          </div>
        ) : (
          <p
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className="mt-6 min-h-[1.125rem] max-w-full [overflow-wrap:anywhere] text-[13px] leading-[18px] text-muted-foreground"
          >
            {message}
          </p>
        )}
      </div>
    </div>
  );
};
