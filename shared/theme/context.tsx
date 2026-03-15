import { createContext } from "preact";
import { useContext, useState, useCallback } from "preact/hooks";
import type { ComponentChildren } from "preact";

interface ThemeContextValue {
  isDark: boolean;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue>(null!);

function getInitialDark(): boolean {
  try {
    const saved = localStorage.getItem("codex-proxy-theme");
    if (saved === "dark") return true;
    if (saved === "light") return false;
  } catch {}
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

// Sync dark class + color-scheme to <html> on initial load (before first render to avoid flash)
const _initialDark = getInitialDark();
if (_initialDark) {
  document.documentElement.classList.add("dark");
} else {
  document.documentElement.classList.remove("dark");
}
document.documentElement.style.colorScheme = _initialDark ? "dark" : "light";

export function ThemeProvider({ children }: { children: ComponentChildren }) {
  const [isDark, setIsDark] = useState(_initialDark);

  const toggle = useCallback(() => {
    setIsDark((prev) => {
      const next = !prev;
      localStorage.setItem("codex-proxy-theme", next ? "dark" : "light");
      if (next) {
        document.documentElement.classList.add("dark");
      } else {
        document.documentElement.classList.remove("dark");
      }
      document.documentElement.style.colorScheme = next ? "dark" : "light";
      return next;
    });
  }, []);

  return (
    <ThemeContext.Provider value={{ isDark, toggle }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
