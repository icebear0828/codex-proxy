/** @vitest-environment jsdom */
import { it, expect, vi, afterEach } from "vitest";
import { renderHook, waitFor, act, cleanup } from "@testing-library/preact";
import { useGeneralSettings } from "../../../shared/hooks/use-general-settings";
import { translations } from "../../../shared/i18n/translations";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("propagates save failure so controls cannot report success", async () => {
  vi.stubGlobal("fetch", vi.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ host: "127.0.0.1" }) })
    .mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({ error: "Set a non-default key" }) }));
  const { result } = renderHook(() => useGeneralSettings(null));
  await waitFor(() => expect(result.current.data).not.toBeNull());
  await act(async () => {
    await expect(result.current.save({ lan_access: true })).rejects.toThrow("Set a non-default key");
  });
  expect(result.current.saved).toBe(false);
  expect(result.current.error).toBe("Set a non-default key");
  expect(result.current.data?.host).toBe("127.0.0.1");
});

it("preserves saved and running states separately after saving", async () => {
  const runtime = { host: "127.0.0.1", port: 49152 };
  vi.stubGlobal("fetch", vi.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ host: "127.0.0.1" }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ host: "0.0.0.0", lan_access: true, lan_runtime: runtime, lan_ipv4_addresses: ["192.168.1.20"], restart_required: true }) }));
  const { result } = renderHook(() => useGeneralSettings(null));
  await waitFor(() => expect(result.current.data).not.toBeNull());
  await act(async () => { await result.current.save({ lan_access: true }); });
  expect(result.current.data).toMatchObject({ host: "0.0.0.0", lan_access: true, lan_runtime: runtime, lan_ipv4_addresses: ["192.168.1.20"] });
  expect(result.current.restartRequired).toBe(true);
});

it("provides every LAN setting translation in every supported language", () => {
  const keys = Object.keys(translations.en).filter(key => key.startsWith("lanAccess"));
  for (const locale of Object.values(translations)) {
    for (const key of keys) expect((locale as Record<string, string>)[key]).toBeTruthy();
  }
});
