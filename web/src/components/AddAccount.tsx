import { useState, useCallback } from "preact/hooks";
import { useT } from "../../../shared/i18n/context";
import type { TranslationKey } from "../../../shared/i18n/translations";

interface AddAccountProps {
  visible: boolean;
  onCancel: () => void;
  onSubmitRelay: (callbackUrl: string) => Promise<void>;
  onAddByRefreshToken: (refreshToken: string) => Promise<string | null>;
  onStartAntigravityOAuth: () => Promise<void>;
  onSubmitAntigravityOAuth: (callbackUrl: string, models: string[]) => Promise<boolean>;
  addInfo: string;
  addError: string;
  authUrl: string;
  antigravityAuthUrl: string;
  fallbackConfigured: boolean;
  onAddFallbackUpstream: (baseUrl: string, apiKey: string) => Promise<string | null>;
}

export function AddAccount({ visible, onCancel, onSubmitRelay, onAddByRefreshToken, onStartAntigravityOAuth, onSubmitAntigravityOAuth, addInfo, addError, authUrl, antigravityAuthUrl, fallbackConfigured, onAddFallbackUpstream }: AddAccountProps) {
  const t = useT();
  const [input, setInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [rtInput, setRtInput] = useState("");
  const [rtSubmitting, setRtSubmitting] = useState(false);
  const [antigravityCallback, setAntigravityCallback] = useState("");
  const [antigravityModels, setAntigravityModels] = useState("claude-sonnet-4-5");
  const [antigravitySubmitting, setAntigravitySubmitting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [fbBaseUrl, setFbBaseUrl] = useState("");
  const [fbApiKey, setFbApiKey] = useState("");
  const [fbSubmitting, setFbSubmitting] = useState(false);
  const [fbError, setFbError] = useState<string | null>(null);

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
    if (e.key === "Enter") handleRtSubmit();
  }, [handleRtSubmit]);

  const handleAntigravitySubmit = useCallback(async () => {
    const callbackUrl = antigravityCallback.trim();
    const models = [...new Set(antigravityModels.split(",").map((model) => model.trim()).filter(Boolean))];
    if (!callbackUrl || models.length === 0) return;
    setAntigravitySubmitting(true);
    try {
      if (await onSubmitAntigravityOAuth(callbackUrl, models)) {
        setAntigravityCallback("");
        setAntigravityModels("claude-sonnet-4-5");
      }
    } finally {
      setAntigravitySubmitting(false);
    }
  }, [antigravityCallback, antigravityModels, onSubmitAntigravityOAuth]);

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
      setFbError(t("fallbackRequired"));
      return;
    }
    setFbSubmitting(true);
    setFbError(null);
    try {
      const err = await onAddFallbackUpstream(baseUrl, apiKey);
      if (err) {
        setFbError(err);
        return;
      }
      setFbBaseUrl("");
      setFbApiKey("");
    } finally {
      setFbSubmitting(false);
    }
  }, [fbBaseUrl, fbApiKey, onAddFallbackUpstream, t]);

  if (!visible && !addInfo && !addError) return null;

  return (
    <>
      {addInfo && (
        <p class="text-sm text-primary">{t(addInfo as TranslationKey)}</p>
      )}
      {addError && (
        <p class="text-sm text-red-500">{t(addError as TranslationKey)}</p>
      )}
      {visible && (
        <section class="bg-white dark:bg-card-dark border border-gray-200 dark:border-border-dark rounded-xl p-5 shadow-sm transition-colors space-y-4">
          <div class="flex justify-end">
            <button
              onClick={onCancel}
              class="text-slate-400 hover:text-slate-600 dark:text-text-dim dark:hover:text-text-main transition-colors text-sm"
            >
              {t("cancel")}
            </button>
          </div>

          {/* Login URL */}
          {authUrl && (
            <div class="space-y-2">
              <div class="flex gap-2">
                <input
                  type="text"
                  value={authUrl}
                  readOnly
                  onFocus={(e) => e.currentTarget.select()}
                  class="flex-1 px-3 py-2.5 bg-slate-50 dark:bg-bg-dark border border-gray-200 dark:border-border-dark rounded-lg text-sm font-mono text-slate-600 dark:text-text-main focus:ring-2 focus:ring-primary/50 focus:border-primary outline-none transition-colors"
                />
                <button
                  onClick={handleCopyUrl}
                  class="px-3 py-2.5 bg-white dark:bg-card-dark border border-gray-200 dark:border-border-dark rounded-lg text-sm font-medium text-slate-700 dark:text-text-main hover:bg-slate-50 dark:hover:bg-border-dark transition-colors"
                >
                  {copied ? t("copied") : t("copy")}
                </button>
              </div>
              <button
                onClick={handleOpenUrl}
                class="w-full px-4 py-2.5 bg-primary-action hover:bg-primary-action-hover text-white text-sm font-semibold rounded-lg transition-colors shadow-sm active:scale-[0.98]"
              >
                {t("openUrl")}
              </button>
            </div>
          )}

          <div class="pt-3 border-t border-gray-100 dark:border-border-dark space-y-3">
            <div>
              <h3 class="text-sm font-semibold text-slate-700 dark:text-text-main">{t("antigravityHomeTitle")}</h3>
              <p class="text-xs text-slate-500 dark:text-text-dim mt-1">{t("antigravityHomeHint")}</p>
            </div>
            {!antigravityAuthUrl ? (
              <button
                onClick={() => { void onStartAntigravityOAuth(); }}
                class="px-4 py-2.5 bg-primary-action hover:bg-primary-action-hover text-white text-sm font-semibold rounded-lg transition-colors shadow-sm active:scale-[0.98]"
              >
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
                    class="flex-1 min-w-0 px-3 py-2.5 bg-slate-50 dark:bg-bg-dark border border-gray-200 dark:border-border-dark rounded-lg text-xs font-mono text-slate-600 dark:text-text-main"
                  />
                  <button
                    onClick={() => window.open(antigravityAuthUrl, "antigravity_oauth", "width=600,height=700,scrollbars=yes")}
                    class="px-3 py-2.5 bg-primary-action hover:bg-primary-action-hover text-white text-sm font-semibold rounded-lg"
                  >
                    {t("antigravityOpenLogin")}
                  </button>
                </div>
                <input
                  type="text"
                  value={antigravityCallback}
                  onInput={(e) => setAntigravityCallback((e.target as HTMLInputElement).value)}
                  onKeyDown={handleAntigravityKeyDown}
                  placeholder={t("antigravityCallbackPlaceholder")}
                  class="w-full px-3 py-2.5 bg-slate-50 dark:bg-bg-dark border border-gray-200 dark:border-border-dark rounded-lg text-sm font-mono text-slate-600 dark:text-text-main"
                />
                <div class="flex flex-wrap items-center gap-2">
                  <label class="text-xs text-slate-500 dark:text-text-dim">{t("antigravityModelsLabel")}</label>
                  <input
                    type="text"
                    value={antigravityModels}
                    onInput={(e) => setAntigravityModels((e.target as HTMLInputElement).value)}
                    placeholder="claude-sonnet-4-5, gemini-..."
                    class="flex-1 min-w-[220px] px-3 py-2 bg-slate-50 dark:bg-bg-dark border border-gray-200 dark:border-border-dark rounded-lg text-sm font-mono text-slate-600 dark:text-text-main"
                  />
                  <button
                    onClick={() => { void handleAntigravitySubmit(); }}
                    disabled={antigravitySubmitting || !antigravityCallback.trim() || !antigravityModels.trim()}
                    class="px-4 py-2.5 bg-primary-action hover:bg-primary-action-hover text-white text-sm font-semibold rounded-lg disabled:opacity-40"
                  >
                    {antigravitySubmitting ? t("antigravityExchanging") : t("antigravitySubmitCode")}
                  </button>
                </div>
              </>
            )}
          </div>

          {/* Refresh token direct add */}
          <div class="pt-3 border-t border-gray-100 dark:border-border-dark">
            <div class="flex gap-3">
              <input
                type="text"
                value={rtInput}
                onInput={(e) => setRtInput((e.target as HTMLInputElement).value)}
                onKeyDown={handleRtKeyDown}
                placeholder={t("pasteRefreshToken")}
                class="flex-1 px-3 py-2.5 bg-slate-50 dark:bg-bg-dark border border-gray-200 dark:border-border-dark rounded-lg text-sm font-mono text-slate-600 dark:text-text-main focus:ring-2 focus:ring-amber-500/50 focus:border-amber-500 outline-none transition-colors"
              />
              <button
                onClick={handleRtSubmit}
                disabled={rtSubmitting || !rtInput.trim()}
                class="px-4 py-2.5 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/30 rounded-lg text-sm font-medium text-amber-700 dark:text-amber-400 hover:bg-amber-100 dark:hover:bg-amber-900/30 transition-colors disabled:opacity-40"
              >
                {rtSubmitting ? t("addingByRt") : t("addByRt")}
              </button>
            </div>
          </div>

          {/* Fallback upstream apikey (single, last-resort) */}
          <div class="pt-3 border-t border-gray-100 dark:border-border-dark">
            <div class="text-sm font-medium text-slate-700 dark:text-text-main mb-1">
              {t("fallbackUpstreamTitle")}
            </div>
            <div class="text-xs text-slate-500 dark:text-text-dim mb-3">
              {t("fallbackOnlyWhenExhaustedDesc")}
            </div>
            {fallbackConfigured ? (
              <p class="text-xs text-slate-500 dark:text-text-dim bg-slate-50 dark:bg-bg-dark border border-gray-200 dark:border-border-dark rounded-lg px-3 py-2.5">
                {t("fallbackAlreadyConfigured")}
              </p>
            ) : (
              <>
                <div class="space-y-2">
                  <input
                    type="text"
                    value={fbBaseUrl}
                    onInput={(e) => setFbBaseUrl((e.target as HTMLInputElement).value)}
                    placeholder={t("fallbackBaseUrl")}
                    class="w-full px-3 py-2.5 bg-slate-50 dark:bg-bg-dark border border-gray-200 dark:border-border-dark rounded-lg text-sm font-mono text-slate-600 dark:text-text-main focus:ring-2 focus:ring-cyan-500/50 focus:border-cyan-500 outline-none transition-colors"
                  />
                  <input
                    type="password"
                    value={fbApiKey}
                    onInput={(e) => setFbApiKey((e.target as HTMLInputElement).value)}
                    placeholder={t("fallbackApiKey")}
                    class="w-full px-3 py-2.5 bg-slate-50 dark:bg-bg-dark border border-gray-200 dark:border-border-dark rounded-lg text-sm font-mono text-slate-600 dark:text-text-main focus:ring-2 focus:ring-cyan-500/50 focus:border-cyan-500 outline-none transition-colors"
                  />
                </div>
                {fbError && <p class="text-xs text-red-500 mt-1">{fbError}</p>}
                <button
                  onClick={handleAddFallback}
                  disabled={fbSubmitting || !fbBaseUrl.trim() || !fbApiKey.trim()}
                  class="mt-2 px-4 py-2 bg-cyan-50 dark:bg-cyan-900/20 border border-cyan-200 dark:border-cyan-800/30 rounded-lg text-sm font-medium text-cyan-700 dark:text-cyan-400 hover:bg-cyan-100 dark:hover:bg-cyan-900/30 transition-colors disabled:opacity-40"
                >
                  {fbSubmitting ? t("fallbackAdding") : t("fallbackAdd")}
                </button>
              </>
            )}
          </div>

          {/* OAuth callback relay */}
          <div class="pt-3 border-t border-gray-100 dark:border-border-dark">
            <ol class="text-sm text-slate-500 dark:text-text-dim mb-4 space-y-1.5 list-decimal list-inside">
              <li dangerouslySetInnerHTML={{ __html: t("addStep1") }} />
              <li dangerouslySetInnerHTML={{ __html: t("addStep2") }} />
              <li dangerouslySetInnerHTML={{ __html: t("addStep3") }} />
            </ol>
            <div class="flex gap-3">
              <input
                type="text"
                value={input}
                onInput={(e) => setInput((e.target as HTMLInputElement).value)}
                placeholder={t("pasteCallback")}
                class="flex-1 px-3 py-2.5 bg-slate-50 dark:bg-bg-dark border border-gray-200 dark:border-border-dark rounded-lg text-sm font-mono text-slate-600 dark:text-text-main focus:ring-2 focus:ring-primary/50 focus:border-primary outline-none transition-colors"
              />
              <button
                onClick={handleSubmit}
                disabled={submitting}
                class="px-4 py-2.5 bg-white dark:bg-card-dark border border-gray-200 dark:border-border-dark rounded-lg text-sm font-medium text-slate-700 dark:text-text-main hover:bg-slate-50 dark:hover:bg-border-dark transition-colors"
              >
                {submitting ? t("submitting") : t("submit")}
              </button>
            </div>
          </div>
        </section>
      )}
    </>
  );
}
