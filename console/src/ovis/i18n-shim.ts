export type Language = "en" | "ko" | "ja" | "zh";
export type LanguageSetting = Language | "system";
export type Vars = Record<string, string | number>;
export type Translate = (key: string, vars?: Vars) => string;

export const LANGUAGE_SETTINGS: readonly LanguageSetting[] = ["system", "en", "zh", "ja", "ko"];
export const LANGUAGE_NAMES: Record<LanguageSetting, string> = { system: "System", en: "English", ko: "한국어", ja: "日本語", zh: "简体中文" };
export const LOCALE_TAGS: Record<Language, string> = { en: "en-US", ko: "ko-KR", ja: "ja-JP", zh: "zh-CN" };

/** Minimal English-only Ovis text adapter; it deliberately excludes upstream install/remote help strings. */
export function resolveLanguage(_setting: LanguageSetting, _languages?: readonly string[]): Language { return "en"; }
export function setCurrentLanguage(_language: Language): void {}
export function currentLocale(): string { return "en-US"; }
export function translate(_language: Language, key: string, vars?: Vars): string {
  const text = key.split("|", 1)[0]!;
  return vars === undefined ? text : text.replace(/\{(\w+)\}/g, (match, name: string) => name in vars ? String(vars[name]) : match);
}
export const t: Translate = (key, vars) => translate("en", key, vars);
export function useT(): Translate { return t; }
export function useLocale(): string { return "en-US"; }
