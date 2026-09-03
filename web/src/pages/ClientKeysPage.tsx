import { useState } from "preact/hooks";
import type { FunctionalComponent, JSX } from "preact";
import { useClientKeys } from "../../../shared/hooks/use-client-keys";
import { useT } from "../../../shared/i18n/context";
import { clipboardCopy } from "../../../shared/utils/clipboard";
import type {
  ClientKeyPublicSummary,
  CreateClientKeyInput,
  UpdateClientKeyInput,
} from "../../../shared/types";

interface ClientKeysPageProps {
  masterApiKey?: string;
}

export const ClientKeysPage: FunctionalComponent<ClientKeysPageProps> = ({
  masterApiKey,
}) => {
  const t = useT();
  const {
    keys,
    totalCostUsd,
    totalRequests,
    isLoading,
    error,
    createKey,
    updateKey,
    toggleStatus,
    resetUsage,
    deleteKey,
  } = useClientKeys(masterApiKey);

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingKey, setEditingKey] = useState<ClientKeyPublicSummary | null>(null);
  const [createdSecretKey, setCreatedSecretKey] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState(false);

  // Form State
  const [formName, setFormName] = useState("");
  const [formCustomKey, setFormCustomKey] = useState("");
  const [formExpiresAt, setFormExpiresAt] = useState("");
  const [formMaxBudgetUsd, setFormMaxBudgetUsd] = useState("");
  const [formMaxTokens, setFormMaxTokens] = useState("");
  const [formMaxConcurrency, setFormMaxConcurrency] = useState("");
  const [formAllowedModels, setFormAllowedModels] = useState("");
  const [formDefaultTools, setFormDefaultTools] = useState("");
  const [formStatus, setFormStatus] = useState<"active" | "disabled">("active");
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleOpenCreate = () => {
    setFormName("");
    setFormCustomKey("");
    setFormExpiresAt("");
    setFormMaxBudgetUsd("");
    setFormMaxTokens("");
    setFormMaxConcurrency("");
    setFormAllowedModels("");
    setFormDefaultTools("");
    setFormStatus("active");
    setFormError(null);
    setCreatedSecretKey(null);
    setCopiedKey(false);
    setShowCreateModal(true);
  };

  const handleOpenEdit = (key: ClientKeyPublicSummary) => {
    setEditingKey(key);
    setFormName(key.name);
    setFormExpiresAt(key.expires_at ? key.expires_at.slice(0, 16) : "");
    setFormMaxBudgetUsd(key.max_budget_usd != null ? String(key.max_budget_usd) : "");
    setFormMaxTokens(key.max_tokens != null ? String(key.max_tokens) : "");
    setFormMaxConcurrency(key.max_concurrency != null ? String(key.max_concurrency) : "");
    setFormAllowedModels(key.allowed_models ? key.allowed_models.join(", ") : "");
    setFormDefaultTools(
      key.default_tools === null
        ? ""
        : key.default_tools.length === 0
          ? "none"
          : key.default_tools.join(", ")
    );
    setFormStatus(key.status);
    setFormError(null);
  };

  const handleCreateSubmit = async (e: JSX.TargetedEvent<HTMLFormElement, Event>) => {
    e.preventDefault();
    setFormError(null);
    setIsSubmitting(true);

    const input: CreateClientKeyInput = {
      name: formName.trim(),
    };

    if (formCustomKey.trim()) {
      input.key = formCustomKey.trim();
    }
    if (formExpiresAt.trim()) {
      input.expires_at = new Date(formExpiresAt).toISOString();
    }
    if (formMaxBudgetUsd.trim()) {
      const val = parseFloat(formMaxBudgetUsd.trim());
      if (isNaN(val) || val <= 0) {
        setFormError("Invalid max budget");
        setIsSubmitting(false);
        return;
      }
      input.max_budget_usd = val;
    }
    if (formMaxTokens.trim()) {
      const val = parseInt(formMaxTokens.trim(), 10);
      if (isNaN(val) || val <= 0) {
        setFormError("Invalid max tokens");
        setIsSubmitting(false);
        return;
      }
      input.max_tokens = val;
    }
    if (formMaxConcurrency.trim()) {
      const val = parseInt(formMaxConcurrency.trim(), 10);
      if (isNaN(val) || val <= 0) {
        setFormError("Invalid max concurrency");
        setIsSubmitting(false);
        return;
      }
      input.max_concurrency = val;
    }
    if (formAllowedModels.trim()) {
      input.allowed_models = formAllowedModels
        .split(",")
        .map((m) => m.trim())
        .filter(Boolean);
    }
    if (formDefaultTools.trim()) {
      const val = formDefaultTools.trim().toLowerCase();
      if (val === "none" || val === "off" || val === "[]") {
        input.default_tools = [];
      } else {
        input.default_tools = formDefaultTools
          .split(",")
          .map((m) => m.trim())
          .filter(Boolean);
      }
    }

    try {
      const res = await createKey(input);
      setCreatedSecretKey(res.key);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleEditSubmit = async (e: JSX.TargetedEvent<HTMLFormElement, Event>) => {
    e.preventDefault();
    if (!editingKey) return;

    setFormError(null);
    setIsSubmitting(true);

    const input: UpdateClientKeyInput = {
      name: formName.trim(),
      status: formStatus,
    };

    if (formExpiresAt.trim()) {
      input.expires_at = new Date(formExpiresAt).toISOString();
    } else {
      input.expires_at = null;
    }

    if (formMaxBudgetUsd.trim()) {
      const val = parseFloat(formMaxBudgetUsd.trim());
      if (isNaN(val) || val <= 0) {
        setFormError("Invalid max budget");
        setIsSubmitting(false);
        return;
      }
      input.max_budget_usd = val;
    } else {
      input.max_budget_usd = null;
    }

    if (formMaxTokens.trim()) {
      const val = parseInt(formMaxTokens.trim(), 10);
      if (isNaN(val) || val <= 0) {
        setFormError("Invalid max tokens");
        setIsSubmitting(false);
        return;
      }
      input.max_tokens = val;
    } else {
      input.max_tokens = null;
    }

    if (formMaxConcurrency.trim()) {
      const val = parseInt(formMaxConcurrency.trim(), 10);
      if (isNaN(val) || val <= 0) {
        setFormError("Invalid max concurrency");
        setIsSubmitting(false);
        return;
      }
      input.max_concurrency = val;
    } else {
      input.max_concurrency = null;
    }

    if (formAllowedModels.trim()) {
      input.allowed_models = formAllowedModels
        .split(",")
        .map((m) => m.trim())
        .filter(Boolean);
    } else {
      input.allowed_models = null;
    }

    if (formDefaultTools.trim()) {
      const val = formDefaultTools.trim().toLowerCase();
      if (val === "none" || val === "off" || val === "[]") {
        input.default_tools = [];
      } else {
        input.default_tools = formDefaultTools
          .split(",")
          .map((m) => m.trim())
          .filter(Boolean);
      }
    } else {
      input.default_tools = null;
    }

    try {
      await updateKey(editingKey.id, input);
      setEditingKey(null);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCopySecret = async () => {
    if (createdSecretKey) {
      await clipboardCopy(createdSecretKey);
      setCopiedKey(true);
      setTimeout(() => setCopiedKey(false), 2000);
    }
  };

  const inputCls =
    "w-full px-3 py-2 bg-white dark:bg-bg-dark border border-gray-200 dark:border-border-dark rounded-lg text-xs font-mono text-slate-800 dark:text-text-main outline-none focus:ring-1 focus:ring-primary";

  return (
    <div class="space-y-6">
      {/* Top Header & Summary Stats */}
      <div class="bg-white dark:bg-card-dark rounded-xl p-6 shadow-sm border border-gray-200 dark:border-border-dark flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 class="text-xl font-bold text-slate-800 dark:text-slate-100 flex items-center gap-2">
            🔑 {t("clientKeys")}
          </h2>
          <p class="text-xs text-slate-500 dark:text-text-dim mt-1">
            {t("clientKeysDesc")}
          </p>
        </div>
        <button
          onClick={handleOpenCreate}
          class="px-4 py-2 bg-primary-action hover:bg-primary-action-hover text-white rounded-lg transition-colors text-xs font-semibold flex items-center justify-center gap-1.5 shadow-sm cursor-pointer"
        >
          <span>+</span> {t("addClientKey")}
        </button>
      </div>

      {/* Global Usage Cards */}
      <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div class="bg-white dark:bg-card-dark p-4 rounded-xl border border-gray-200 dark:border-border-dark shadow-sm">
          <div class="text-xs font-semibold text-slate-500 dark:text-text-dim uppercase tracking-wider">{t("totalAll")}</div>
          <div class="text-2xl font-bold text-slate-800 dark:text-slate-100 mt-1">{keys.length}</div>
        </div>
        <div class="bg-white dark:bg-card-dark p-4 rounded-xl border border-gray-200 dark:border-border-dark shadow-sm">
          <div class="text-xs font-semibold text-slate-500 dark:text-text-dim uppercase tracking-wider">{t("active")}</div>
          <div class="text-2xl font-bold text-emerald-600 dark:text-emerald-400 mt-1">
            {keys.filter((k) => k.status === "active").length}
          </div>
        </div>
        <div class="bg-white dark:bg-card-dark p-4 rounded-xl border border-gray-200 dark:border-border-dark shadow-sm">
          <div class="text-xs font-semibold text-slate-500 dark:text-text-dim uppercase tracking-wider">{t("clientKeyUsedCost")}</div>
          <div class="text-2xl font-bold text-amber-600 dark:text-amber-400 mt-1">
            ${totalCostUsd.toFixed(4)}
          </div>
        </div>
        <div class="bg-white dark:bg-card-dark p-4 rounded-xl border border-gray-200 dark:border-border-dark shadow-sm">
          <div class="text-xs font-semibold text-slate-500 dark:text-text-dim uppercase tracking-wider">{t("clientKeyRequests")}</div>
          <div class="text-2xl font-bold text-blue-600 dark:text-blue-400 mt-1">
            {totalRequests.toLocaleString()}
          </div>
        </div>
      </div>

      {error && (
        <div class="p-4 bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-300 rounded-xl border border-red-200 dark:border-red-800 text-sm">
          {error}
        </div>
      )}

      {/* Keys List */}
      <div class="bg-white dark:bg-card-dark rounded-xl border border-gray-200 dark:border-border-dark overflow-hidden shadow-sm">
        {isLoading && keys.length === 0 ? (
          <div class="p-8 text-center text-slate-500 dark:text-text-dim text-sm">{t("loading")}</div>
        ) : keys.length === 0 ? (
          <div class="p-12 text-center text-slate-500 dark:text-text-dim space-y-3">
            <div class="text-3xl">📭</div>
            <div class="font-medium text-slate-700 dark:text-slate-300">{t("noClientKeys")}</div>
          </div>
        ) : (
          <div class="overflow-x-auto">
            <table class="w-full text-left text-xs border-collapse">
              <thead>
                <tr class="border-b border-gray-200 dark:border-border-dark bg-slate-50 dark:bg-slate-900/50 text-slate-500 dark:text-text-dim">
                  <th class="py-3 px-4 font-semibold">{t("clientKeyName")}</th>
                  <th class="py-3 px-4 font-semibold">{t("clientKeySecret")}</th>
                  <th class="py-3 px-4 font-semibold">{t("clientKeyBudget")}</th>
                  <th class="py-3 px-4 font-semibold">{t("clientKeyTokens")}</th>
                  <th class="py-3 px-4 font-semibold">{t("clientKeyConcurrency")}</th>
                  <th class="py-3 px-4 font-semibold">{t("clientKeyExpiresAt")}</th>
                  <th class="py-3 px-4 font-semibold">Status</th>
                  <th class="py-3 px-4 font-semibold text-right">Actions</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-gray-100 dark:divide-border-dark/60">
                {keys.map((k) => {
                  const isExpired = k.expires_at && new Date(k.expires_at).getTime() < Date.now();
                  const isBudgetExhausted =
                    k.max_budget_usd != null && k.used_cost_usd >= k.max_budget_usd;
                  const isTokensExhausted =
                    k.max_tokens != null && k.used_tokens >= k.max_tokens;

                  return (
                    <tr
                      key={k.id}
                      class="hover:bg-slate-50/50 dark:hover:bg-slate-800/40 transition"
                    >
                      <td class="py-3.5 px-4">
                        <div class="font-semibold text-slate-800 dark:text-text-main">
                          {k.name}
                        </div>
                        {k.allowed_models && k.allowed_models.length > 0 && (
                          <div class="text-[10px] text-slate-500 dark:text-text-dim mt-0.5">
                            {k.allowed_models.join(", ")}
                          </div>
                        )}
                        {k.default_tools != null && (
                          <div class="text-[10px] text-slate-500 dark:text-text-dim mt-0.5">
                            {k.default_tools.length > 0 ? (
                              <span class="text-primary font-medium">
                                Tools: {k.default_tools.join(", ")}
                              </span>
                            ) : (
                              <span>Tools: disabled</span>
                            )}
                          </div>
                        )}
                      </td>
                      <td class="py-3.5 px-4 font-mono text-slate-600 dark:text-text-dim">
                        {k.key_masked}
                      </td>
                      <td class="py-3.5 px-4">
                        <div class="text-slate-800 dark:text-text-main font-medium">
                          ${k.used_cost_usd.toFixed(4)}
                          <span class="text-slate-500 dark:text-text-dim text-[10px] font-normal">
                            {" / "}
                            {k.max_budget_usd != null ? `$${k.max_budget_usd}` : "∞"}
                          </span>
                        </div>
                        {isBudgetExhausted && (
                          <span class="inline-block px-1.5 py-0.2 bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300 rounded text-[9px] font-bold">
                            {t("quotaExhausted")}
                          </span>
                        )}
                      </td>
                      <td class="py-3.5 px-4">
                        <div class="text-slate-800 dark:text-text-main font-medium">
                          {k.used_tokens.toLocaleString()}
                          <span class="text-slate-500 dark:text-text-dim text-[10px] font-normal">
                            {" / "}
                            {k.max_tokens != null ? k.max_tokens.toLocaleString() : "∞"}
                          </span>
                        </div>
                        {isTokensExhausted && (
                          <span class="inline-block px-1.5 py-0.2 bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300 rounded text-[9px] font-bold">
                            {t("quotaExhausted")}
                          </span>
                        )}
                      </td>
                      <td class="py-3.5 px-4 text-slate-700 dark:text-text-main">
                        {k.max_concurrency != null ? `${k.max_concurrency} max` : "∞"}
                      </td>
                      <td class="py-3.5 px-4">
                        {k.expires_at ? (
                          <div class={isExpired ? "text-red-600 dark:text-red-400 font-medium" : "text-slate-700 dark:text-text-main"}>
                            {new Date(k.expires_at).toLocaleString()}
                            {isExpired && (
                              <div class="text-[10px] font-bold text-red-600 dark:text-red-400">
                                {t("expired")}
                              </div>
                            )}
                          </div>
                        ) : (
                          <span class="text-slate-500 dark:text-text-dim">{t("clientKeyNeverExpires")}</span>
                        )}
                      </td>
                      <td class="py-3.5 px-4">
                        <button
                          onClick={() => toggleStatus(k.id)}
                          class={`px-2.5 py-1 rounded-md text-[11px] font-semibold border transition-colors cursor-pointer ${
                            k.status === "active"
                              ? "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-400 dark:border-emerald-800/60 hover:bg-emerald-100 dark:hover:bg-emerald-950/60"
                              : "bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700 hover:bg-slate-200 dark:hover:bg-slate-700"
                          }`}
                        >
                          {k.status === "active" ? t("clientKeyStatusActive") : t("clientKeyStatusDisabled")}
                        </button>
                      </td>
                      <td class="py-3.5 px-4 text-right space-x-1.5 whitespace-nowrap">
                        <button
                          onClick={() => handleOpenEdit(k)}
                          class="px-2.5 py-1 text-slate-600 dark:text-text-main hover:bg-slate-100 dark:hover:bg-card-dark rounded-md font-semibold text-xs transition-colors cursor-pointer"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => {
                            if (confirm(t("clientKeyResetUsageConfirm"))) {
                              resetUsage(k.id);
                            }
                          }}
                          class="px-2.5 py-1 text-amber-600 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-950/30 rounded-md font-semibold text-xs transition-colors cursor-pointer"
                        >
                          {t("clientKeyResetUsage")}
                        </button>
                        <button
                          onClick={() => {
                            if (confirm(t("deleteClientKeyConfirm"))) {
                              deleteKey(k.id);
                            }
                          }}
                          class="px-2.5 py-1 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 rounded-md font-semibold text-xs transition-colors cursor-pointer"
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Create / Secret Key Reveal Modal */}
      {showCreateModal && (
        <div class="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div class="bg-white dark:bg-card-dark border border-gray-200 dark:border-border-dark rounded-2xl shadow-xl max-w-lg w-full p-6 space-y-4">
            <h3 class="text-lg font-bold text-slate-800 dark:text-text-main">
              {createdSecretKey ? t("clientKeySecret") : t("addClientKey")}
            </h3>

            {createdSecretKey ? (
              <div class="space-y-4">
                <p class="text-xs text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 p-3 rounded-lg border border-amber-200 dark:border-amber-800">
                  ⚠️ {t("clientKeyCreatedSuccess")}
                </p>
                <div>
                  <label class="block text-xs font-semibold text-slate-500 dark:text-text-dim mb-1">{t("clientKeySecret")}</label>
                  <div class="flex items-center gap-2">
                    <input
                      type="text"
                      readOnly
                      value={createdSecretKey}
                      class="flex-grow px-3 py-2 bg-slate-100 dark:bg-slate-900 border border-gray-200 dark:border-border-dark rounded-lg font-mono text-xs text-slate-800 dark:text-text-main"
                    />
                    <button
                      onClick={handleCopySecret}
                      class="px-3 py-2 bg-primary-action hover:bg-primary-action-hover text-white text-xs font-semibold rounded-lg transition-colors cursor-pointer shrink-0"
                    >
                      {copiedKey ? t("copied") : t("copy")}
                    </button>
                  </div>
                </div>
                <div class="flex justify-end pt-2">
                  <button
                    onClick={() => setShowCreateModal(false)}
                    class="px-4 py-2 bg-slate-800 hover:bg-slate-700 dark:bg-slate-200 dark:hover:bg-white text-white dark:text-slate-900 text-xs font-semibold rounded-lg transition-colors cursor-pointer"
                  >
                    {t("close")}
                  </button>
                </div>
              </div>
            ) : (
              <form onSubmit={handleCreateSubmit} class="space-y-3">
                {formError && (
                  <div class="p-2.5 bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 rounded text-xs font-medium">
                    {formError}
                  </div>
                )}
                <div>
                  <label class="block text-xs font-semibold text-slate-600 dark:text-text-main mb-1">
                    {t("clientKeyName")} *
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Frontend Dev Team / Alice"
                    value={formName}
                    onInput={(e) => setFormName((e.currentTarget as HTMLInputElement).value)}
                    class={inputCls}
                  />
                </div>

                <div>
                  <label class="block text-xs font-semibold text-slate-600 dark:text-text-main mb-1">
                    {t("clientKeySecret")}
                  </label>
                  <input
                    type="text"
                    placeholder="sk-proxy-custom-secret..."
                    value={formCustomKey}
                    onInput={(e) => setFormCustomKey((e.currentTarget as HTMLInputElement).value)}
                    class={inputCls}
                  />
                </div>

                <div class="grid grid-cols-2 gap-3">
                  <div>
                    <label class="block text-xs font-semibold text-slate-600 dark:text-text-main mb-1">
                      {t("clientKeyBudget")} ($)
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      placeholder="e.g. 5.00"
                      value={formMaxBudgetUsd}
                      onInput={(e) => setFormMaxBudgetUsd((e.currentTarget as HTMLInputElement).value)}
                      class={inputCls}
                    />
                  </div>
                  <div>
                    <label class="block text-xs font-semibold text-slate-600 dark:text-text-main mb-1">
                      {t("clientKeyTokens")}
                    </label>
                    <input
                      type="number"
                      placeholder="e.g. 100000"
                      value={formMaxTokens}
                      onInput={(e) => setFormMaxTokens((e.currentTarget as HTMLInputElement).value)}
                      class={inputCls}
                    />
                  </div>
                </div>

                <div class="grid grid-cols-2 gap-3">
                  <div>
                    <label class="block text-xs font-semibold text-slate-600 dark:text-text-main mb-1">
                      {t("clientKeyConcurrency")}
                    </label>
                    <input
                      type="number"
                      placeholder="e.g. 2"
                      value={formMaxConcurrency}
                      onInput={(e) => setFormMaxConcurrency((e.currentTarget as HTMLInputElement).value)}
                      class={inputCls}
                    />
                  </div>
                  <div>
                    <label class="block text-xs font-semibold text-slate-600 dark:text-text-main mb-1">
                      {t("clientKeyExpiresAt")}
                    </label>
                    <input
                      type="datetime-local"
                      value={formExpiresAt}
                      onInput={(e) => setFormExpiresAt((e.currentTarget as HTMLInputElement).value)}
                      class={inputCls}
                    />
                  </div>
                </div>

                <div>
                  <label class="block text-xs font-semibold text-slate-600 dark:text-text-main mb-1">
                    {t("clientKeyAllowedModels")} ({t("clientKeyAllowedModelsHint")})
                  </label>
                  <input
                    type="text"
                    placeholder="gpt-5.4, gpt-5.3-codex"
                    value={formAllowedModels}
                    onInput={(e) => setFormAllowedModels((e.currentTarget as HTMLInputElement).value)}
                    class={inputCls}
                  />
                </div>

                <div>
                  <label class="block text-xs font-semibold text-slate-600 dark:text-text-main mb-1">
                    {t("clientKeyDefaultTools")} ({t("clientKeyDefaultToolsHint")})
                  </label>
                  <input
                    type="text"
                    placeholder="web_search, image_generation"
                    value={formDefaultTools}
                    onInput={(e) => setFormDefaultTools((e.currentTarget as HTMLInputElement).value)}
                    class={inputCls}
                  />
                </div>

                <div class="flex justify-end gap-2 pt-3">
                  <button
                    type="button"
                    onClick={() => setShowCreateModal(false)}
                    class="px-3 py-1.5 text-xs font-medium text-slate-600 dark:text-text-dim hover:text-slate-900 dark:hover:text-text-main transition-colors cursor-pointer"
                  >
                    {t("cancel")}
                  </button>
                  <button
                    type="submit"
                    disabled={isSubmitting}
                    class="px-4 py-1.5 bg-primary-action hover:bg-primary-action-hover text-white text-xs font-semibold rounded-lg transition-colors disabled:opacity-40 cursor-pointer shadow-sm"
                  >
                    {isSubmitting ? "..." : t("submit")}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}

      {/* Edit Modal */}
      {editingKey && (
        <div class="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div class="bg-white dark:bg-card-dark border border-gray-200 dark:border-border-dark rounded-2xl shadow-xl max-w-lg w-full p-6 space-y-4">
            <h3 class="text-lg font-bold text-slate-800 dark:text-text-main">
              {t("editClientKey")}
            </h3>

            <form onSubmit={handleEditSubmit} class="space-y-3">
              {formError && (
                <div class="p-2.5 bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 rounded text-xs font-medium">
                  {formError}
                </div>
              )}
              <div>
                <label class="block text-xs font-semibold text-slate-600 dark:text-text-main mb-1">
                  {t("clientKeyName")} *
                </label>
                <input
                  type="text"
                  required
                  value={formName}
                  onInput={(e) => setFormName((e.currentTarget as HTMLInputElement).value)}
                  class={inputCls}
                />
              </div>

              <div class="grid grid-cols-2 gap-3">
                <div>
                  <label class="block text-xs font-semibold text-slate-600 dark:text-text-main mb-1">
                    {t("clientKeyBudget")} ($)
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    placeholder="Unlimited"
                    value={formMaxBudgetUsd}
                    onInput={(e) => setFormMaxBudgetUsd((e.currentTarget as HTMLInputElement).value)}
                    class={inputCls}
                  />
                </div>
                <div>
                  <label class="block text-xs font-semibold text-slate-600 dark:text-text-main mb-1">
                    {t("clientKeyTokens")}
                  </label>
                  <input
                    type="number"
                    placeholder="Unlimited"
                    value={formMaxTokens}
                    onInput={(e) => setFormMaxTokens((e.currentTarget as HTMLInputElement).value)}
                    class={inputCls}
                  />
                </div>
              </div>

              <div class="grid grid-cols-2 gap-3">
                <div>
                  <label class="block text-xs font-semibold text-slate-600 dark:text-text-main mb-1">
                    {t("clientKeyConcurrency")}
                  </label>
                  <input
                    type="number"
                    placeholder="Unlimited"
                    value={formMaxConcurrency}
                    onInput={(e) => setFormMaxConcurrency((e.currentTarget as HTMLInputElement).value)}
                    class={inputCls}
                  />
                </div>
                <div>
                  <label class="block text-xs font-semibold text-slate-600 dark:text-text-main mb-1">
                    {t("clientKeyExpiresAt")}
                  </label>
                  <input
                    type="datetime-local"
                    value={formExpiresAt}
                    onInput={(e) => setFormExpiresAt((e.currentTarget as HTMLInputElement).value)}
                    class={inputCls}
                  />
                </div>
              </div>

              <div>
                <label class="block text-xs font-semibold text-slate-600 dark:text-text-main mb-1">
                  {t("clientKeyAllowedModels")} ({t("clientKeyAllowedModelsHint")})
                </label>
                <input
                  type="text"
                  placeholder="gpt-5.4, gpt-5.3-codex"
                  value={formAllowedModels}
                  onInput={(e) => setFormAllowedModels((e.currentTarget as HTMLInputElement).value)}
                  class={inputCls}
                />
              </div>

              <div>
                <label class="block text-xs font-semibold text-slate-600 dark:text-text-main mb-1">
                  {t("clientKeyDefaultTools")} ({t("clientKeyDefaultToolsHint")})
                </label>
                <input
                  type="text"
                  placeholder="web_search, image_generation"
                  value={formDefaultTools}
                  onInput={(e) => setFormDefaultTools((e.currentTarget as HTMLInputElement).value)}
                  class={inputCls}
                />
              </div>

              <div>
                <label class="block text-xs font-semibold text-slate-600 dark:text-text-main mb-1">
                  Status
                </label>
                <select
                  value={formStatus}
                  onChange={(e) => setFormStatus((e.currentTarget as HTMLSelectElement).value as "active" | "disabled")}
                  class={inputCls}
                >
                  <option value="active">{t("clientKeyStatusActive")}</option>
                  <option value="disabled">{t("clientKeyStatusDisabled")}</option>
                </select>
              </div>

              <div class="flex justify-end gap-2 pt-3">
                <button
                  type="button"
                  onClick={() => setEditingKey(null)}
                  class="px-3 py-1.5 text-xs font-medium text-slate-600 dark:text-text-dim hover:text-slate-900 dark:hover:text-text-main transition-colors cursor-pointer"
                >
                  {t("cancel")}
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  class="px-4 py-1.5 bg-primary-action hover:bg-primary-action-hover text-white text-xs font-semibold rounded-lg transition-colors disabled:opacity-40 cursor-pointer shadow-sm"
                >
                  {isSubmitting ? "..." : t("submit")}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
