/**
 * Baseline scenario definitions for the netlab.
 *
 * Each scenario = mock upstream env + toxiproxy toxics + a client timeout.
 * `documents` states the currently-expected behavior so the baseline report
 * can distinguish "works as designed" from "known gap to fix".
 */

export const SCENARIOS = [
  {
    name: "baseline-plain",
    title: "基线:明文 SSE(压缩对照)",
    documents: "代理↔上游明文传输的基准字节/TTFT。后续压缩优化的对照组。",
    mockEnv: { MOCK_EVENTS: 120, MOCK_DELTA_BYTES: 512 },
    toxics: [],
    clientTimeoutMs: 20_000,
  },
  {
    name: "baseline-gzip",
    title: "上游 gzip(协商压缩,小负载)",
    documents: "上游按 Accept-Encoding 返回 gzip,reqwest 透明解压。"
      + "验证:客户端事件流与明文一致(解压正确),并测量上游腿节省比例。",
    mockEnv: { MOCK_EVENTS: 120, MOCK_DELTA_BYTES: 512, MOCK_GZIP: "1" },
    toxics: [],
    clientTimeoutMs: 20_000,
  },
  {
    name: "baseline-gzip-large",
    title: "上游 gzip(大负载 ~460KB)",
    documents: "大响应下的压缩率,对齐 collectPassthrough 大 JSON 场景。",
    mockEnv: { MOCK_EVENTS: 400, MOCK_DELTA_BYTES: 1024, MOCK_GZIP: "1" },
    toxics: [],
    clientTimeoutMs: 30_000,
  },
  {
    name: "break-prestream-transient",
    title: "断传-建流前瞬断(第1次请求被重置)",
    documents: "第 1 次 POST 被 mock 硬重置,第 2 次起正常。"
      + "修复前:代理直接报 upstream_transport_error,无重试。"
      + "验收(修复后):代理自动重试并成功,客户端拿到完整流。",
    mockEnv: { MOCK_EVENTS: 120, MOCK_DELTA_BYTES: 512, MOCK_FAIL_FIRST_REQUESTS: "1" },
    toxics: [],
    clientTimeoutMs: 20_000,
  },
  {
    name: "break-prestream-persistent",
    title: "断传-建流前连接持续被重置",
    documents: "reset_peer toxic 持续存在,重试也会失败。"
      + "验收:有限重试后干净报错(不无限循环、不挂起)。",
    mockEnv: { MOCK_EVENTS: 120, MOCK_DELTA_BYTES: 512 },
    toxics: [{ name: "prestream-reset", type: "reset_peer", stream: "downstream", toxicity: 1.0, attributes: { timeout: 1 } }],
    clientTimeoutMs: 30_000,
  },
  {
    name: "break-midstream",
    title: "断传-流中硬切(~40% 处 RST)",
    documents: "上游中途断开。当前预期:客户端收到合成 response.failed"
      + "(stream_disconnected),无流内续传。度量:暴露延迟。",
    mockEnv: { MOCK_EVENTS: 120, MOCK_DELTA_BYTES: 512, MOCK_CUT_AFTER_BYTES: "25000" },
    toxics: [],
    clientTimeoutMs: 20_000,
  },
  {
    name: "break-stall",
    title: "断传-流中静默挂起(半开连接)",
    documents: "上游停止发数据但不断开(半开连接)。修复前:无看门狗,挂到客户端 20s 超时。"
      + "验收(修复后):代理侧 4s 看门狗触发,客户端提前收到 stream_disconnected,"
      + "且看门狗 httpCancel 终止上游请求 → 连接被回收(openConnections 归零)。",
    mockEnv: { MOCK_EVENTS: 120, MOCK_DELTA_BYTES: 512, MOCK_STALL_AFTER_BYTES: "25000" },
    toxics: [],
    clientTimeoutMs: 20_000,
    streamIdleTimeoutMs: 4000,
    expectConnectionReclaim: true,
  },
  {
    name: "cancel-client-abort",
    title: "客户端中途取消(abort 传播)",
    documents: "客户端收到约 20% 后主动 abort。修复前:上游连接未被取消,"
      + "mock 侧会把整条流读完(completed),上游算力/流量白白消耗。"
      + "验收(修复后):abort 传播到原生层 httpCancel → mock 看到 aborted=true,"
      + "连接数归零(上游请求被终止)。",
    mockEnv: { MOCK_EVENTS: 400, MOCK_DELTA_BYTES: 512, MOCK_CHUNK_DELAY_MS: "15" },
    toxics: [],
    clientTimeoutMs: 30_000,
    abortAfterMs: 1500,
    expectConnectionReclaim: true,
  },
  {
    name: "weaknet-slow",
    title: "弱网:高延迟+限速+分块",
    documents: "latency 300ms±100 + 下行 128KB/s + slicer 分块。"
      + "度量弱网下 TTFT 与吞吐劣化,以及 15s 心跳是否保住连接。",
    mockEnv: { MOCK_EVENTS: 120, MOCK_DELTA_BYTES: 512, MOCK_CHUNK_DELAY_MS: "15" },
    toxics: [
      { name: "latency-up", type: "latency", stream: "upstream", toxicity: 1.0, attributes: { latency: 300, jitter: 100 } },
      { name: "latency-down", type: "latency", stream: "downstream", toxicity: 1.0, attributes: { latency: 300, jitter: 100 } },
      { name: "bandwidth-down", type: "bandwidth", stream: "downstream", toxicity: 1.0, attributes: { rate: 128 } },
      { name: "slicer-down", type: "slicer", stream: "downstream", toxicity: 1.0, attributes: { average_size: 256, delay: 20, size_variation: 64 } },
    ],
    clientTimeoutMs: 60_000,
  },
];
