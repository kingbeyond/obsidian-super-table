import type { App } from "obsidian";

const activeViews = new WeakMap<App, Map<string, string>>();
const storagePrefix = "super-table:active-view:";

function sessionViews(app: App): Map<string, string> {
  let views = activeViews.get(app);
  if (!views) { views = new Map(); activeViews.set(app, views); }
  return views;
}

function hasVaultStorage(app: App): boolean {
  return typeof app.loadLocalStorage === "function" && typeof app.saveLocalStorage === "function";
}

function legacyStorageKey(app: App, tableKey: string): string {
  // Before Obsidian 1.8.7, scope browser storage by the adapter's root URI
  // so same-named vaults stay separate on desktop and mobile.
  return storagePrefix + JSON.stringify([app.vault.adapter.getResourcePath(""), tableKey]);
}

export function rememberedView(app: App, tableKey: string): string | undefined {
  const views = sessionViews(app);
  if (views.has(tableKey)) return views.get(tableKey);
  try {
    const value: unknown = hasVaultStorage(app)
      ? app.loadLocalStorage(storagePrefix + tableKey)
      : window.localStorage.getItem(legacyStorageKey(app, tableKey));
    if (typeof value === "string" && value) { views.set(tableKey, value); return value; }
  } catch { /* Unavailable local storage must not prevent opening the table. */ }
  return undefined;
}

export function rememberView(app: App, tableKey: string, viewId: string): void {
  const views = sessionViews(app);
  if (views.get(tableKey) === viewId) return;
  views.set(tableKey, viewId);
  try {
    if (hasVaultStorage(app)) app.saveLocalStorage(storagePrefix + tableKey, viewId);
    else window.localStorage.setItem(legacyStorageKey(app, tableKey), viewId);
  } catch { /* Keep the session choice when local storage cannot be written. */ }
}
