import type { App } from "obsidian";

const activeViews = new WeakMap<App, Map<string, string>>();
const storagePrefix = "super-table:active-view:";

function sessionViews(app: App): Map<string, string> {
  let views = activeViews.get(app);
  if (!views) { views = new Map(); activeViews.set(app, views); }
  return views;
}

export function rememberedView(app: App, tableKey: string): string | undefined {
  const views = sessionViews(app);
  if (views.has(tableKey)) return views.get(tableKey);
  try {
    const value: unknown = app.loadLocalStorage(storagePrefix + tableKey);
    if (typeof value === "string" && value) { views.set(tableKey, value); return value; }
  } catch { /* Unavailable local storage must not prevent opening the table. */ }
  return undefined;
}

export function rememberView(app: App, tableKey: string, viewId: string): void {
  const views = sessionViews(app);
  if (views.get(tableKey) === viewId) return;
  views.set(tableKey, viewId);
  try {
    app.saveLocalStorage(storagePrefix + tableKey, viewId);
  } catch { /* Keep the session choice when local storage cannot be written. */ }
}
