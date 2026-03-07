import { useState, useCallback } from "preact/hooks";
import { useT } from "../../../shared/i18n/context";
import type { TranslationKey } from "../../../shared/i18n/translations";

interface AddAccountProps {
  visible: boolean;
  onSubmitRelay: (callbackUrl: string) => Promise<void>;
  addInfo: string;
  addError: string;
}

const SVG_SPINNER = (
  <svg class="animate-spin size-3.5" viewBox="0 0 24 24" fill="none">
    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" />
    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
  </svg>
);

export function AddAccount({ visible, onSubmitRelay, addInfo, addError }: AddAccountProps) {
  const t = useT();
  const [input, setInput] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = useCallback(async () => {
    setSubmitting(true);
    await onSubmitRelay(input);
    setSubmitting(false);
    setInput("");
  }, [input, onSubmitRelay]);

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
        <section class="bg-white dark:bg-card-dark border border-gray-200 dark:border-border-dark rounded-xl p-5 shadow-sm transition-colors">
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
              class="flex-1 px-3 py-2.5 bg-slate-50 dark:bg-bg-dark border border-gray-200 dark:border-border-dark rounded-lg text-sm font-mono text-slate-600 dark:text-text-main focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 dark:focus-visible:ring-offset-bg-dark outline-none transition-colors"
            />
            <button
              onClick={handleSubmit}
              disabled={submitting}
              aria-label={submitting ? t("submitting") : t("submit")}
              class="flex items-center gap-2 px-4 py-2.5 bg-white dark:bg-card-dark border border-gray-200 dark:border-border-dark rounded-lg text-sm font-medium text-slate-700 dark:text-text-main hover:bg-slate-50 dark:hover:bg-border-dark focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 dark:focus-visible:ring-offset-bg-dark outline-none transition-colors"
            >
              {submitting && SVG_SPINNER}
              <span>{submitting ? t("submitting") : t("submit")}</span>
            </button>
          </div>
        </section>
      )}
    </>
  );
}
