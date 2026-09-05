import { useT } from "../../../shared/i18n/context";
import type { UpdateStatus } from "../../../shared/hooks/use-update-status";

interface FooterProps {
  updateStatus: UpdateStatus | null;
}

export function Footer({ updateStatus }: FooterProps) {
  const t = useT();

  const proxyVersion = updateStatus?.proxy.version ?? "...";
  const proxyCommit = updateStatus?.proxy.commit;
  const codexVersion = updateStatus?.codex.current_version;

  return (
    <footer class="mt-auto shrink-0 border-t border-gray-200 dark:border-border-dark bg-white dark:bg-card-dark py-5 transition-colors">
      <div class="container mx-auto px-4 flex flex-col items-center gap-2">
        {/* Version info */}
        <div class="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[0.75rem] text-slate-400 dark:text-text-dim font-mono">
          <span>Proxy v{proxyVersion}{proxyCommit ? ` (${proxyCommit})` : ""}</span>
          <span class="text-slate-300 dark:text-border-dark">&middot;</span>
          <span>Codex Desktop {codexVersion ? `v${codexVersion}` : "—"}</span>
        </div>
        {/* Copyright */}
        <p class="text-[0.75rem] text-slate-400 dark:text-text-dim">{t("footer")}</p>
      </div>
    </footer>
  );
}
