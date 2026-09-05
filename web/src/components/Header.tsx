import { useState, useEffect, useRef } from "preact/hooks";
import { useI18n } from "../../../shared/i18n/context";
import { translations, type LangCode, type TranslationKey } from "../../../shared/i18n/translations";
import { useTheme } from "../../../shared/theme/context";

const SVG_MOON = (
  <svg class="size-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
    <path stroke-linecap="round" stroke-linejoin="round" d="M21.752 15.002A9.72 9.72 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 009.002-5.998z" />
  </svg>
);

const SVG_SUN = (
  <svg class="size-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
    <path stroke-linecap="round" stroke-linejoin="round" d="M12 3v2.25m6.364.386l-1.591 1.591M21 12h-2.25m-.386 6.364l-1.591-1.591M12 18.75V21m-4.773-4.227l-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0z" />
  </svg>
);

const LANG_OPTIONS: { id: LangCode; label: string; short: string }[] = [
  { id: "en", label: "English", short: "EN" },
  { id: "zh", label: "简体中文", short: "简" },
  { id: "zh-TW", label: "繁體中文 (台灣)", short: "繁(台)" },
  { id: "zh-HK", label: "繁體中文 (香港)", short: "繁(港)" },
  { id: "ja", label: "日本語", short: "日" },
];

/**
 * Stable-width text: invisible references for all languages set min-width via grid overlap.
 * The visible text overlays them, so the button never changes width on language switch.
 */
function StableText({ tKey, children, class: cls }: { tKey: TranslationKey; children: string; class?: string }) {
  return (
    <span class={`inline-grid ${cls ?? ""}`}>
      <span class="invisible col-start-1 row-start-1 whitespace-nowrap">{translations.en[tKey]}</span>
      <span class="invisible col-start-1 row-start-1 whitespace-nowrap">{translations.zh[tKey]}</span>
      <span class="invisible col-start-1 row-start-1 whitespace-nowrap">{translations["zh-TW"][tKey]}</span>
      <span class="invisible col-start-1 row-start-1 whitespace-nowrap">{translations["zh-HK"][tKey]}</span>
      <span class="invisible col-start-1 row-start-1 whitespace-nowrap">{translations.ja[tKey]}</span>
      <span class="col-start-1 row-start-1 whitespace-nowrap">{children}</span>
    </span>
  );
}

interface HeaderProps {
  onAddAccount: () => void;
  onCheckUpdate: () => void;
  onOpenUpdateModal?: () => void;
  checking: boolean;
  updateStatusMsg: string | null;
  updateStatusColor: string;
  version: string | null;
  commit?: string | null;
  hasUpdate?: boolean;
  onLogout?: () => void;
  showBrand?: boolean;
  onOpenSidebar?: () => void;
  /** Number of unread errors. When > 0, show a clickable badge that
   *  navigates to the Errors tab. */
  unreadErrors?: number;
}

export function Header({ onAddAccount, onCheckUpdate, onOpenUpdateModal, checking, updateStatusMsg, updateStatusColor, version, commit, hasUpdate, onLogout, unreadErrors, showBrand = true, onOpenSidebar }: HeaderProps) {
  const { lang, setLang, t } = useI18n();
  const { isDark, toggle: toggleTheme } = useTheme();
  const [fabOpen, setFabOpen] = useState(false);
  const [langMenuOpen, setLangMenuOpen] = useState(false);
  const langMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!langMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (langMenuRef.current && !langMenuRef.current.contains(e.target as Node)) {
        setLangMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [langMenuOpen]);

  return (
    <header class="sticky top-0 z-50 w-full bg-white dark:bg-card-dark border-b border-gray-200 dark:border-border-dark shadow-sm transition-colors">
      <div class={`${showBrand ? "px-4 md:px-8 lg:px-40" : "px-4 md:px-8 lg:px-10"} flex h-16 items-center justify-center`}>
        <div class={`flex w-full ${showBrand ? "max-w-[960px] justify-between" : "max-w-none justify-between lg:justify-end"} items-center gap-4`}>
          {/* Logo & Title */}
          {showBrand ? <div class="flex min-w-0 items-center gap-3">
            <img src="/icon.png" alt="Codex Proxy" class="size-8 shrink-0 object-contain" />
            <h1 class="text-[0.9rem] font-bold tracking-tight whitespace-nowrap overflow-hidden text-ellipsis min-w-0">Codex Proxy</h1>
          </div> : <div class="flex items-center gap-2 lg:hidden">
            {onOpenSidebar && <button onClick={onOpenSidebar} class="rounded-lg p-2 text-slate-500 hover:bg-slate-100 dark:text-text-dim dark:hover:bg-border-dark" aria-label={t("openSidebar")}>
              <svg class="size-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
                <path d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>}
            <img src="/icon.png" alt="Codex Proxy" class="size-8 shrink-0 object-contain" />
            <span class="text-sm font-bold tracking-tight">Codex Proxy</span>
          </div>}
          {/* Actions */}
          <div class="flex min-w-0 items-center justify-end gap-1.5 sm:gap-2">
            {/* Unread error badge — appears only when there's something to show. */}
            {unreadErrors !== undefined && unreadErrors > 0 && (
              <a
                href="#/errors"
                title={t("errorsBadgeTooltip")}
                class="flex shrink-0 items-center gap-1.5 whitespace-nowrap px-3 py-1.5 rounded-full bg-red-50 border border-red-200 text-red-700 dark:bg-red-900/20 dark:border-red-700/30 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/30 transition-colors"
              >
                <span class="relative flex h-2.5 w-2.5">
                  <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-75" />
                  <span class="relative inline-flex rounded-full h-2.5 w-2.5 bg-red-500" />
                </span>
                <span class="text-xs font-semibold">
                  {unreadErrors > 99 ? "99+" : unreadErrors} {t("errorsBadge")}
                </span>
              </a>
            )}
            {/* Star on GitHub */}
            <a
              href="https://github.com/icebear0828/codex-proxy"
              target="_blank"
              rel="noopener noreferrer"
              class="hidden lg:flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-amber-50 border border-amber-200 text-amber-700 dark:bg-amber-900/20 dark:border-amber-700/30 dark:text-amber-400 hover:bg-amber-100 dark:hover:bg-amber-900/40 transition-colors"
            >
              <svg class="size-3.5" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
              </svg>
              <StableText tKey="starOnGithub" class="text-xs font-semibold">{t("starOnGithub")}</StableText>
            </a>
            {/* Check for Updates */}
            <button
              onClick={onCheckUpdate}
              disabled={checking}
              class="hidden lg:flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-gray-200 dark:border-border-dark text-slate-600 dark:text-text-dim hover:bg-slate-50 dark:hover:bg-border-dark disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <svg class={`size-3.5 ${checking ? "animate-spin" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.992 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182M20.985 4.356v4.992" />
              </svg>
              <StableText tKey="checkForUpdates" class="text-xs font-semibold">{checking ? t("checkingUpdates") : t("checkForUpdates")}</StableText>
            </button>
            {/* Update status message */}
            {updateStatusMsg && !checking && (
              <button
                onClick={hasUpdate && onOpenUpdateModal ? onOpenUpdateModal : onCheckUpdate}
                class={`hidden lg:inline whitespace-nowrap text-xs font-medium ${updateStatusColor} hover:underline`}
              >
                {updateStatusMsg}
              </button>
            )}
            {/* Logout (remote sessions only) */}
            {onLogout && (
              <button
                onClick={onLogout}
                class="flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-gray-200 dark:border-border-dark text-slate-600 dark:text-text-dim hover:bg-slate-50 dark:hover:bg-border-dark transition-colors"
              >
                <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15m3 0l3-3m0 0l-3-3m3 3H9" />
                </svg>
                <span class="hidden sm:inline"><StableText tKey="dashboardLogout" class="text-xs font-semibold">{t("dashboardLogout")}</StableText></span>
              </button>
            )}
            {/* Language Selector Dropdown — hidden on mobile, available via FAB */}
            <div ref={langMenuRef} class="relative hidden sm:block">
              <button
                onClick={() => setLangMenuOpen(!langMenuOpen)}
                class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-gray-200 dark:border-border-dark text-slate-600 dark:text-text-dim hover:bg-slate-50 dark:hover:bg-border-dark text-xs font-semibold transition-colors"
                aria-label={t("language")}
                aria-expanded={langMenuOpen}
              >
                <svg class="size-3.5 text-slate-500 dark:text-text-dim shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M12 21a9.004 9.004 0 0 0 8.716-6.747M12 21a9.004 9.004 0 0 1-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 0 1 7.843 4.582M12 3a8.997 8.997 0 0 0-7.843 4.582m15.686 0A11.953 11.953 0 0 1 12 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0 1 21 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0 1 12 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 0 1 3 12c0-1.605.42-3.113 1.157-4.418" />
                </svg>
                <span>{LANG_OPTIONS.find((o) => o.id === lang)?.label ?? t("language")}</span>
                <svg class={`size-3 text-slate-400 transition-transform ${langMenuOpen ? "rotate-180" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                </svg>
              </button>

              {langMenuOpen && (
                <div class="absolute right-0 z-50 mt-1.5 w-44 py-1 bg-white dark:bg-card-dark border border-gray-200 dark:border-border-dark rounded-xl shadow-lg animate-in fade-in zoom-in-95 duration-100">
                  {LANG_OPTIONS.map((opt) => (
                    <button
                      key={opt.id}
                      onClick={() => {
                        setLang(opt.id);
                        setLangMenuOpen(false);
                      }}
                      class={`w-full flex items-center justify-between px-3 py-2 text-xs text-left transition-colors ${
                        lang === opt.id
                          ? "bg-primary-container text-primary font-bold"
                          : "text-slate-700 dark:text-text-main hover:bg-slate-50 dark:hover:bg-[#21262d] font-medium"
                      }`}
                    >
                      <span>{opt.label}</span>
                      {lang === opt.id && (
                        <svg class="size-3.5 text-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                          <path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                        </svg>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {/* Theme Toggle — hidden on mobile, available via FAB */}
            <button
              onClick={toggleTheme}
              class="hidden sm:flex items-center gap-1.5 p-2 rounded-lg text-slate-500 dark:text-text-dim hover:bg-slate-100 dark:hover:bg-border-dark transition-colors"
              title={t("toggleTheme")}
            >
              {isDark ? SVG_SUN : SVG_MOON}
            </button>
            {/* Add Account — hidden on mobile, available via FAB */}
            <button
              onClick={onAddAccount}
              class="hidden sm:flex items-center gap-2 px-4 py-2 bg-primary-action hover:bg-primary-action-hover text-white text-xs font-semibold rounded-lg transition-colors shadow-sm active:scale-95"
            >
              <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
              </svg>
              <StableText tKey="addAccount">{t("addAccount")}</StableText>
            </button>

            {/* Mobile FAB — language + theme + add account, floating bottom-right */}
            <div class="sm:hidden">
              <button
                onClick={() => setFabOpen((v) => !v)}
                aria-label={t("moreActions")}
                aria-expanded={fabOpen}
                class="fixed right-4 bottom-4 z-50 flex size-14 items-center justify-center rounded-full bg-primary-action text-white shadow-lg hover:bg-primary-action-hover transition-colors"
              >
                <svg class="size-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                </svg>
              </button>
              {fabOpen && (
                <>
                  <div
                    class="fixed inset-0 z-40 bg-black/20"
                    onClick={() => setFabOpen(false)}
                  />
                  <div class="fixed right-4 bottom-20 z-50 flex max-h-[70vh] w-56 flex-col overflow-y-auto rounded-2xl border border-gray-200 dark:border-border-dark bg-white dark:bg-card-dark shadow-xl">
                    <span class="px-4 pt-3 pb-1 text-[0.7rem] font-semibold uppercase tracking-wide text-slate-400 dark:text-text-dim">
                      {t("language")}
                    </span>
                    {LANG_OPTIONS.map((opt) => (
                      <button
                        key={opt.id}
                        onClick={() => { setLang(opt.id); setFabOpen(false); }}
                        class={`flex items-center gap-3 px-4 py-2.5 text-sm font-medium text-left transition-colors ${
                          lang === opt.id
                            ? "text-primary"
                            : "text-slate-700 dark:text-text-main hover:bg-slate-100 dark:hover:bg-border-dark"
                        }`}
                      >
                        <span class="flex-1">{opt.label}</span>
                        {lang === opt.id && (
                          <svg class="size-4 text-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                          </svg>
                        )}
                      </button>
                    ))}
                    <div class="h-px bg-gray-200 dark:bg-border-dark" />
                    <button
                      onClick={() => { toggleTheme(); setFabOpen(false); }}
                      class="flex items-center gap-3 px-4 py-3 text-sm font-medium text-slate-700 dark:text-text-main hover:bg-slate-100 dark:hover:bg-border-dark"
                    >
                      {isDark ? SVG_SUN : SVG_MOON}
                      <span>{isDark ? t("lightMode") : t("darkMode")}</span>
                    </button>
                    <div class="h-px bg-gray-200 dark:bg-border-dark" />
                    <button
                      onClick={() => { onAddAccount(); setFabOpen(false); }}
                      class="flex items-center gap-3 px-4 py-3 text-sm font-semibold text-white bg-primary-action hover:bg-primary-action-hover"
                    >
                      <svg class="size-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                      </svg>
                      <span>{t("addAccount")}</span>
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}
