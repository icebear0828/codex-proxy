/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { AddKeyForm } from "./ApiKeyManager";
import type { ApiKeyCapability, ApiKeyProvider, ApiKeyWire, CatalogModel } from "../../../shared/hooks/use-api-keys";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function createOnAdd() {
  return vi.fn(async (_input: {
    provider: ApiKeyProvider;
    models: string[];
    apiKey: string;
    baseUrl?: string;
    label?: string;
    capabilities?: ApiKeyCapability[];
    wire?: ApiKeyWire;
  }) => ({ ok: true }));
}

function createFetchProviderModels(models: CatalogModel[] = []) {
  return vi.fn(async (_input: { provider: ApiKeyProvider; apiKey: string; baseUrl?: string }) => ({
    ok: true as const,
    models,
  }));
}

const defaultCatalog = {
  anthropic: { displayName: "Anthropic", defaultBaseUrl: "https://api.anthropic.com/v1", models: [] },
  openai: { displayName: "OpenAI", defaultBaseUrl: "https://api.openai.com/v1", models: [] },
  gemini: { displayName: "Google Gemini", defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta", models: [] },
  openrouter: { displayName: "OpenRouter", defaultBaseUrl: "https://openrouter.ai/api/v1", models: [] },
};

describe("AddKeyForm", () => {
  it("submits manual embedding models with embeddings capability", async () => {
    const onAdd = createOnAdd();
    const fetchProviderModels = createFetchProviderModels();

    render(
      <AddKeyForm
        onAdd={onAdd}
        catalog={defaultCatalog}
        fetchProviderModels={fetchProviderModels}
      />,
    );

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "openai" } });
    fireEvent.input(screen.getByPlaceholderText("sk-..."), { target: { value: "sk-test" } });
    fireEvent.input(screen.getByPlaceholderText("manual-model-1, manual-model-2"), {
      target: { value: "text-embedding-3-small" },
    });
    fireEvent.click(screen.getByLabelText("Chat"));
    fireEvent.click(screen.getByLabelText("Embeddings"));
    fireEvent.click(screen.getByText("Add Key"));

    await waitFor(() => expect(onAdd).toHaveBeenCalledTimes(1));
    expect(onAdd).toHaveBeenCalledWith({
      provider: "openai",
      models: ["text-embedding-3-small"],
      apiKey: "sk-test",
      baseUrl: undefined,
      label: undefined,
      capabilities: ["embeddings"],
      wire: "chat",
    });
  });

  it("submits wire=responses when the Responses API protocol is chosen for OpenAI-family", async () => {
    const onAdd = createOnAdd();
    const fetchProviderModels = createFetchProviderModels();

    render(
      <AddKeyForm
        onAdd={onAdd}
        catalog={defaultCatalog}
        fetchProviderModels={fetchProviderModels}
      />,
    );

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "openai" } });
    fireEvent.input(screen.getByPlaceholderText("sk-..."), { target: { value: "sk-test" } });
    fireEvent.input(screen.getByPlaceholderText("manual-model-1, manual-model-2"), {
      target: { value: "gpt-5.5" },
    });
    const wireSelect = screen.getByDisplayValue("Chat Completions (default)");
    fireEvent.change(wireSelect, { target: { value: "responses" } });
    fireEvent.click(screen.getByText("Add Key"));

    await waitFor(() => expect(onAdd).toHaveBeenCalledTimes(1));
    expect(onAdd.mock.calls[0][0].wire).toBe("responses");
  });

  it("does not render the wire selector for anthropic", () => {
    const onAdd = createOnAdd();
    const fetchProviderModels = createFetchProviderModels();

    render(
      <AddKeyForm
        onAdd={onAdd}
        catalog={defaultCatalog}
        fetchProviderModels={fetchProviderModels}
      />,
    );

    expect(screen.queryByText("Upstream protocol")).toBeNull();
  });

  it("fetches built-in provider models after API key blur", async () => {
    const onAdd = createOnAdd();
    const fetchProviderModels = createFetchProviderModels([{ id: "gpt-test", displayName: "GPT Test" }]);

    render(
      <AddKeyForm
        onAdd={onAdd}
        catalog={defaultCatalog}
        fetchProviderModels={fetchProviderModels}
      />,
    );

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "openai" } });
    fireEvent.input(screen.getByPlaceholderText("sk-..."), { target: { value: "sk-test" } });
    fireEvent.blur(screen.getByPlaceholderText("sk-..."));

    await waitFor(() => expect(screen.getByText("GPT Test")).toBeTruthy());
    expect(fetchProviderModels).toHaveBeenCalledWith({ provider: "openai", apiKey: "sk-test", baseUrl: undefined });
  });

  it("submits a selected dynamically fetched built-in model", async () => {
    const onAdd = createOnAdd();
    const fetchProviderModels = createFetchProviderModels([{ id: "gpt-test", displayName: "GPT Test" }]);

    render(
      <AddKeyForm
        onAdd={onAdd}
        catalog={defaultCatalog}
        fetchProviderModels={fetchProviderModels}
      />,
    );

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "openai" } });
    fireEvent.input(screen.getByPlaceholderText("sk-..."), { target: { value: "sk-test" } });
    fireEvent.blur(screen.getByPlaceholderText("sk-..."));
    await waitFor(() => expect(screen.getByText("GPT Test")).toBeTruthy());
    fireEvent.click(screen.getByText("Add Key"));

    await waitFor(() => expect(onAdd).toHaveBeenCalledTimes(1));
    expect(onAdd.mock.calls[0][0].models).toEqual(["gpt-test"]);
  });

  it("shows manual fallback when built-in model fetch fails", async () => {
    const onAdd = createOnAdd();
    const fetchProviderModels = vi.fn(async () => ({ ok: false as const, error: "Failed" }));

    render(
      <AddKeyForm
        onAdd={onAdd}
        catalog={defaultCatalog}
        fetchProviderModels={fetchProviderModels}
      />,
    );

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "openai" } });
    fireEvent.input(screen.getByPlaceholderText("sk-..."), { target: { value: "sk-test" } });
    fireEvent.blur(screen.getByPlaceholderText("sk-..."));

    await waitFor(() => expect(screen.getByPlaceholderText("model-name-1, model-name-2")).toBeTruthy());
    expect(screen.getByText("模型列表获取失败，请手动输入模型名：Failed")).toBeTruthy();
  });

  it("fetches custom provider models with base URL", async () => {
    const onAdd = createOnAdd();
    const fetchProviderModels = createFetchProviderModels([{ id: "custom-model", displayName: "Custom Model" }]);

    render(
      <AddKeyForm
        onAdd={onAdd}
        catalog={defaultCatalog}
        fetchProviderModels={fetchProviderModels}
      />,
    );

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "custom" } });
    fireEvent.input(screen.getByPlaceholderText("sk-..."), { target: { value: "custom-key" } });
    fireEvent.input(screen.getByPlaceholderText("https://api.example.com/v1"), { target: { value: "https://api.example.com/v1" } });
    fireEvent.blur(screen.getByPlaceholderText("https://api.example.com/v1"));

    await waitFor(() => expect(screen.getByText("Custom Model")).toBeTruthy());
    expect(fetchProviderModels).toHaveBeenCalledWith({
      provider: "custom",
      apiKey: "custom-key",
      baseUrl: "https://api.example.com/v1",
    });
  });
});
