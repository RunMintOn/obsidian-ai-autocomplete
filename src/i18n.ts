import type { UiLanguage } from "./settings.js";

export function tr(language: UiLanguage, zh: string, en: string): string {
  if (language === "en") return en;
  return zh;
}
