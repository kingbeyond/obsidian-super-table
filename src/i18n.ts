import { en } from "./locales/en";
import type { MessageKey } from "./locales/en";
import { zhCN } from "./locales/zh-CN";

export type Locale = "en" | "zh-CN";
const catalogs: Record<Locale, Record<MessageKey, string>> = { en, "zh-CN": zhCN };
let locale: Locale = "en";

export function resolveLocale(language: string): Locale {
  const code = language.trim().replace(/_/g, "-").toLowerCase();
  return code === "zh" || code === "zh-cn" || code === "zh-sg" || code === "zh-hans" || code.startsWith("zh-hans-") ? "zh-CN" : "en";
}

export function setLanguage(language: string): void { locale = resolveLocale(language); }
export function getLocale(): Locale { return locale; }

export function t(key: MessageKey, params: Record<string, string | number> = {}): string {
  const message = catalogs[locale][key] ?? en[key];
  // One pass keeps user content containing braces from being interpreted as translations.
  return message.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : placeholder);
}

const colors: Record<string, MessageKey> = {
  gray: "Gray", red: "Red", orange: "Orange", yellow: "Yellow", green: "Green",
  cyan: "Cyan", blue: "Blue", purple: "Purple", pink: "Pink",
};
export function colorLabel(color: string): string { return colors[color] ? t(colors[color]) : color; }

// Type conversions must recognize labels saved in either language, even after switching languages.
export function matchesTranslation(value: string, key: MessageKey): boolean {
  return Object.values(catalogs).some((catalog) => catalog[key].toLowerCase() === value.toLowerCase());
}

export function errorMessage(error: unknown): string {
  if (error instanceof SyntaxError) return t("Invalid table JSON. Check the raw table data.");
  return error instanceof Error ? error.message : String(error);
}
