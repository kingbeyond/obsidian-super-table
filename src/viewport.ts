type RestorationKind = "save" | "history" | "navigation";
interface Restoration { kind: RestorationKind; cancel(): void }
const restorations = new WeakMap<HTMLElement, Set<Restoration>>();

/** Scope pending restoration to the note pane, including controllers replaced by Obsidian. */
export function registerViewportRestoration(scope: HTMLElement, kind: RestorationKind, cancel: () => void): () => void {
  let entries = restorations.get(scope);
  if (!entries) { entries = new Set(); restorations.set(scope, entries); }
  const entry = { kind, cancel };
  entries.add(entry);
  return () => { entries.delete(entry); };
}

function pendingRestorations(root: HTMLElement): Restoration[] {
  const pending: Restoration[] = [];
  for (let scope: HTMLElement | null = root; scope; scope = scope.parentElement) {
    pending.push(...restorations.get(scope) ?? []);
  }
  return pending;
}

export function cancelViewportRestorations(root: HTMLElement): void {
  pendingRestorations(root).forEach((entry) => entry.cancel());
}

export function hasHistoryViewportRestoration(root: HTMLElement, except: () => void): boolean {
  return pendingRestorations(root).some((entry) => entry.kind === "history" && entry.cancel !== except);
}

/** Lazy Markdown can change row heights after a jump. Follow layout changes briefly, until user input takes over. */
export function followViewportTarget(root: HTMLElement, scope: HTMLElement, reveal: () => void): () => void {
  const doc = root.ownerDocument;
  const win = doc.defaultView!;
  cancelViewportRestorations(root);
  let stopped = false;
  let frame: number | undefined;
  let settleTimer: number | undefined;
  let expiryTimer: number | undefined;
  const stop = () => {
    if (stopped) return;
    stopped = true; release(); observer.disconnect(); resizeObserver?.disconnect();
    if (frame !== undefined) win.cancelAnimationFrame(frame);
    win.clearTimeout(settleTimer); win.clearTimeout(expiryTimer);
    for (const type of ["wheel", "touchstart", "pointerdown"]) doc.removeEventListener(type, stop, true);
    doc.removeEventListener("keydown", onKeyDown, true);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " ", "Tab", "Escape"].includes(event.key)) stop();
  };
  const schedule = () => {
    if (stopped) return;
    win.clearTimeout(settleTimer);
    settleTimer = win.setTimeout(stop, 180);
    if (frame === undefined) frame = win.requestAnimationFrame(() => {
      frame = undefined;
      if (!root.isConnected) { stop(); return; }
      reveal();
    });
  };
  const observer = new win.MutationObserver(schedule);
  const resizeObserver = typeof win.ResizeObserver === "undefined" ? undefined : new win.ResizeObserver(schedule);
  const release = registerViewportRestoration(scope, "navigation", stop);
  observer.observe(root, { childList: true, subtree: true, characterData: true });
  resizeObserver?.observe(root);
  for (const type of ["wheel", "touchstart", "pointerdown"]) doc.addEventListener(type, stop, true);
  doc.addEventListener("keydown", onKeyDown, true);
  expiryTimer = win.setTimeout(stop, 1500);
  schedule(); reveal();
  return stop;
}
