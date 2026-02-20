import { useT } from "../i18n/context";

export function Footer() {
  const t = useT();

  return (
    <footer class="mt-auto border-t border-gray-200 dark:border-border-dark bg-white dark:bg-card-dark py-6 transition-colors">
      <div class="container mx-auto px-4 text-center">
        <p class="text-[0.8rem] text-slate-500 dark:text-text-dim">{t("footer")}</p>
      </div>
    </footer>
  );
}
