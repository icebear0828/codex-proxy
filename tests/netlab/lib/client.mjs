/**
 * Netlab SSE test client — drives one request through the proxy under test
 * and records the metrics the baseline report is built from.
 *
 * Wire bytes here are the PROXY→CLIENT leg. The MOCK→PROXY leg comes from
 * the mock's /__stats endpoint; the report compares both.
 */

import { PROXY_API_KEY, PROXY_URL, NETLAB_MODEL } from "./runtime.mjs";

/**
 * Run one streaming request.
 *
 * @param {object} opts
 * @param {number} [opts.timeoutMs]     hard wall-clock cap (default 30s)
 * @param {number} [opts.abortAfterMs]  client aborts mid-stream after this
 *                                      much wall time (cancel propagation test)
 * @param {string} [opts.input]         user input text
 * @returns metrics object
 */
export async function runStreamRequest({
  timeoutMs = 30_000,
  abortAfterMs = null,
  input = "Say something long enough to exercise the stream.",
} = {}) {
  const started = Date.now();
  const m = {
    ok: false,
    status: null,
    firstByteMs: null,
    ttftMs: null,          // first real (non-heartbeat) content chunk
    receivedBytes: 0,      // proxy → client wire bytes
    eventCounts: {},       // by SSE event type
    sawCompleted: false,
    sawFailed: false,
    failureCode: null,
    failureMessage: null,
    httpErrorBody: null,
    wallMs: null,
    timedOut: false,
    clientAborted: false,
    clientError: null,
  };

  const abort = new AbortController();
  const timer = setTimeout(() => {
    m.timedOut = true;
    abort.abort();
  }, timeoutMs);

  try {
    const res = await fetch(`${PROXY_URL}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${PROXY_API_KEY}`,
      },
      body: JSON.stringify({
        model: NETLAB_MODEL,
        stream: true,
        input: [{ role: "user", type: "message", content: input }],
      }),
      signal: abort.signal,
    });
    m.status = res.status;

    if (!res.ok || !res.body) {
      m.httpErrorBody = (await res.text().catch(() => "")).slice(0, 400);
      return m;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const noteEvent = (type) => {
      m.eventCounts[type] = (m.eventCounts[type] ?? 0) + 1;
      if (type === "response.completed") m.sawCompleted = true;
      if (type === "response.failed" || type === "error") m.sawFailed = true;
    };

    const handleChunk = (text) => {
      buffer += text;
      let idx;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        let type = null;
        let data = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("event: ")) type = line.slice(7).trim();
          else if (line.startsWith("data: ")) data += line.slice(6);
        }
        if (!type) continue; // heartbeat comment / malformed
        noteEvent(type);
        if (m.sawFailed && !m.failureCode && data) {
          try {
            const parsed = JSON.parse(data);
            const err = parsed.error ?? parsed.response?.error ?? {};
            m.failureCode = err.code ?? type;
            m.failureMessage = (err.message ?? "").slice(0, 200);
          } catch {
            m.failureCode = type;
          }
        }
      }
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const now = Date.now();
      const text = decoder.decode(value, { stream: true });
      m.receivedBytes += value.byteLength;
      if (m.firstByteMs === null) m.firstByteMs = now - started;
      if (m.ttftMs === null && text.trim() && !text.startsWith(":")) {
        m.ttftMs = now - started;
      }
      handleChunk(text);
      if (abortAfterMs !== null && now - started >= abortAfterMs) {
        // Deliberate client abort — drop the connection mid-stream.
        m.clientAborted = true;
        reader.cancel().catch(() => {});
        abort.abort();
        break;
      }
      if (m.sawCompleted || (m.sawFailed && m.failureCode)) break;
    }
    m.ok = m.sawCompleted;
    return m;
  } catch (err) {
    if (m.timedOut) {
      // A timeout IS the finding for the stall scenario — keep metrics.
      m.clientError = `timed out after ${timeoutMs}ms`;
      m.wallMs = Date.now() - started;
      return m;
    }
    m.clientError = String(err?.cause?.code ?? err?.message ?? err).slice(0, 200);
    return m;
  } finally {
    clearTimeout(timer);
    m.wallMs = m.wallMs ?? Date.now() - started;
  }
}

/** Fetch the mock's accounting for the request the proxy just proxied. */
export async function fetchMockStats(mockPort = 18443) {
  const res = await fetch(`http://127.0.0.1:${mockPort}/__stats`, {
    signal: AbortSignal.timeout(3000),
  });
  return res.json();
}
