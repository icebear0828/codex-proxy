/**
 * Netlab mock Codex upstream — programmable SSE origin for weak-network tests.
 *
 * Zero-dependency node:http server. One instance serves exactly one scenario:
 * the runner spawns it with scenario-specific env vars and reads per-request
 * byte accounting back via GET /__stats after the scenario finishes.
 *
 * Endpoints:
 *   POST /responses          — codex-responses wire: SSE stream (the only path
 *                              CodexResponsesUpstream calls through the native
 *                              rustls transport).
 *   GET  /health             — liveness for the runner.
 *   GET  /__stats            — byte accounting for the last POST.
 *
 * Env knobs (set per scenario by the runner):
 *   PORT                    listen port (bind 0.0.0.0 so Docker can reach it)
 *   MOCK_EVENTS             number of response.output_text.delta events
 *   MOCK_DELTA_BYTES        approx payload bytes per delta event
 *   MOCK_CHUNK_DELAY_MS     delay between events (drip pacing)
 *   MOCK_FIRST_EVENT_DELAY_MS  delay before the first event (slow TTFT)
 *   MOCK_GZIP               "1" → gzip the SSE body with per-event
 *                           Z_SYNC_FLUSH (what a real SSE origin does), and
 *                           set Content-Encoding
 *   MOCK_CUT_AFTER_BYTES    hard-destroy the socket after N wire bytes
 *                           (断传-硬切, works under gzip too)
 *   MOCK_STALL_AFTER_BYTES  stop sending after N wire bytes but hold the
 *                           socket open (断传-静默挂起)
 *   MOCK_FAIL_FIRST_REQUESTS  hard-reset the socket for the first N POST
 *                           /responses requests, then behave normally
 *                           (建流前瞬断 — one-shot connect failure)
 */

import { createServer } from "node:http";
import { createGzip } from "node:zlib";

const PORT = Number(process.env.PORT ?? 18443);
const EVENTS = Number(process.env.MOCK_EVENTS ?? 120);
const DELTA_BYTES = Number(process.env.MOCK_DELTA_BYTES ?? 512);
const CHUNK_DELAY_MS = Number(process.env.MOCK_CHUNK_DELAY_MS ?? 0);
const FIRST_EVENT_DELAY_MS = Number(process.env.MOCK_FIRST_EVENT_DELAY_MS ?? 0);
const GZIP = process.env.MOCK_GZIP === "1";
const CUT_AFTER_BYTES = Number(process.env.MOCK_CUT_AFTER_BYTES ?? 0);
const STALL_AFTER_BYTES = Number(process.env.MOCK_STALL_AFTER_BYTES ?? 0);
const FAIL_FIRST_REQUESTS = Number(process.env.MOCK_FAIL_FIRST_REQUESTS ?? 0);
let failRequestsRemaining = FAIL_FIRST_REQUESTS;

// Natural-ish English text — gzip ratio lands in a realistic 3-5x band for
// LLM-style output, keeping relative comparisons honest without randomness.
const WORDS = ("the quick brown fox jumps over a lazy dog while models stream "
  + "tokens through proxies and weak networks drop packets between hops ").split(" ");

let seq = 0;
const stats = {
  lastRequest: null, // { wireBytes, plainBytes, events, aborted, completed, gzip }
  requests: 0,
  aborted: 0,
  completed: 0,
  openConnections: 0, // live POST /responses sockets (0 = all reclaimed)
};

function deltaText(n) {
  // Deterministic pseudo-text of ~DELTA_BYTES bytes.
  const words = Math.ceil(DELTA_BYTES / 6);
  let out = "";
  for (let i = 0; i < words; i++) {
    out += WORDS[(n * 7 + i) % WORDS.length] + " ";
  }
  return out.slice(0, DELTA_BYTES);
}

function sseEvent(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function buildParts(requestId) {
  const parts = [
    sseEvent("response.created", {
      type: "response.created",
      response: { id: requestId, status: "in_progress" },
    }),
    sseEvent("response.in_progress", {
      type: "response.in_progress",
      response: { id: requestId, status: "in_progress" },
    }),
  ];
  for (let i = 0; i < EVENTS; i++) {
    parts.push(sseEvent("response.output_text.delta", {
      type: "response.output_text.delta",
      delta: deltaText(i),
    }));
  }
  parts.push(sseEvent("response.completed", {
    type: "response.completed",
    response: {
      id: requestId,
      status: "completed",
      usage: { input_tokens: 1024, output_tokens: EVENTS * 128 },
    },
  }));
  return parts;
}

const server = createServer((req, res) => {
  // When reqwest is configured with an HTTP proxy (the netlab pins
  // tls.proxy_url at the toxiproxy listener), plain-HTTP targets arrive in
  // absolute-form: "POST http://mock-upstream.test:9999/responses".
  // Strip the scheme+host so routing matches, and never actually dial it.
  const url = (req.url ?? "").replace(/^https?:\/\/[^/]+/i, "") || "/";

  if (req.method === "GET" && url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, gzip: GZIP }));
    return;
  }

  if (req.method === "GET" && url === "/__stats") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(stats));
    return;
  }

  if (req.method !== "POST" || !url.startsWith("/responses")) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: `no route ${req.method} ${url}` } }));
    return;
  }

  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("error", () => { /* client vanished mid-request */ });
  req.on("end", () => {
    void chunks;

    if (failRequestsRemaining > 0) {
      // One-shot connect failure: reset before any response bytes. Counted
      // as an aborted request so the runner sees it in stats.
      failRequestsRemaining -= 1;
      stats.requests += 1;
      stats.lastRequest = {
        wireBytes: 0, plainBytes: 0, events: 0,
        aborted: true, completed: false, gzip: GZIP,
      };
      res.destroy();
      return;
    }

    seq += 1;
    const requestId = `resp_netlab_${String(seq).padStart(5, "0")}`;
    const parts = buildParts(requestId);

    const perRequest = {
      wireBytes: 0,
      plainBytes: parts.reduce((n, p) => n + Buffer.byteLength(p), 0),
      events: parts.length,
      aborted: false,
      completed: false,
      gzip: GZIP,
    };
    stats.lastRequest = perRequest;
    stats.requests += 1;

    res.on("close", () => {
      if (!perRequest.completed) {
        perRequest.aborted = true;
        stats.aborted += 1;
      }
    });

    const headers = {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    };
    if (GZIP) headers["content-encoding"] = "gzip";
    res.writeHead(200, headers);

    // Count each streaming socket once (keep-alive reuse shares one socket);
    // the runner asserts this returns to 0 after cancellation/watchdog paths.
    const sock = res.socket;
    if (sock && !sock.__netlabCounted) {
      sock.__netlabCounted = true;
      stats.openConnections += 1;
      sock.on("close", () => { stats.openConnections -= 1; });
    }

    const bufs = parts.map((p) => Buffer.from(p, "utf8"));
    let i = 0;
    let stopped = false;

    // Cut/stall thresholds compare WIRE bytes so gzip scenarios cut at the
    // same fraction of the transfer, not of the plaintext.
    const maybeCut = () => {
      const sent = perRequest.wireBytes;
      if (CUT_AFTER_BYTES > 0 && sent >= CUT_AFTER_BYTES) {
        res.destroy(); // hard reset mid-stream — no clean FIN framing
        return true;
      }
      if (STALL_AFTER_BYTES > 0 && sent >= STALL_AFTER_BYTES) {
        stopped = true; // hold the socket open, send nothing further
        return true;
      }
      return false;
    };

    const pace = (step) => {
      if (CHUNK_DELAY_MS > 0) setTimeout(step, CHUNK_DELAY_MS).unref?.();
      else setImmediate(step);
    };

    if (GZIP) {
      const gz = createGzip();
      gz.on("data", (b) => { perRequest.wireBytes += b.length; res.write(b); });
      gz.on("end", () => {
        perRequest.completed = true;
        stats.completed += 1;
        res.end();
      });
      const step = () => {
        if (stopped || res.destroyed) return;
        if (i >= bufs.length) { gz.end(); return; }
        if (i === 0 && FIRST_EVENT_DELAY_MS > 0) {
          setTimeout(step, FIRST_EVENT_DELAY_MS).unref?.();
          return;
        }
        gz.write(bufs[i++]);
        gz.flush(() => {
          if (res.destroyed || maybeCut()) return;
          pace(step);
        });
      };
      step();
      return;
    }

    const step = () => {
      if (stopped || res.destroyed) return;
      if (i >= bufs.length) {
        perRequest.completed = true;
        stats.completed += 1;
        res.end();
        return;
      }
      if (i === 0 && FIRST_EVENT_DELAY_MS > 0) {
        setTimeout(step, FIRST_EVENT_DELAY_MS).unref?.();
        return;
      }
      const chunk = bufs[i++];
      perRequest.wireBytes += chunk.length;
      res.write(chunk, () => {
        if (res.destroyed || maybeCut()) return;
        pace(step);
      });
    };
    step();
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[mock-upstream] listening on 0.0.0.0:${PORT} gzip=${GZIP} events=${EVENTS}`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
