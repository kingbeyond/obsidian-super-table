import { StateField } from "@codemirror/state";

interface DomElementInfo {
  cls?: string | string[];
  text?: string | DocumentFragment;
  attr?: Record<string, string | number | boolean | null>;
  title?: string;
  parent?: Node;
  value?: string;
  type?: string;
  prepend?: boolean;
  placeholder?: string;
  href?: string;
}

type ElementCallback<K extends keyof HTMLElementTagNameMap> = (element: HTMLElementTagNameMap[K]) => void;

function elementOptions(options?: DomElementInfo | string): DomElementInfo {
  return typeof options === "string" ? { cls: options } : options ?? {};
}

function createElement<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  options?: DomElementInfo | string,
  callback?: ElementCallback<K>,
  defaultParent?: Node,
): HTMLElementTagNameMap[K] {
  const element = doc.createElement(tag);
  const settings = elementOptions(options);
  if (settings.cls) element.className = Array.isArray(settings.cls) ? settings.cls.join(" ") : settings.cls;
  if (settings.text instanceof doc.defaultView!.DocumentFragment) element.append(settings.text);
  else if (settings.text !== undefined) element.textContent = settings.text;
  if (settings.title !== undefined) element.title = settings.title;
  if (settings.value !== undefined && "value" in element) (element as HTMLInputElement).value = settings.value;
  if (settings.type !== undefined && "type" in element) (element as HTMLInputElement).type = settings.type;
  if (settings.placeholder !== undefined && "placeholder" in element) (element as HTMLInputElement).placeholder = settings.placeholder;
  if (settings.href !== undefined && "href" in element) (element as HTMLAnchorElement).href = settings.href;
  for (const [name, value] of Object.entries(settings.attr ?? {})) {
    if (value === null || value === false) element.removeAttribute(name);
    else element.setAttribute(name, value === true ? "" : String(value));
  }
  const parent = settings.parent ?? defaultParent;
  if (parent) {
    if (settings.prepend) parent.prepend(element);
    else parent.append(element);
  }
  callback?.(element);
  return element;
}

/** Install the DOM construction helpers exposed by Obsidian's renderer API. */
export function installObsidianDomHelpers(doc: Document): void {
  const view = doc.defaultView;
  if (!view) throw new Error("The Obsidian DOM test helpers need a document with a window.");

  const createGlobalEl = <K extends keyof HTMLElementTagNameMap>(tag: K, options?: DomElementInfo | string, callback?: ElementCallback<K>) =>
    createElement(doc, tag, options, callback);
  const createGlobalDiv = (options?: DomElementInfo | string, callback?: ElementCallback<"div">) => createGlobalEl("div", options, callback);
  const createGlobalSpan = (options?: DomElementInfo | string, callback?: ElementCallback<"span">) => createGlobalEl("span", options, callback);
  const createFragment = (callback?: (fragment: DocumentFragment) => void) => {
    const fragment = doc.createDocumentFragment();
    callback?.(fragment);
    return fragment;
  };

  Object.assign(globalThis, {
    createEl: createGlobalEl,
    createDiv: createGlobalDiv,
    createSpan: createGlobalSpan,
    createFragment,
    activeDocument: doc,
    activeWindow: view,
  });

  const prototype = view.Node.prototype as Node & {
    createEl?: <K extends keyof HTMLElementTagNameMap>(tag: K, options?: DomElementInfo | string, callback?: ElementCallback<K>) => HTMLElementTagNameMap[K];
    createDiv?: (options?: DomElementInfo | string, callback?: ElementCallback<"div">) => HTMLDivElement;
    createSpan?: (options?: DomElementInfo | string, callback?: ElementCallback<"span">) => HTMLSpanElement;
  };
  prototype.createEl = function <K extends keyof HTMLElementTagNameMap>(tag: K, options?: DomElementInfo | string, callback?: ElementCallback<K>) {
    return createElement(this.ownerDocument ?? doc, tag, options, callback, this);
  };
  prototype.createDiv = function (options?: DomElementInfo | string, callback?: ElementCallback<"div">) {
    return this.createEl!("div", options, callback);
  };
  prototype.createSpan = function (options?: DomElementInfo | string, callback?: ElementCallback<"span">) {
    return this.createEl!("span", options, callback);
  };
}

export const Platform = { isDesktop: true, isMobile: false };
export async function requestUrl(_request: unknown): Promise<{ status: number; text: string; headers: Record<string, string> }> {
  return { status: 404, text: "", headers: {} };
}
export const editorLivePreviewField = StateField.define({ create: () => true, update: (value) => value });
export const editorInfoField = StateField.define({ create: () => ({ file: { path: "test.md" } }), update: (value) => value });
export const notices: string[] = [];
export const shownMenus: Menu[] = [];
export class Notice { constructor(message: string) { notices.push(message); } }
export class TFile {
  constructor(public path = "test.md") {}
  get name() { return this.path.split("/").at(-1) ?? this.path; }
}
export class TFolder {}
export class MarkdownView {}
export class Plugin {
  data: unknown;
  settingTabs: PluginSettingTab[] = [];
  constructor(public app?: any, public manifest: any = {}) {}
  async loadData() { return this.data; }
  async saveData(data: unknown) { this.data = data; }
  addSettingTab(settingTab: PluginSettingTab) { this.settingTabs.push(settingTab); }
  registerEditorExtension(_extension: unknown) {}
  registerMarkdownCodeBlockProcessor(_language: string, _processor: unknown) {}
  registerEvent(_event: unknown) {}
  addRibbonIcon(_icon: string, _name: string, _callback: unknown) {}
  addCommand(_command: unknown) {}
}
export class PluginSettingTab {
  containerEl = document.createElement("div");
  constructor(public app: unknown, public plugin: unknown) {}
}
export class MarkdownRenderChild { constructor(public containerEl: HTMLElement) {} }
export class Component {
  private children = new Set<Component>();
  private loaded = false;
  load() { this.loaded = true; this.children.forEach((child) => child.load()); this.onload(); }
  unload() { this.loaded = false; this.onunload(); this.children.forEach((child) => child.unload()); }
  onload() {}
  onunload() {}
  addChild<T extends Component>(child: T): T { this.children.add(child); if (this.loaded) child.load(); return child; }
  removeChild<T extends Component>(child: T): T { this.children.delete(child); child.unload(); return child; }
}
export const markdownRenderCalls: string[] = [];
export class MarkdownRenderer {
  static async render(_app: unknown, markdown: string, element: HTMLElement, _sourcePath: string, _component: Component): Promise<void> {
    markdownRenderCalls.push(markdown);
    // This is only an API stub for testing scheduling/lifecycle, not Markdown semantics.
    element.textContent = markdown;
  }
}
export let getLanguage: () => string = () => "en";
export function setObsidianLanguage(language: string): void {
  getLanguage = () => language;
}
export function setObsidianLanguageFailure(error = new Error("language API failed")): void {
  getLanguage = () => { throw error; };
}
export class MenuItem {
  title = ""; icon = ""; disabled = false; checked: boolean | null = null; section = ""; child?: Menu; action?: (event: any) => unknown;
  titleFragment?: DocumentFragment;
  setTitle(value: string | DocumentFragment) {
    this.title = typeof value === "string" ? value : value.textContent ?? "";
    this.titleFragment = typeof value === "string" ? undefined : value.cloneNode(true) as DocumentFragment;
    return this;
  }
  setSection(value: string) { this.section = value; return this; }
  setIcon(value: string | null) { this.icon = value ?? ""; return this; }
  setChecked(value: boolean | null) { this.checked = value; return this; }
  setDisabled(value: boolean) { this.disabled = value; return this; }
  setWarning(_: boolean) { return this; }
  onClick(action: (event: any) => unknown) { this.action = action; return this; }
  setSubmenu() { return this.child = new Menu(); }
}
export class Menu {
  items: MenuItem[] = [];
  useNativeMenu: boolean | null = null;
  mouseEvent?: MouseEvent;
  position?: { x: number; y: number };
  ownerDocument?: Document;
  hidden = false;
  private hideCallback?: () => void;
  setUseNativeMenu(value: boolean) { this.useNativeMenu = value; return this; }
  addItem(callback: (item: MenuItem) => unknown) { const item = new MenuItem(); callback(item); this.items.push(item); return this; }
  addSeparator() { return this; }
  onHide(callback: () => void) { this.hideCallback = callback; return this; }
  hide() { if (this.hidden) return this; this.hidden = true; this.hideCallback?.(); this.hideCallback = undefined; return this; }
  showAtMouseEvent(event: MouseEvent) { this.mouseEvent = event; shownMenus.push(this); return this; }
  showAtPosition(position: { x: number; y: number }, doc?: Document) { this.position = position; this.ownerDocument = doc; shownMenus.push(this); return this; }
}
export class Modal {
  containerEl = document.createElement("div");
  contentEl = document.createElement("div");
  modalEl = document.createElement("div");
  titleEl = document.createElement("div");
  closeButtonEl = document.createElement("button");
  constructor(_: unknown) {
    this.modalEl.classList.add("modal");
    this.titleEl.classList.add("modal-title");
    this.closeButtonEl.type = "button";
    this.closeButtonEl.classList.add("modal-close-button");
    this.closeButtonEl.setAttribute("aria-label", "Close");
    this.closeButtonEl.textContent = "×";
    this.closeButtonEl.addEventListener("click", () => this.close());
    this.modalEl.append(this.titleEl, this.closeButtonEl, this.contentEl);
    this.containerEl.append(this.modalEl);
  }
  setTitle(title: string) { this.titleEl.textContent = title; this.contentEl.setAttribute("aria-label", title); }
  onOpen() {}
  onClose() {}
  open() { document.body.append(this.containerEl); this.onOpen(); }
  close() { this.containerEl.remove(); this.onClose(); }
}
export function setIcon(element: HTMLElement, name: string) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"); svg.classList.add("svg-icon"); svg.setAttribute("data-icon", name); element.append(svg);
}
