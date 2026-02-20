import { useState, useCallback } from "preact/hooks";
import { useT } from "../i18n/context";

interface AddAccountProps {
  visible: boolean;
  onSubmitRelay: (callbackUrl: string) => Promise<void>;
  addInfo: string;
  addError: string;
}

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
        <p class="text-sm text-primary">{t(addInfo as any)}</p>
      )}
      {addError && (
        <p class="text-sm text-red-500">{t(addError as any)}</p>
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
        </section>
      )}
    </>
  );
}
