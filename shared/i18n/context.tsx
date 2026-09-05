import { createContext } from "preact";
import { useContext, useState, useCallback } from "preact/hooks";
import { translations, type LangCode, type TranslationKey } from "./translations";
import type { ComponentChildren } from "preact";

interface I18nContextValue {
  lang: LangCode;
  setLang: (lang: LangCode) => void;
  toggleLang: () => void;
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string;
}

const defaultI18nValue: I18nContextValue = {
  lang: "en",
  setLang: () => {},
  toggleLang: () => {},
  t: (key: TranslationKey, vars?: Record<string, string | number>) => {
    const template = translations.en[key] ?? key;
    return interpolateTranslation(template, vars);
  },
};

const I18nContext = createContext<I18nContextValue>(defaultI18nValue);

export function interpolateTranslation(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? `{${name}}`));
}

function getInitialLang(): LangCode {
  try {
    const saved = localStorage.getItem("codex-proxy-lang");
    if (saved === "en" || saved === "zh" || saved === "zh-TW" || saved === "zh-HK" || saved === "ja") {
      return saved;
    }
  } catch {}
  const nav = (typeof navigator !== "undefined" ? navigator.language : "").toLowerCase();
  if (nav.startsWith("ja")) return "ja";
  if (nav.startsWith("zh-tw") || nav.startsWith("zh-hant-tw")) return "zh-TW";
  if (nav.startsWith("zh-hk") || nav.startsWith("zh-mo") || nav.startsWith("zh-hant-hk") || nav.startsWith("zh-hant-mo")) return "zh-HK";
  if (nav.startsWith("zh-hant")) return "zh-TW";
  if (nav.startsWith("zh")) return "zh";
  return "en";
}

export function I18nProvider({ children, initialLang }: { children: ComponentChildren; initialLang?: LangCode }) {
  const [lang, setLangState] = useState<LangCode>(() => initialLang ?? getInitialLang());

  const setLang = useCallback((newLang: LangCode) => {
    setLangState(newLang);
    try {
      localStorage.setItem("codex-proxy-lang", newLang);
    } catch {}
  }, []);

  const toggleLang = useCallback(() => {
    setLangState((prev) => {
      const order: LangCode[] = ["en", "zh", "zh-TW", "zh-HK", "ja"];
      const idx = order.indexOf(prev);
      const next: LangCode = order[(idx + 1) % order.length];
      try {
        localStorage.setItem("codex-proxy-lang", next);
      } catch {}
      return next;
    });
  }, []);

  const t = useCallback(
    (key: TranslationKey, vars?: Record<string, string | number>): string => {
      const template = translations[lang]?.[key] ?? translations.en[key] ?? key;
      return interpolateTranslation(template, vars);
    },
    [lang]
  );

  return (
    <I18nContext.Provider value={{ lang, setLang, toggleLang, t }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useT() {
  return useContext(I18nContext).t;
}

export function useI18n() {
  return useContext(I18nContext);
}
