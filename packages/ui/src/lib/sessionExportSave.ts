import { downloadAsMarkdown } from '@/lib/exportSession';
import {
  isVSCodeRuntime,
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
  isVSCode: () => boolean;
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
  isVSCode: isVSCodeRuntime,
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

  if (dependencies.isVSCode()) {
    const resolvedContent = await content;
    const response = await dependencies.fetchRequest('/api/vscode/save-markdown', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName: filename, content: resolvedContent }),
    });
    if (!response.ok) {
      throw new Error('VS Code could not save the exported session');
    }

    const payload = await response.json() as {
      saved?: boolean;
      canceled?: boolean;
      path?: string;
    };
    if (payload.saved === true) {
      const path = typeof payload.path === 'string' ? payload.path.trim() : '';
      return path ? { status: 'saved', path } : { status: 'saved' };
    }
    if (payload.canceled === true) {
      return { status: 'canceled' };
    }
    throw new Error('VS Code returned an invalid export result');
  }

  const browserResult = await dependencies.pickBrowserFile(content, filename);
  if (browserResult.status === 'saved' || browserResult.status === 'canceled') {
    return browserResult;
  }

  dependencies.download(await content, filename);
  return { status: 'downloaded', filename };
}
