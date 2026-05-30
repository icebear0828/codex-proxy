/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { AddKeyForm } from "./ApiKeyManager";
import type { ApiKeyCapability, ApiKeyProvider, CatalogModel } from "../../../shared/hooks/use-api-keys";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AddKeyForm", () => {
  const renderAddKeyForm = (onAdd = vi.fn(async (_input: {
    provider: ApiKeyProvider;
    models: string[];
    apiKey: string;
    baseUrl?: string;
    label?: string;
    capabilities?: ApiKeyCapability[];
    format?: "openai";
  }) => ({ ok: true }))) => {
    const fetchCustomModels = vi.fn(async (_input: { provider: "custom"; apiKey: string; baseUrl: string }) => ({
      ok: true as const,
      models: [] as CatalogModel[],
    }));

    render(
      <AddKeyForm
        onAdd={onAdd}
        catalog={{
          anthropic: { displayName: "Anthropic", defaultBaseUrl: "https://api.anthropic.com/v1", models: [] },
          openai: { displayName: "OpenAI", defaultBaseUrl: "https://api.openai.com/v1", models: [] },
        }}
        fetchCustomModels={fetchCustomModels}
      />,
    );

    return { onAdd, fetchCustomModels };
  };

  it("submits manual embedding models with embeddings capability", async () => {
    const { onAdd } = renderAddKeyForm();

    fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "openai" } });
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
      format: "openai",
    });
  });

  it("shows the disabled OpenAI format selector", () => {
    renderAddKeyForm();

    const formatSelector = screen.getByLabelText("API Key Format") as HTMLSelectElement;
    expect(formatSelector.disabled).toBe(true);
    expect(formatSelector.value).toBe("openai");
    expect(screen.getByText("Only OpenAI-compatible API key format is available now. More formats will be supported later.")).toBeTruthy();
  });
});
