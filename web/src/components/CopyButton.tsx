import { useState, useCallback } from "preact/hooks";
import { clipboardCopy } from "../utils/clipboard";
import { useT } from "../i18n/context";

interface CopyButtonProps {
  getText: () => string;
  class?: string;
  titleKey?: string;
  variant?: "icon" | "label";
}

const SVG_COPY = (
  <svg class="size-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
    <rect x="9" y="9" width="13" height="13" rx="2" />
    <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
  </svg>
);

const SVG_CHECK = (
  <svg class="size-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5" />
  </svg>
);

const SVG_FAIL = (
  <svg class="size-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
  </svg>
);

export function CopyButton({ getText, class: className, titleKey, variant = "icon" }: CopyButtonProps) {
  const t = useT();
  const [state, setState] = useState<"idle" | "ok" | "fail">("idle");

  const handleCopy = useCallback(async () => {
    const ok = await clipboardCopy(getText());
    setState(ok ? "ok" : "fail");
    setTimeout(() => setState("idle"), 2000);
  }, [getText]);

  if (variant === "label") {
    const bgClass =
      state === "ok"
        ? "bg-primary hover:bg-primary-hover"
        : state === "fail"
          ? "bg-red-600 hover:bg-red-700"
          : "bg-slate-700 hover:bg-slate-600";

    return (
      <button
        onClick={handleCopy}
        class={`flex items-center gap-1.5 px-3 py-1.5 ${bgClass} text-white rounded text-xs font-medium transition-colors ${className || ""}`}
      >
        <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="9" y="9" width="13" height="13" rx="2" />
          <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
        </svg>
        <span>
          {state === "ok" ? t("copied") : state === "fail" ? t("copyFailed") : t("copy")}
        </span>
      </button>
    );
  }

  return (
    <button
      onClick={handleCopy}
      class={`p-1.5 transition-colors rounded-md hover:bg-slate-100 dark:hover:bg-border-dark ${
        state === "ok"
          ? "text-primary"
          : state === "fail"
            ? "text-red-500"
            : "text-slate-400 dark:text-text-dim hover:text-primary"
      } ${className || ""}`}
      title={titleKey ? t(titleKey as any) : undefined}
    >
      {state === "ok" ? SVG_CHECK : state === "fail" ? SVG_FAIL : SVG_COPY}
    </button>
  );
}
