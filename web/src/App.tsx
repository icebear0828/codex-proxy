import { I18nProvider } from "./i18n/context";
import { ThemeProvider } from "./theme/context";
import { Header } from "./components/Header";
import { AccountList } from "./components/AccountList";
import { AddAccount } from "./components/AddAccount";
import { ApiConfig } from "./components/ApiConfig";
import { CodeExamples } from "./components/CodeExamples";
import { Footer } from "./components/Footer";
import { useAccounts } from "./hooks/use-accounts";
import { useStatus } from "./hooks/use-status";

function Dashboard() {
  const accounts = useAccounts();
  const status = useStatus();

  return (
    <>
      <Header onAddAccount={accounts.startAdd} />
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
          />
          <ApiConfig
            baseUrl={status.baseUrl}
            apiKey={status.apiKey}
            models={status.models}
            selectedModel={status.selectedModel}
            onModelChange={status.setSelectedModel}
          />
          <CodeExamples
            baseUrl={status.baseUrl}
            apiKey={status.apiKey}
            model={status.selectedModel}
          />
        </div>
      </main>
      <Footer />
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
