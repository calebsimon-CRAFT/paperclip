import { DEFAULT_LOCALE, localeMessages } from "./locales";

type TranslationOptions = {
  defaultValue?: string;
};

function resolveLocaleValue(key: string) {
  const path = key.split(".");
  let value: unknown = localeMessages[DEFAULT_LOCALE];

  for (const segment of path) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    value = (value as Record<string, unknown>)[segment];
  }

  return typeof value === "string" ? value : null;
}

export function t(key: string, options: TranslationOptions = {}) {
  return resolveLocaleValue(key) ?? options.defaultValue ?? key;
}

export function useTranslation() {
  return { t };
}
