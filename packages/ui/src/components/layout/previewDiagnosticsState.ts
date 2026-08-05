export type PreviewConsoleEvent = {
  id: number;
  level: 'log' | 'info' | 'warn' | 'error' | 'debug' | 'resource' | 'runtime';
  message: string;
  details?: string;
  ts: number;
};

export type PreviewConsoleFilter = 'all' | 'errors' | 'warnings' | 'logs';

export type PreviewDiagnosticsState = {
  consoleEvents: PreviewConsoleEvent[];
  consoleOpen: boolean;
  consoleFilter: PreviewConsoleFilter;
  inspectMode: boolean;
};

export const PREVIEW_CONSOLE_EVENT_LIMIT = 200;

const PREVIEW_CONSOLE_LEVELS = new Set<PreviewConsoleEvent['level']>([
  'log',
  'info',
  'warn',
  'error',
  'debug',
  'resource',
  'runtime',
]);

export const createEmptyPreviewDiagnosticsState = (): PreviewDiagnosticsState => ({
  consoleEvents: [],
  consoleOpen: false,
  consoleFilter: 'all',
  inspectMode: false,
});

export const isPreviewConsoleEvent = (value: unknown): value is PreviewConsoleEvent => {
  if (!value || typeof value !== 'object') return false;
  const event = value as PreviewConsoleEvent;
  return Number.isFinite(event.id)
    && PREVIEW_CONSOLE_LEVELS.has(event.level)
    && typeof event.message === 'string'
    && Number.isFinite(event.ts)
    && (event.details === undefined || typeof event.details === 'string');
};

export const isPreviewDiagnosticsState = (value: unknown): value is PreviewDiagnosticsState => {
  if (!value || typeof value !== 'object') return false;
  const state = value as Partial<PreviewDiagnosticsState>;
  return Array.isArray(state.consoleEvents)
    && state.consoleEvents.every(isPreviewConsoleEvent)
    && typeof state.consoleOpen === 'boolean'
    && ['all', 'errors', 'warnings', 'logs'].includes(String(state.consoleFilter))
    && typeof state.inspectMode === 'boolean';
};

export const getPreviewConsoleFilterMatch = (
  event: PreviewConsoleEvent,
  filter: PreviewConsoleFilter,
): boolean => {
  if (filter === 'all') return true;
  if (filter === 'errors') return event.level === 'error' || event.level === 'runtime' || event.level === 'resource';
  if (filter === 'warnings') return event.level === 'warn';
  return event.level === 'log' || event.level === 'info' || event.level === 'debug';
};

export const formatPreviewConsoleText = (events: PreviewConsoleEvent[], pageUrl: string): string => {
  const header = [`Preview URL: ${pageUrl}`, `Events: ${events.length}`, ''].join('\n');
  const text = events.map((event) => {
    const timestamp = new Date(event.ts).toISOString();
    const details = event.details ? `\n${event.details}` : '';
    return `[${timestamp}] [${event.level}] ${event.message}${details}`;
  }).join('\n');
  return `${header}${text}`;
};
