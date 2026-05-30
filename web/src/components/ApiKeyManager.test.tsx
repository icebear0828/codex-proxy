/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { AddKeyForm } from "./ApiKeyManager";
import type { ApiKeyCapability, ApiKeyProvider, ApiKeyWire, CatalogModel } from "../../../shared/hooks/use-api-keys";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AddKeyForm", () => {
  it("submits manual embedding models with embeddings capability", async () => {
    const onAdd = vi.fn(async (_input: {
      provider: ApiKeyProvider;
      models: string[];
      apiKey: string;
      baseUrl?: string;
      label?: string;
      capabilities?: ApiKeyCapability[];
      wire?: ApiKeyWire;
    }) => ({ ok: true }));
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
    const onAdd = vi.fn(async (_input: {
      provider: ApiKeyProvider;
      models: string[];
      apiKey: string;
      baseUrl?: string;
      label?: string;
      capabilities?: ApiKeyCapability[];
      wire?: ApiKeyWire;
    }) => ({ ok: true }));
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

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "openai" } });
    fireEvent.input(screen.getByPlaceholderText("sk-..."), { target: { value: "sk-test" } });
    fireEvent.input(screen.getByPlaceholderText("manual-model-1, manual-model-2"), {
      target: { value: "gpt-5.5" },
    });
    // The wire selector only appears for OpenAI-family providers.
    const wireSelect = screen.getByDisplayValue("Chat Completions (default)");
    fireEvent.change(wireSelect, { target: { value: "responses" } });
    fireEvent.click(screen.getByText("Add Key"));

    await waitFor(() => expect(onAdd).toHaveBeenCalledTimes(1));
    expect(onAdd.mock.calls[0][0].wire).toBe("responses");
  });

  it("does not render the wire selector for anthropic", () => {
    const onAdd = vi.fn(async () => ({ ok: true }));
    const fetchCustomModels = vi.fn(async (_input: { provider: "custom"; apiKey: string; baseUrl: string }) => ({
      ok: true as const,
      models: [] as CatalogModel[],
    }));

    render(
      <AddKeyForm
        onAdd={onAdd}
        catalog={{
          anthropic: { displayName: "Anthropic", defaultBaseUrl: "https://api.anthropic.com/v1", models: [] },
        }}
        fetchCustomModels={fetchCustomModels}
      />,
    );

    // Default provider is anthropic → no upstream-protocol selector.
    expect(screen.queryByText("Upstream protocol")).toBeNull();
  });
});
