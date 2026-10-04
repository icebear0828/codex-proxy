import { useState, useCallback, useEffect, useRef } from "preact/hooks";
import { useT } from "../../../shared/i18n/context";
import type { TranslationKey } from "../../../shared/i18n/translations";
import type { AntigravitySupportedModel } from "../../../shared/hooks/use-accounts";

interface AddAccountProps {
  visible: boolean;
  onCancel: () => void;
  onSubmitRelay: (callbackUrl: string) => Promise<void>;
  onAddByRefreshToken: (refreshToken: string) => Promise<string | null>;
  onStartAntigravityOAuth: () => Promise<void>;
  onSubmitAntigravityOAuth: (callbackUrl: string) => Promise<boolean>;
  addInfo: string;
  addError: string;
  authUrl: string;
  antigravityAuthUrl: string;
  antigravityModels: AntigravitySupportedModel[];
  fallbackConfigured: boolean;
  onAddFallbackUpstream: (baseUrl: string, apiKey: string) => Promise<string | null>;
}

export function AddAccount({
  visible,
  onCancel,
  onSubmitRelay,
  onAddByRefreshToken,
  onStartAntigravityOAuth,
  onSubmitAntigravityOAuth,
  addInfo,
  addError,
  authUrl,
  antigravityAuthUrl,
  antigravityModels,
  fallbackConfigured,
  onAddFallbackUpstream,
}: AddAccountProps) {
  const t = useT();
  const [input, setInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [rtInput, setRtInput] = useState("");
  const [rtSubmitting, setRtSubmitting] = useState(false);
  const [antigravityCallback, setAntigravityCallback] = useState("");
  const [antigravitySubmitting, setAntigravitySubmitting] = useState(false);
  const antigravityPopupRef = useRef<Window | null>(null);
  const [copied, setCopied] = useState(false);
  const [fbBaseUrl, setFbBaseUrl] = useState("");
  const [fbApiKey, setFbApiKey] = useState("");
  const [fbSubmitting, setFbSubmitting] = useState(false);
  const [localNotice, setLocalNotice] = useState("");
  const [noticeOpen, setNoticeOpen] = useState(true);

  const notice = addError || addInfo || localNotice;
  const noticeIsError = !!addError || (!addInfo && !!localNotice);

  useEffect(() => {
    if (notice) setNoticeOpen(true);
  }, [notice]);

  const handleSubmit = useCallback(async () => {
    setSubmitting(true);
    await onSubmitRelay(input);
    setSubmitting(false);
    setInput("");
  }, [input, onSubmitRelay]);

  const handleRtSubmit = useCallback(async () => {
    const trimmed = rtInput.trim();
    if (!trimmed) return;
    setRtSubmitting(true);
    await onAddByRefreshToken(trimmed);
    setRtSubmitting(false);
    setRtInput("");
  }, [rtInput, onAddByRefreshToken]);

  const handleRtKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === "Enter") void handleRtSubmit();
  }, [handleRtSubmit]);

  const handleAntigravitySubmit = useCallback(async (submittedCallbackUrl?: string) => {
    const callbackUrl = (submittedCallbackUrl ?? antigravityCallback).trim();
    if (!callbackUrl) return;
    setAntigravitySubmitting(true);
    try {
      if (await onSubmitAntigravityOAuth(callbackUrl)) setAntigravityCallback("");
    } finally {
      setAntigravitySubmitting(false);
    }
  }, [antigravityCallback, onSubmitAntigravityOAuth]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent<unknown>) => {
      if (event.origin !== "http://localhost:51121" || event.source !== antigravityPopupRef.current) return;
      const payload = event.data;
      if (typeof payload !== "object" || payload === null || !("type" in payload) || !("callbackUrl" in payload)) return;
      if (payload.type !== "antigravity-oauth-callback" || typeof payload.callbackUrl !== "string") return;
      antigravityPopupRef.current = null;
      setAntigravityCallback(payload.callbackUrl);
      void handleAntigravitySubmit(payload.callbackUrl);
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [handleAntigravitySubmit]);

  const handleOpenAntigravityLogin = useCallback(() => {
    antigravityPopupRef.current = window.open(antigravityAuthUrl, "antigravity_oauth", "width=600,height=700,scrollbars=yes");
  }, [antigravityAuthUrl]);

  const handleAntigravityKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === "Enter") void handleAntigravitySubmit();
  }, [handleAntigravitySubmit]);

  const handleCopyUrl = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(authUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard unavailable — ignore
    }
  }, [authUrl]);

  const handleOpenUrl = useCallback(() => {
    window.open(authUrl, "oauth_add", "width=600,height=700,scrollbars=yes");
  }, [authUrl]);

  const handleAddFallback = useCallback(async () => {
    const baseUrl = fbBaseUrl.trim();
    const apiKey = fbApiKey.trim();
    if (!baseUrl || !apiKey) {
      setLocalNotice(t("fallbackRequired"));
      return;
    }
    setFbSubmitting(true);
    setLocalNotice("");
    try {
      const err = await onAddFallbackUpstream(baseUrl, apiKey);
      if (err) {
        setLocalNotice(err);
        return;
      }
      setFbBaseUrl("");
      setFbApiKey("");
    } finally {
      setFbSubmitting(false);
    }
  }, [fbBaseUrl, fbApiKey, onAddFallbackUpstream, t]);

  if (!visible && (!notice || !noticeOpen)) return null;

  const claudeModels = antigravityModels.filter((model) => model.family === "claude");
  const geminiModels = antigravityModels.filter((model) => model.family === "gemini");

  return (
    <>
      {visible && (
        <section class="mb-8 space-y-5">
          <div class="flex items-center justify-between px-1">
            <div>
              <h2 class="text-lg font-semibold text-slate-800 dark:text-text-main">{t("addAccount")}</h2>
              <p class="mt-1 text-sm text-slate-500 dark:text-text-dim">{t("addAccountHint")}</p>
            </div>
            <button
              onClick={onCancel}
              class="rounded-lg px-3 py-2 text-sm text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700 dark:text-text-dim dark:hover:bg-border-dark dark:hover:text-text-main"
            >
              {t("cancel")}
            </button>
          </div>

          <div class="rounded-2xl border border-blue-200 bg-white shadow-sm dark:border-blue-900/60 dark:bg-card-dark">
            <div class="flex items-start gap-3 border-b border-blue-100 px-5 py-4 dark:border-blue-900/40">
              <span class="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-xs font-bold text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">C</span>
              <div>
                <h3 class="text-sm font-semibold text-slate-800 dark:text-text-main">{t("codexAccountTitle")}</h3>
                <p class="mt-1 text-xs text-slate-500 dark:text-text-dim">{t("codexAccountHint")}</p>
              </div>
            </div>

            <div class="grid gap-5 p-5 lg:grid-cols-2">
              <div class="space-y-3 rounded-xl bg-slate-50 p-4 dark:bg-bg-dark/70">
                <div>
                  <h4 class="text-sm font-medium text-slate-700 dark:text-text-main">{t("codexBrowserLoginTitle")}</h4>
                  <p class="mt-1 text-xs text-slate-500 dark:text-text-dim">{t("codexBrowserLoginHint")}</p>
                </div>
                {authUrl ? (
                  <>
                    <div class="flex gap-2">
                      <input
                        type="text"
                        value={authUrl}
                        readOnly
                        onFocus={(e) => e.currentTarget.select()}
                        class="min-w-0 flex-1 rounded-lg border border-gray-200 bg-white px-3 py-2.5 font-mono text-xs text-slate-600 outline-none dark:border-border-dark dark:bg-card-dark dark:text-text-main"
                      />
                      <button onClick={handleCopyUrl} class="rounded-lg border border-gray-200 bg-white px-3 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100 dark:border-border-dark dark:bg-card-dark dark:text-text-main dark:hover:bg-border-dark">
                        {copied ? t("copied") : t("copy")}
                      </button>
                    </div>
                    <button onClick={handleOpenUrl} class="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700">
                      {t("openUrl")}
                    </button>
                  </>
                ) : (
                  <p class="rounded-lg border border-dashed border-gray-300 px-3 py-3 text-xs text-slate-500 dark:border-border-dark dark:text-text-dim">{t("codexLoginPreparing")}</p>
                )}
                <details class="pt-1">
                  <summary class="cursor-pointer text-xs font-medium text-blue-700 dark:text-blue-300">{t("codexManualCallback")}</summary>
                  <div class="mt-3 space-y-3">
                    <ol class="list-inside list-decimal space-y-1.5 text-xs leading-5 text-slate-500 dark:text-text-dim">
                      <li dangerouslySetInnerHTML={{ __html: t("addStep1") }} />
                      <li dangerouslySetInnerHTML={{ __html: t("addStep2") }} />
                      <li dangerouslySetInnerHTML={{ __html: t("addStep3") }} />
                    </ol>
                    <div class="flex gap-2">
                      <input
                        type="text"
                        value={input}
                        onInput={(e) => setInput((e.target as HTMLInputElement).value)}
                        placeholder={t("pasteCallback")}
                        class="min-w-0 flex-1 rounded-lg border border-gray-200 bg-white px-3 py-2.5 font-mono text-xs text-slate-600 outline-none focus:border-blue-500 dark:border-border-dark dark:bg-card-dark dark:text-text-main"
                      />
                      <button onClick={handleSubmit} disabled={submitting || !input.trim()} class="rounded-lg border border-gray-200 px-4 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100 disabled:opacity-40 dark:border-border-dark dark:text-text-main dark:hover:bg-border-dark">
                        {submitting ? t("submitting") : t("submit")}
                      </button>
                    </div>
                  </div>
                </details>
              </div>

              <div class="space-y-3 rounded-xl bg-amber-50/70 p-4 dark:bg-amber-950/15">
                <div>
                  <h4 class="text-sm font-medium text-slate-700 dark:text-text-main">{t("codexRefreshLoginTitle")}</h4>
                  <p class="mt-1 text-xs text-slate-500 dark:text-text-dim">{t("codexRefreshLoginHint")}</p>
                </div>
                <div class="flex gap-2">
                  <input
                    type="password"
                    value={rtInput}
                    onInput={(e) => setRtInput((e.target as HTMLInputElement).value)}
                    onKeyDown={handleRtKeyDown}
                    placeholder={t("pasteRefreshToken")}
                    class="min-w-0 flex-1 rounded-lg border border-amber-200 bg-white px-3 py-2.5 font-mono text-xs text-slate-600 outline-none focus:border-amber-500 dark:border-amber-900/50 dark:bg-card-dark dark:text-text-main"
                  />
                  <button onClick={handleRtSubmit} disabled={rtSubmitting || !rtInput.trim()} class="rounded-lg bg-amber-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-amber-700 disabled:opacity-40">
                    {rtSubmitting ? t("addingByRt") : t("addByRt")}
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div class="rounded-2xl border border-violet-200 bg-white shadow-sm dark:border-violet-900/60 dark:bg-card-dark">
            <div class="flex items-start gap-3 border-b border-violet-100 px-5 py-4 dark:border-violet-900/40">
              <span class="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-violet-50 text-sm font-bold text-violet-700 dark:bg-violet-900/30 dark:text-violet-300">✦</span>
              <div>
                <h3 class="text-sm font-semibold text-slate-800 dark:text-text-main">{t("antigravityHomeTitle")}</h3>
                <p class="mt-1 text-xs text-slate-500 dark:text-text-dim">{t("antigravityHomeHint")}</p>
              </div>
            </div>

            <div class="space-y-4 p-5">
              {!antigravityAuthUrl ? (
                <button onClick={() => { void onStartAntigravityOAuth(); }} class="rounded-lg bg-violet-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-violet-700">
                  {t("antigravityStartLogin")}
                </button>
              ) : (
                <>
                  <div class="flex gap-2">
                    <input
                      type="text"
                      value={antigravityAuthUrl}
                      readOnly
                      onFocus={(e) => e.currentTarget.select()}
                      class="min-w-0 flex-1 rounded-lg border border-violet-200 bg-violet-50/40 px-3 py-2.5 font-mono text-xs text-slate-600 outline-none dark:border-violet-900/50 dark:bg-bg-dark dark:text-text-main"
                    />
                    <button onClick={handleOpenAntigravityLogin} class="rounded-lg bg-violet-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-violet-700">
                      {t("antigravityOpenLogin")}
                    </button>
                  </div>

                  <div class="rounded-xl border border-violet-100 bg-violet-50/50 p-4 dark:border-violet-900/40 dark:bg-violet-950/10">
                    <div class="flex flex-wrap items-center gap-2">
                      <span class="rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-violet-800 shadow-sm dark:bg-violet-900/30 dark:text-violet-200">{antigravityModels.length} {t("antigravityModelsAuto")}</span>
                      <span class="text-xs text-slate-500 dark:text-text-dim">{claudeModels.length} Claude · {geminiModels.length} Gemini</span>
                    </div>
                    <details class="mt-3">
                      <summary class="cursor-pointer text-xs font-medium text-violet-700 dark:text-violet-300">{t("antigravityModelsShow")}</summary>
                      <div class="mt-3 grid max-h-48 gap-x-4 gap-y-1 overflow-auto rounded-lg bg-white/80 p-3 font-mono text-[11px] text-slate-600 dark:bg-bg-dark/70 dark:text-text-dim sm:grid-cols-2">
                        {antigravityModels.map((model) => <span key={model.id}>{model.id}</span>)}
                      </div>
                    </details>
                  </div>

                  <div class="space-y-2">
                    <label class="text-xs font-medium text-slate-600 dark:text-text-dim">{t("antigravityCallbackLabel")}</label>
                    <input
                      type="text"
                      value={antigravityCallback}
                      onInput={(e) => setAntigravityCallback((e.target as HTMLInputElement).value)}
                      onKeyDown={handleAntigravityKeyDown}
                      placeholder={t("antigravityCallbackPlaceholder")}
                      class="w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 font-mono text-xs text-slate-600 outline-none focus:border-violet-500 dark:border-border-dark dark:bg-bg-dark dark:text-text-main"
                    />
                    <div class="flex justify-end">
                      <button
                        onClick={() => { void handleAntigravitySubmit(); }}
                        disabled={antigravitySubmitting || !antigravityCallback.trim()}
                        class="rounded-lg bg-violet-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-violet-700 disabled:opacity-40"
                      >
                        {antigravitySubmitting ? t("antigravityExchanging") : t("antigravitySubmitCode")}
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>

          <details class="rounded-xl border border-gray-200 bg-white px-5 py-4 dark:border-border-dark dark:bg-card-dark">
            <summary class="cursor-pointer text-sm font-medium text-slate-600 dark:text-text-main">{t("advancedAccountSettings")}</summary>
            <div class="mt-4 space-y-3 border-t border-gray-100 pt-4 dark:border-border-dark">
              <div>
                <h4 class="text-sm font-medium text-slate-700 dark:text-text-main">{t("fallbackUpstreamTitle")}</h4>
                <p class="mt-1 text-xs text-slate-500 dark:text-text-dim">{t("fallbackOnlyWhenExhaustedDesc")}</p>
              </div>
              {fallbackConfigured ? (
                <p class="rounded-lg border border-gray-200 bg-slate-50 px-3 py-2.5 text-xs text-slate-500 dark:border-border-dark dark:bg-bg-dark dark:text-text-dim">{t("fallbackAlreadyConfigured")}</p>
              ) : (
                <>
                  <input type="text" value={fbBaseUrl} onInput={(e) => setFbBaseUrl((e.target as HTMLInputElement).value)} placeholder={t("fallbackBaseUrl")} class="w-full rounded-lg border border-gray-200 bg-slate-50 px-3 py-2.5 font-mono text-sm text-slate-600 outline-none focus:border-cyan-500 dark:border-border-dark dark:bg-bg-dark dark:text-text-main" />
                  <input type="password" value={fbApiKey} onInput={(e) => setFbApiKey((e.target as HTMLInputElement).value)} placeholder={t("fallbackApiKey")} class="w-full rounded-lg border border-gray-200 bg-slate-50 px-3 py-2.5 font-mono text-sm text-slate-600 outline-none focus:border-cyan-500 dark:border-border-dark dark:bg-bg-dark dark:text-text-main" />
                  <button onClick={handleAddFallback} disabled={fbSubmitting || !fbBaseUrl.trim() || !fbApiKey.trim()} class="rounded-lg border border-cyan-200 bg-cyan-50 px-4 py-2 text-sm font-medium text-cyan-800 transition-colors hover:bg-cyan-100 disabled:opacity-40 dark:border-cyan-900/50 dark:bg-cyan-950/20 dark:text-cyan-300">
                    {fbSubmitting ? t("fallbackAdding") : t("fallbackAdd")}
                  </button>
                </>
              )}
            </div>
          </details>
        </section>
      )}

      {notice && noticeOpen && (
        <div class="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4" onClick={(e) => { if (e.target === e.currentTarget) setNoticeOpen(false); }}>
          <div role={noticeIsError ? "alertdialog" : "dialog"} aria-modal="true" aria-labelledby="account-notice-title" class="w-full max-w-md rounded-2xl border border-gray-200 bg-white p-5 shadow-2xl dark:border-border-dark dark:bg-card-dark">
            <div class="flex items-start gap-3">
              <span class={`mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-bold ${noticeIsError ? "bg-red-50 text-red-600 dark:bg-red-950/40 dark:text-red-300" : "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"}`}>
                {noticeIsError ? "!" : "✓"}
              </span>
              <div class="min-w-0 flex-1">
                <h2 id="account-notice-title" class="text-base font-semibold text-slate-800 dark:text-text-main">{noticeIsError ? t("accountNoticeError") : t("accountNoticeTitle")}</h2>
                <p class={`mt-2 break-words text-sm leading-6 ${noticeIsError ? "text-red-600 dark:text-red-300" : "text-slate-600 dark:text-text-dim"}`}>{t(notice as TranslationKey)}</p>
              </div>
            </div>
            <div class="mt-5 flex justify-end">
              <button onClick={() => setNoticeOpen(false)} class="rounded-lg bg-primary-action px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-primary-action-hover">{t("confirm")}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
