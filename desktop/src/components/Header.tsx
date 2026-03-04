import { useI18n } from "../../../shared/i18n/context";
import { useTheme } from "../../../shared/theme/context";

const SVG_MOON = (
  <svg class="size-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
    <path stroke-linecap="round" stroke-linejoin="round" d="M21.752 15.002A9.72 9.72 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 009.002-5.998z" />
  </svg>
);

const SVG_SUN = (
  <svg class="size-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
    <path stroke-linecap="round" stroke-linejoin="round" d="M12 3v2.25m6.364.386l-1.591 1.591M21 12h-2.25m-.386 6.364l-1.591-1.591M12 18.75V21m-4.773-4.227l-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0z" />
  </svg>
);

interface HeaderProps {
  onAddAccount: () => void;
}

export function Header({ onAddAccount }: HeaderProps) {
  const { lang, toggleLang, t } = useI18n();
  const { isDark, toggle: toggleTheme } = useTheme();

  return (
    <header class="desktop-header sticky top-0 z-50 w-full border-b" style="background: var(--bg-card); border-color: var(--border);">
      <div class="header-content px-8 lg:px-10 flex h-14 items-center justify-center">
        <div class="flex w-full max-w-[860px] items-center justify-between">
          {/* Logo & Title */}
          <div class="flex items-center gap-3">
            <div class="flex items-center justify-center size-7 rounded-full bg-primary/10 text-primary">
              <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <h1 class="text-sm font-semibold tracking-tight" style="color: var(--text-primary);">Codex Proxy</h1>
          </div>

          {/* Actions */}
          <div class="flex items-center gap-2">
            {/* Status pill */}
            <div class="flex items-center gap-2 px-3 py-1.5 rounded-full bg-primary/8 border border-primary/15 min-w-[7.5rem] justify-center">
              <span class="relative flex h-2 w-2">
                <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-60" />
                <span class="relative inline-flex rounded-full h-2 w-2 bg-primary" />
              </span>
              <span class="text-xs font-medium text-primary">{t("serverOnline")}</span>
            </div>

            {/* Language */}
            <button
              onClick={toggleLang}
              class="p-2 rounded-md transition-colors duration-150 hover:bg-primary/8"
              style="color: var(--text-secondary);"
              title="中/EN"
            >
              <span class="text-xs font-bold w-5 inline-flex justify-center">{lang === "en" ? "EN" : "中"}</span>
            </button>

            {/* Theme */}
            <button
              onClick={toggleTheme}
              class="p-2 rounded-md transition-colors duration-150 hover:bg-primary/8"
              style="color: var(--text-secondary);"
              title={t("toggleTheme")}
            >
              {isDark ? SVG_SUN : SVG_MOON}
            </button>

            {/* Add Account */}
            <button
              onClick={onAddAccount}
              class="btn-primary flex items-center gap-2 px-4 py-2 text-xs font-semibold shadow-sm min-w-[7rem] justify-center"
            >
              <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
              </svg>
              {t("addAccount")}
            </button>
          </div>
        </div>
      </div>
    </header>
  );
}
