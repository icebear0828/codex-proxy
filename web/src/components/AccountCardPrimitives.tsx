import type { ComponentChildren } from "preact";

const avatarColors = [
  ["bg-avatar-purple-bg", "text-avatar-purple-text"],
  ["bg-avatar-amber-bg", "text-avatar-amber-text"],
  ["bg-avatar-blue-bg", "text-avatar-blue-text"],
  ["bg-avatar-emerald-bg", "text-avatar-emerald-text"],
  ["bg-avatar-red-bg", "text-avatar-red-text"],
];

export function AccountCardSurface({ children, selected = false }: { children: ComponentChildren; selected?: boolean }) {
  return (
    <div class={`bg-white dark:bg-card-dark border rounded-xl p-4 shadow-sm hover:shadow-md transition-all ${selected ? "border-primary ring-1 ring-primary/30" : "border-gray-200 dark:border-border-dark hover:border-primary/30 dark:hover:border-primary/50"}`}>
      {children}
    </div>
  );
}

export function AccountCardAvatar({ initial, index }: { initial: string; index: number }) {
  const [bgColor, textColor] = avatarColors[index % avatarColors.length];
  return <div class={`size-10 rounded-full ${bgColor} ${textColor} flex items-center justify-center font-bold text-lg`}>{initial}</div>;
}

export function AccountCardHeader({ children }: { children: ComponentChildren }) {
  return <div class="flex flex-wrap justify-between items-start gap-2 mb-4">{children}</div>;
}

export function AccountCardStatusToggle({ enabled, disabled, title, onClick }: { enabled: boolean; disabled?: boolean; title: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      class={`relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none ${disabled ? "opacity-40 cursor-not-allowed" : "cursor-pointer"} ${enabled ? "bg-primary-action" : "bg-slate-300 dark:bg-slate-600"}`}
    >
      <span class={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white dark:bg-slate-200 shadow transform transition-transform duration-200 ${enabled ? "translate-x-4" : "translate-x-0"}`} />
    </button>
  );
}

export function AccountCardStatusBadge({ className, children }: { className: string; children: ComponentChildren }) {
  return <span class={`px-2.5 py-1 rounded-full ${className} text-xs font-medium border`}>{children}</span>;
}

export function AccountCardRefreshButton({ refreshing, title, onClick }: { refreshing: boolean; title: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={refreshing}
      class="p-1.5 text-slate-400 dark:text-text-dim hover:text-amber-500 transition-colors rounded-md hover:bg-amber-50 dark:hover:bg-amber-900/20 disabled:opacity-40"
      title={title}
    >
      <svg class={`size-[16px] ${refreshing ? "animate-spin" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" />
      </svg>
    </button>
  );
}

export function AccountCardDeleteButton({ title, onClick }: { title: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      class="p-1.5 text-slate-400 dark:text-text-dim hover:text-red-500 transition-colors rounded-md hover:bg-red-50 dark:hover:bg-red-900/20"
      title={title}
    >
      <svg class="size-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path stroke-linecap="round" stroke-linejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
      </svg>
    </button>
  );
}

export function AccountCardStats({ children }: { children: ComponentChildren }) {
  return <div class="space-y-2">{children}</div>;
}

export function AccountCardStatRow({ label, value, muted = false }: { label: string; value: ComponentChildren; muted?: boolean }) {
  const textClass = muted ? "text-slate-400 dark:text-text-dim/70" : "text-slate-500 dark:text-text-dim";
  return (
    <div class={`flex justify-between ${muted ? "text-[0.68rem]" : "text-[0.78rem]"}`}>
      <span class={textClass}>{label}</span>
      <span class={muted ? textClass : "font-medium"}>{value}</span>
    </div>
  );
}

/** Same remaining-capacity bar used for Codex quota windows, reusable for model-specific providers. */
export function AccountCardProgressBar({ remaining, color, testId }: { remaining: number; color?: string; testId?: string }) {
  const bounded = Math.max(0, Math.min(100, remaining));
  const fill = color ?? (bounded <= 10 ? "bg-red-500" : bounded <= 40 ? "bg-amber-500" : "bg-primary-action");
  return (
    <div class="w-full bg-slate-100 dark:bg-border-dark rounded-full h-2 overflow-hidden">
      <div data-testid={testId} class={`${fill} h-2 rounded-full transition-all`} style={{ width: `${bounded}%` }} />
    </div>
  );
}
