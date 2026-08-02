import type { VsCodeHarnessRuntime } from './harnessRuntime';

let activeRuntime: VsCodeHarnessRuntime | null = null;

export const getVsCodeHarnessRuntime = (): VsCodeHarnessRuntime | null => activeRuntime;

export const setVsCodeHarnessRuntime = (runtime: VsCodeHarnessRuntime): void => {
  activeRuntime = runtime;
};

export const takeVsCodeHarnessRuntime = (): VsCodeHarnessRuntime | null => {
  const runtime = activeRuntime;
  activeRuntime = null;
  return runtime;
};
