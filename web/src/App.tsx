import { I18nProvider } from "../../shared/i18n/context";
import { ThemeProvider } from "../../shared/theme/context";
import { Header } from "./components/Header";
import { AccountList } from "./components/AccountList";
import { AddAccount } from "./components/AddAccount";
import { ProxyPool } from "./components/ProxyPool";
import { ApiConfig } from "./components/ApiConfig";
import { AnthropicSetup } from "./components/AnthropicSetup";
import { CodeExamples } from "./components/CodeExamples";
import { Footer } from "./components/Footer";
import { useAccounts } from "../../shared/hooks/use-accounts";
import { useProxies } from "../../shared/hooks/use-proxies";
import { useStatus } from "../../shared/hooks/use-status";
import { useUpdateStatus } from "../../shared/hooks/use-update-status";
import { useI18n } from "../../shared/i18n/context";

function useUpdateMessage() {
  const { t } = useI18n();
  const update = useUpdateStatus();

  let msg: string | null = null;
  let color = "text-primary";

  if (!update.checking && update.result) {
    const parts: string[] = [];
    const r = update.result;

    if (r.proxy?.error) {
      parts.push(`Proxy: ${r.proxy.error}`);
      color = "text-red-500";
    } else if (r.proxy?.update_applied) {
      parts.push(t("updateApplied"));
      color = "text-blue-500";
    } else if (r.proxy && r.proxy.commits_behind > 0) {
      parts.push(`Proxy: ${r.proxy.commits_behind} ${t("commits")} ${t("proxyBehind")}`);
      color = "text-amber-500";
    }

    if (r.codex?.error) {
      parts.push(`Codex: ${r.codex.error}`);
      color = "text-red-500";
    } else if (r.codex_update_in_progress) {
      parts.push(t("fingerprintUpdated"));
    }

    msg = parts.length > 0 ? parts.join(" · ") : t("upToDate");
  } else if (!update.checking && update.error) {
    msg = update.error;
    color = "text-red-500";
  }

  return { ...update, msg, color };
}

function Dashboard() {
  const accounts = useAccounts();
  const proxies = useProxies();
  const status = useStatus(accounts.list.length);
  const update = useUpdateMessage();

  const handleProxyChange = async (accountId: string, proxyId: string) => {
    await proxies.assignProxy(accountId, proxyId);
    accounts.refresh();
  };

  return (
    <>
      <Header
        onAddAccount={accounts.startAdd}
        onCheckUpdate={update.checkForUpdate}
        checking={update.checking}
        updateStatusMsg={update.msg}
        updateStatusColor={update.color}
      />
      <main class="flex-grow px-4 md:px-8 lg:px-40 py-8 flex justify-center">
        <div class="flex flex-col w-full max-w-[960px] gap-6">
          <AddAccount
            visible={accounts.addVisible}
            onSubmitRelay={accounts.submitRelay}
            addInfo={accounts.addInfo}
            addError={accounts.addError}
          />
          <AccountList
            accounts={accounts.list}
            loading={accounts.loading}
            onDelete={accounts.deleteAccount}
            onRefresh={accounts.refresh}
            refreshing={accounts.refreshing}
            lastUpdated={accounts.lastUpdated}
            proxies={proxies.proxies}
            onProxyChange={handleProxyChange}
          />
          <ProxyPool proxies={proxies} />
          <ApiConfig
            baseUrl={status.baseUrl}
            apiKey={status.apiKey}
            models={status.models}
            selectedModel={status.selectedModel}
            onModelChange={status.setSelectedModel}
            modelFamilies={status.modelFamilies}
            selectedEffort={status.selectedEffort}
            onEffortChange={status.setSelectedEffort}
          />
          <AnthropicSetup
            apiKey={status.apiKey}
            selectedModel={status.selectedModel}
          />
          <CodeExamples
            baseUrl={status.baseUrl}
            apiKey={status.apiKey}
            model={status.selectedModel}
            reasoningEffort={status.selectedEffort}
          />
        </div>
      </main>
      <Footer updateStatus={update.status} />
    </>
  );
}

export function App() {
  return (
    <I18nProvider>
      <ThemeProvider>
        <Dashboard />
      </ThemeProvider>
    </I18nProvider>
  );
}
