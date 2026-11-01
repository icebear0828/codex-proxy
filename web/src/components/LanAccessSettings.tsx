import { useState } from "preact/hooks";
import { useT } from "../../../shared/i18n/context";
import type { useGeneralSettings } from "../../../shared/hooks/use-general-settings";
import { SettingItemControl } from "./settings/SettingItemControl";

export function LanAccessSettings({ settings }: { settings: ReturnType<typeof useGeneralSettings> }) {
  const t = useT();
  const [draft, setDraft] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const data = settings.data;
  const custom = !!data && data.host !== "127.0.0.1" && data.host !== "0.0.0.0";
  const runtime = data?.lan_runtime;
  const pending = !!runtime && runtime.host !== data?.host;
  const active = runtime?.host === "0.0.0.0";
  const save = async () => {
    if (draft === null) return;
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      await settings.save({ lan_access: draft });
      setDraft(null);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };
  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopyStatus(t("lanAccessCopied"));
    } catch {
      setCopyStatus(t("lanAccessCopyFailed"));
    }
  };
  return (
    <div>
      <SettingItemControl
        label={t("lanAccessLabel")}
        hint={t("lanAccessHint")}
        isDirty={draft !== null && (custom || draft !== data?.lan_access)}
        saving={saving} saved={saved} error={error} requiresRestart onSave={save}
        disabled={!data}
      >
        <label class="flex items-center gap-2 text-sm text-slate-700 dark:text-text-main">
          <input type="checkbox" checked={draft ?? data?.lan_access ?? false}
            disabled={!data || saving} onChange={(e) => { setDraft(e.currentTarget.checked); setSaved(false); setError(null); }} />
          {t("lanAccessLabel")}
        </label>
        {custom && <p class="text-xs text-amber-600">{t("lanAccessCustom")}: {data?.host}
          <button type="button" class="ml-2 text-primary underline" onClick={() => setDraft(false)}>{t("lanAccessLocal")}</button>
        </p>}
        <p class="text-xs text-slate-500 dark:text-text-dim">{t("lanAccessKeyHint")}</p>
      </SettingItemControl>
      <div class="pb-3 space-y-2 text-xs text-slate-500 dark:text-text-dim" aria-live="polite">
        {pending && <p class="text-amber-600">{t("lanAccessRestart")}</p>}
        <p>{!runtime ? t("lanAccessUnknown") : active ? t("lanAccessActive") : runtime.host === "127.0.0.1" || runtime.host === "::1" ? t("lanAccessLocalStatus") : t("lanAccessCustomStatus")}</p>
        {active && !pending && <>
          {(data?.lan_ipv4_addresses ?? []).map(ip => {
            const url = `http://${ip}:${runtime.port}/v1`;
            return <div key={ip} class="flex items-center gap-2 flex-wrap">
              <code class="select-all break-all">{url}</code>
              <button type="button" class="text-primary underline" onClick={() => void copy(url)}>{t("lanAccessCopy")}</button>
            </div>;
          })}
          {!data?.lan_ipv4_addresses?.length && <p>{t("lanAccessNoAddress")}</p>}
          <p>{t("lanAccessFirewall")}</p>
        </>}
        {copyStatus && <p role="status">{copyStatus}</p>}
      </div>
    </div>
  );
}
