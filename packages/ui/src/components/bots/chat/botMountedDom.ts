// Minimal host DOM, following the repo's mounted subscription tests. It runs
// React's real reconciliation and delegated events; real browser layout is
// covered separately by the Production Bots visual fixture.
export class HostNode {
  parentNode: HostNode | null = null;
  childNodes: HostNode[] = [];
  ownText = '';
  constructor(readonly ownerDocument: HostDocument, readonly nodeType = 1, readonly nodeName = 'DIV') {}
  get firstChild() { return this.childNodes[0] ?? null; }
  get nextSibling(): HostNode | null {
    const siblings = this.parentNode?.childNodes ?? [];
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }
  get textContent(): string { return this.ownText + this.childNodes.map((child) => child.textContent).join(''); }
  set textContent(text: string) { this.ownText = text; this.childNodes = []; }
  get nodeValue() { return this.ownText; }
  set nodeValue(text: string) { this.ownText = text; }
  appendChild(child: HostNode) { child.parentNode?.removeChild(child); child.parentNode = this; this.childNodes.push(child); return child; }
  removeChild(child: HostNode) { this.childNodes = this.childNodes.filter((candidate) => candidate !== child); child.parentNode = null; return child; }
  insertBefore(child: HostNode, before: HostNode | null) {
    if (!before) return this.appendChild(child);
    child.parentNode?.removeChild(child); child.parentNode = this;
    this.childNodes.splice(this.childNodes.indexOf(before), 0, child); return child;
  }
  contains(node: HostNode): boolean { return node === this || this.childNodes.some((child) => child.contains(node)); }
}
export class HostElement extends HostNode {
  readonly namespaceURI = 'http://www.w3.org/1999/xhtml';
  readonly attributes: Record<string, string> = {};
  readonly style = { setProperty() {}, removeProperty() {} };
  readonly listeners = new Map<string, Array<(event: object) => void>>();
  scrollTop = 0;
  scrollHeight = 1000;
  clientHeight = 600;
  clientWidth = 760;
  private inputValue = '';
  constructor(document: HostDocument, tagName = 'div') { super(document, 1, tagName.toUpperCase()); }
  get tagName() { return this.nodeName; }
  get type() { return this.attributes.type || 'text'; }
  set type(value: string) { this.setAttribute('type', value); }
  get value() { return this.inputValue; }
  set value(value: string) { this.inputValue = String(value); }
  get open() { return this.hasAttribute('open'); }
  set open(value: boolean) { if (value) this.setAttribute('open', ''); else this.removeAttribute('open'); }
  get isConnected(): boolean { return this.parentNode !== null; }
  setAttribute(name: string, value: unknown) { this.attributes[name] = String(value); }
  setAttributeNS(_namespace: string, name: string, value: unknown) { this.setAttribute(name, value); }
  getAttribute(name: string) { return this.attributes[name] ?? null; }
  hasAttribute(name: string) { return name in this.attributes; }
  removeAttribute(name: string) { delete this.attributes[name]; }
  addEventListener(name: string, listener: (event: object) => void) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]); }
  removeEventListener(name: string, listener: (event: object) => void) { this.listeners.set(name, (this.listeners.get(name) ?? []).filter((candidate) => candidate !== listener)); }
  querySelectorAll() { return []; }
  querySelector() { return null; }
  getBoundingClientRect() { return { width: 760, height: 120, top: 0, bottom: 120, left: 0, right: 760 }; }
  focus() { this.ownerDocument.activeElement = this; }
  dispatch(type: string) {
    const event = { type, target: this, button: 0, bubbles: true, preventDefault() {}, stopPropagation() {} };
    const dispatch = (node: HostNode) => {
      if (node instanceof HostElement) for (const listener of node.listeners.get(type) ?? []) listener(event);
      if (node.parentNode) dispatch(node.parentNode);
    };
    dispatch(this);
  }
  click() { this.dispatch('click'); }
  toggle(value: boolean) { this.open = value; this.dispatch('toggle'); }
  submit() { this.dispatch('submit'); }
  find(predicate: (node: HostElement) => boolean): HostElement | null {
    if (predicate(this)) return this;
    for (const child of this.childNodes) { if (child instanceof HostElement) { const found = child.find(predicate); if (found) return found; } }
    return null;
  }
}
export class HostDocument {
  readonly nodeType = 9;
  readonly documentElement = new HostElement(this, 'html');
  readonly body = new HostElement(this, 'body');
  activeElement: HostElement | null = this.body;
  defaultView: object | null = null;
  addEventListener() {}
  removeEventListener() {}
  createElement(tag: string) { return new HostElement(this, tag); }
  createElementNS(_namespace: string, tag: string) { return this.createElement(tag); }
  createTextNode(text: string) { const node = new HostNode(this, 3, '#text'); node.ownText = text; return node; }
}
export const withDom = async (run: (container: HostElement) => Promise<void>) => {
  const document = new HostDocument();
  const window = { document, HTMLElement: HostElement, Element: HostElement, HTMLIFrameElement: class {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
    cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id), setTimeout, clearTimeout,
    addEventListener() {}, removeEventListener() {}, getComputedStyle: () => ({}),
    getSelection: () => ({ anchorNode: null, anchorOffset: 0, focusNode: null, focusOffset: 0 }) };
  document.defaultView = window;
  const values = { window, document, HTMLElement: HostElement, Element: HostElement, IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: undefined, MutationObserver: class { observe() {} disconnect() {} } };
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  const container = document.createElement('div'); document.body.appendChild(container);
  try { await run(container); } finally {
    for (const [key, descriptor] of Object.entries(previous)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
};
