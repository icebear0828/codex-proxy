import { useState, useCallback } from "preact/hooks";
import type { TestConnectionResult } from "../types.js";

export function useTestConnection() {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<TestConnectionResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runTest = useCallback(async () => {
    setTesting(true);
    setError(null);
    setResult(null);
    try {
      const resp = await fetch("/admin/test-connection", { method: "POST" });
      if (!resp.ok) {
        setError(`HTTP ${resp.status}`);
        return;
      }
      const data = (await resp.json()) as TestConnectionResult;
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setTesting(false);
    }
  }, []);

  return { testing, result, error, runTest };
}
