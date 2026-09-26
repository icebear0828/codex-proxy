/**
 * Netlab baseline runner.
 *
 * Boots the full chain (mock upstream → toxiproxy → proxy under test),
 * executes every scenario in scenarios.mjs, and writes a markdown + JSON
 * report under tests/netlab/reports/.
 *
 * Usage:  node tests/netlab/run-baseline.mjs [--keep] [--filter <name>]
 *   --keep     leave the toxiproxy container running afterwards
 *   --filter   run only scenarios whose name contains the substring
 */

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  addToxic, ensureToxiproxy, resetProxyEntry, stopToxiproxy,
  MOCK_PORT,
} from "./lib/toxiproxy.mjs";
import { fetchMockStats, runStreamRequest } from "./lib/client.mjs";
import { PROXY_URL, proxyLogTail, startProxy, stopProxy } from "./lib/runtime.mjs";
import { SCENARIOS } from "./scenarios.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPORTS = path.join(HERE, "reports");

const args = process.argv.slice(2);
const keep = args.includes("--keep");
const filterIdx = args.indexOf("--filter");
const filter = filterIdx !== -1 ? args[filterIdx + 1] : null;

const log = (...a) => console.log(...a);

function spawnMock(env) {
  const child = spawn(process.execPath, [path.join(HERE, "mock-upstream.mjs")], {
    env: { ...process.env, PORT: String(MOCK_PORT), ...env },
    stdio: "ignore",
    windowsHide: true,
  });
  return child;
}

async function waitMockHealthy(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${MOCK_PORT}/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`mock upstream not healthy on :${MOCK_PORT}`);
}

function fmtBytes(n) {
  if (n == null) return "-";
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function summarizeProxyLog(tail) {
  const lines = tail.split("\n").filter((l) =>
    /premature stream close|stream-client-abort|Retrying after|Codex API error|implicit-resume-poison|WebSocket/.test(l));
  return lines.slice(0, 6).map((l) => l.trim().slice(0, 160));
}

async function runScenario(scenario, mockChildRef) {
  // Fresh upstream listener + fresh toxics per scenario.
  if (mockChildRef.current) mockChildRef.current.kill();
  await new Promise((r) => setTimeout(r, 300));
  mockChildRef.current = spawnMock(scenario.mockEnv);
  await waitMockHealthy();
  await resetProxyEntry();
  for (const toxic of scenario.toxics) {
    await addToxic(toxic);
  }
  proxyLogTail(); // flush pre-scenario log

  const startedAt = new Date().toISOString();
  const client = await runStreamRequest({
    timeoutMs: scenario.clientTimeoutMs,
    abortAfterMs: scenario.abortAfterMs ?? null,
  });
  await new Promise((r) => setTimeout(r, 500)); // let mock accounting settle
  const mock = await fetchMockStats().catch(() => null);
  const proxyLog = proxyLogTail();

  // Connection-reclaim acceptance: after cancel/watchdog paths the upstream
  // socket must be dropped, i.e. the mock's live POST /responses count → 0.
  let openConnectionsAfter = mock?.openConnections ?? null;
  if (scenario.expectConnectionReclaim) {
    const deadline = Date.now() + 5000;
    while (openConnectionsAfter !== 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
      openConnectionsAfter = (await fetchMockStats().catch(() => null))?.openConnections ?? null;
    }
  }

  const upstreamWire = mock?.lastRequest?.wireBytes ?? null;
  const upstreamPlain = mock?.lastRequest?.plainBytes ?? null;
  const ratio = upstreamWire && upstreamPlain
    ? (upstreamPlain / upstreamWire)
    : (client.receivedBytes > 0 ? null : null);

  return {
    name: scenario.name,
    title: scenario.title,
    startedAt,
    client,
    upstream: mock?.lastRequest ?? null,
    ratio,
    openConnectionsAfter,
    connectionReclaimed: scenario.expectConnectionReclaim
      ? openConnectionsAfter === 0
      : null,
    proxyLogLines: summarizeProxyLog(proxyLog),
  };
}

function verdictRow(r) {
  const c = r.client;
  let outcome;
  if (c.sawCompleted) outcome = "✅ completed";
  else if (c.clientAborted) outcome = "🛑 client abort(按设计)";
  else if (c.timedOut) outcome = "⏱ client timeout(挂起)";
  else if (c.sawFailed) outcome = `⚠️ failed(${c.failureCode})`;
  else if (c.status && c.status >= 400) outcome = `❌ HTTP ${c.status}`;
  else outcome = `❌ aborted(${c.clientError ?? "stream ended"})`;

  const wire = r.upstream?.gzip
    ? `${fmtBytes(r.upstream?.plainBytes)}→${fmtBytes(r.upstream?.wireBytes)}`
    : fmtBytes(r.upstream?.wireBytes);
  return [
    r.name,
    outcome,
    `ttft ${c.ttftMs != null ? c.ttftMs + "ms" : "-"}`,
    `wall ${(c.wallMs / 1000).toFixed(1)}s`,
    `upstream ${wire}`,
    `client ${fmtBytes(c.receivedBytes)}`,
  ];
}

function renderMarkdown(report) {
  const lines = [];
  lines.push(`# Netlab 基线报告`);
  lines.push("");
  lines.push(`- 生成时间:${report.generatedAt}`);
  lines.push(`- 被测代理:${PROXY_URL}(runtime 隔离实例,wire=codex-responses → native rustls 传输)`);
  lines.push(`- 链路:client → proxy(8188) → toxiproxy(28443) → mock upstream(18443)`);
  lines.push("");
  lines.push("| 场景 | 结果 | TTFT | 总耗时 | 上游腿 | 客户端收到 |");
  lines.push("|---|---|---|---|---|---|");
  for (const r of report.results) {
    if (r.error) {
      lines.push(`| ${r.name} | ❌ runner: ${r.error.slice(0, 60)} | - | - | - | - |`);
      continue;
    }
    const [, outcome, ttft, wall, up, down] = verdictRow(r);
    lines.push(`| ${r.name} | ${outcome} | ${ttft} | ${wall} | ${up} | ${down} |`);
  }
  lines.push("");
  for (const s of SCENARIOS) {
    const r = report.results.find((x) => x.name === s.name);
    lines.push(`## ${s.name} — ${s.title}`);
    lines.push("");
    lines.push(s.documents);
    lines.push("");
    if (!r) {
      lines.push("> 未执行");
      lines.push("");
      continue;
    }
    const c = r.client;
    lines.push("```");
    lines.push(`status            : ${c.status ?? "-"}${c.timedOut ? " (client timeout)" : ""}`);
    lines.push(`completed         : ${c.sawCompleted}`);
    lines.push(`failed            : ${c.sawFailed} code=${c.failureCode ?? "-"} msg=${c.failureMessage ?? ""}`);
    lines.push(`firstByte / ttft  : ${c.firstByteMs ?? "-"}ms / ${c.ttftMs ?? "-"}ms`);
    lines.push(`wall              : ${c.wallMs}ms`);
    lines.push(`client bytes      : ${c.receivedBytes}`);
    lines.push(`upstream plain    : ${r.upstream?.plainBytes ?? "-"}`);
    lines.push(`upstream wire     : ${r.upstream?.wireBytes ?? "-"}${r.upstream?.gzip ? " (gzip)" : ""}`);
    if (r.upstream?.wireBytes) {
      lines.push(`compression ratio : ${(r.upstream.plainBytes / r.upstream.wireBytes).toFixed(2)}x`);
    }
    lines.push(`events            : ${JSON.stringify(c.eventCounts)}`);
    if (c.clientAborted) lines.push(`client abort      : yes (after ${c.wallMs}ms)`);
    if (r.connectionReclaimed != null) {
      lines.push(`open connections  : ${r.openConnectionsAfter} ${r.connectionReclaimed ? "✅ reclaimed" : "❌ LEAKED"}`);
    }
    if (c.clientError) lines.push(`client error      : ${c.clientError}`);
    if (c.httpErrorBody) lines.push(`http error body   : ${c.httpErrorBody}`);
    lines.push("```");
    if (r.proxyLogLines.length) {
      lines.push("");
      lines.push("代理日志摘录:");
      lines.push("```");
      for (const l of r.proxyLogLines) lines.push(l);
      lines.push("```");
    }
    lines.push("");
  }
  return lines.join("\n");
}

// ── main ─────────────────────────────────────────────────────────────

const mockChildRef = { current: null };
const scenarios = filter
  ? SCENARIOS.filter((s) => s.name.includes(filter))
  : SCENARIOS;

try {
  await ensureToxiproxy(console);
  await startProxy(console);
  let currentIdleTimeoutMs; // undefined = production default

  const results = [];
  for (const scenario of scenarios) {
    log(`\n▶ scenario ${scenario.name} …`);
    try {
      // Restart the proxy when the scenario needs a different watchdog
      // budget (e.g. break-stall arms it at 4s instead of the 120s default).
      if ((scenario.streamIdleTimeoutMs ?? null) !== (currentIdleTimeoutMs ?? null)) {
        await stopProxy();
        await startProxy(console, { streamIdleTimeoutMs: scenario.streamIdleTimeoutMs });
        currentIdleTimeoutMs = scenario.streamIdleTimeoutMs ?? null;
      }
      const r = await runScenario(scenario, mockChildRef);
      results.push(r);
      const [name, outcome, ttft, wall, up, down] = verdictRow(r);
      log(`  ${name}: ${outcome} | ${ttft} | ${wall} | ${up} | ${down}`);
    } catch (err) {
      log(`  ${scenario.name} FAILED: ${err.message}`);
      results.push({
        name: scenario.name,
        title: scenario.title,
        startedAt: new Date().toISOString(),
        error: String(err.message ?? err),
        client: { receivedBytes: 0, eventCounts: {}, wallMs: 0 },
        upstream: null,
        proxyLogLines: [],
      });
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    proxyUrl: PROXY_URL,
    results,
  };

  mkdirSync(REPORTS, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/g, "-").slice(0, 19);
  const jsonPath = path.join(REPORTS, `baseline-${stamp}.json`);
  const mdPath = path.join(REPORTS, `baseline-${stamp}.md`);
  writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf8");
  writeFileSync(mdPath, renderMarkdown(report), "utf8");
  log(`\n📄 report: ${mdPath}`);
  log(`📄 raw:    ${jsonPath}`);
} finally {
  mockChildRef.current?.kill();
  await stopProxy();
  if (!keep) await stopToxiproxy();
}
