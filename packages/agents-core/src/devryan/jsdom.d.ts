// DevRyan: the type surface of the reviewed jsdom 30.1.1 capture that the web
// fetch extractor uses. The module itself is lent per invocation by the host's
// web fetch owner (devryan/owners.ts); it is never resolved from node_modules.
declare module 'jsdom' {
  export class VirtualConsole {
    constructor();
    on(event: 'jsdomError', listener: (error: Error) => void): this;
  }
  export interface ConstructorOptions {
    url?: string;
    virtualConsole?: VirtualConsole;
  }
  export class JSDOM {
    constructor(html?: string, options?: ConstructorOptions);
    readonly window: Window & typeof globalThis;
  }
}
