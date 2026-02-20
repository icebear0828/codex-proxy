import { createContext } from "preact";
import { useContext, useState, useCallback } from "preact/hooks";
import { translations, type LangCode, type TranslationKey } from "./translations";
import type { ComponentChildren } from "preact";

interface I18nContextValue {
  lang: LangCode;
  toggleLang: () => void;
  t: (key: TranslationKey) => string;
}

const I18nContext = createContext<I18nContextValue>(null!);

function getInitialLang(): LangCode {
  try {
    const saved = localStorage.getItem("codex-proxy-lang");
    if (saved === "en" || saved === "zh") return saved;
  } catch {}
  return navigator.language.startsWith("zh") ? "zh" : "en";
}

export function I18nProvider({ children }: { children: ComponentChildren }) {
  const [lang, setLang] = useState<LangCode>(getInitialLang);

  const toggleLang = useCallback(() => {
    setLang((prev) => {
      const next = prev === "en" ? "zh" : "en";
      localStorage.setItem("codex-proxy-lang", next);
      return next;
    });
  }, []);

  const t = useCallback(
    (key: TranslationKey): string => {
      return translations[lang][key] ?? translations.en[key] ?? key;
    },
    [lang]
  );

  return (
    <I18nContext.Provider value={{ lang, toggleLang, t }}>
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
