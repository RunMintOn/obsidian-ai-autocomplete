import type { UiLanguage } from "./settings";

export function tr(language: UiLanguage, zh: string, en: string): string {
  return language === "en" ? en : zh;
}
