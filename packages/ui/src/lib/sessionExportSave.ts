import { downloadAsMarkdown } from '@/lib/exportSession';
import {

  saveDesktopMarkdownFile,
  type DesktopMarkdownSaveResult,
} from '@/lib/desktop';

export type SessionExportSaveResult =
  | { status: 'saved'; path?: string }
  | { status: 'canceled' }
  | { status: 'downloaded'; filename: string };

export type SessionExportContent = string | Promise<string>;

type BrowserSaveResult =
  | { status: 'saved' }
  | { status: 'canceled' }
  | { status: 'unavailable' };

type BrowserWritableFile = {
  write: (content: string) => Promise<void>;
  close: () => Promise<void>;
};

type BrowserFileHandle = {
  createWritable: () => Promise<BrowserWritableFile>;
};

export type BrowserFilePickerHost = {
  showSaveFilePicker?: (options: {
    suggestedName: string;
    types: Array<{
      description: string;
      accept: Record<string, string[]>;
    }>;
  }) => Promise<BrowserFileHandle>;
};

export type SessionExportSaveDependencies = {
  saveDesktop: (defaultFileName: string, content: SessionExportContent) => Promise<DesktopMarkdownSaveResult>;

  fetchRequest: typeof fetch;
  pickBrowserFile: (content: SessionExportContent, filename: string) => Promise<BrowserSaveResult>;
  download: (content: string, filename: string) => void;
};

const getBrowserFilePickerHost = (): BrowserFilePickerHost => {
  if (typeof window === 'undefined') {
    return {};
  }

  return window as unknown as BrowserFilePickerHost;
};

export async function saveWithBrowserFilePicker(
  content: SessionExportContent,
  filename: string,
  host: BrowserFilePickerHost = getBrowserFilePickerHost(),
): Promise<BrowserSaveResult> {
  if (typeof host.showSaveFilePicker !== 'function') {
    return { status: 'unavailable' };
  }

  try {
    const handle = await host.showSaveFilePicker({
      suggestedName: filename,
      types: [{
        description: 'Markdown',
        accept: { 'text/markdown': ['.md'] },
      }],
    });
    const writable = await handle.createWritable();
    await writable.write(await content);
    await writable.close();
    return { status: 'saved' };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return { status: 'canceled' };
    }
    throw error;
  }
}

const defaultDependencies: SessionExportSaveDependencies = {
  saveDesktop: saveDesktopMarkdownFile,

  fetchRequest: (...args) => fetch(...args),
  pickBrowserFile: saveWithBrowserFilePicker,
  download: downloadAsMarkdown,
};

export async function saveSessionExportMarkdown(
  content: SessionExportContent,
  filename: string,
  overrides?: Partial<SessionExportSaveDependencies>,
): Promise<SessionExportSaveResult> {
  if (content instanceof Promise) {
    void content.catch(() => undefined);
  }

  const dependencies = { ...defaultDependencies, ...overrides };
  const desktopResult = await dependencies.saveDesktop(filename, content);

  if (desktopResult.status === 'saved') {
    return desktopResult;
  }

  if (desktopResult.status === 'canceled') {
    return desktopResult;
  }

  const browserResult = await dependencies.pickBrowserFile(content, filename);
  if (browserResult.status === 'saved' || browserResult.status === 'canceled') {
    return browserResult;
  }

  dependencies.download(await content, filename);
  return { status: 'downloaded', filename };
}
