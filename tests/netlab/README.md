# Netlab — 弱网与流量压缩测试环境

隔离的传输层测试环境:在真实代理进程与本机 mock 上游之间注入网络损伤
(延迟/限速/断流/挂起),度量压缩率、TTFT、断传暴露时间,驱动
"流量压缩 + 弱网稳定性"优化的 TDD 闭环。

不消耗真实配额、不触碰 Cloudflare、完全可重复。

## 链路

```
测试客户端(lib/client.mjs)
   → codex-proxy 被测实例(127.0.0.1:8188, 隔离 runtime)
      ↑ tls.proxy_url 显式钉在注入点(禁用本地代理自动探测)
   → toxiproxy(127.0.0.1:28443, HTTP 代理语义 / absolute-form)
   → mock 上游(127.0.0.1:18443, 可编程 SSE 源)
```

被测 wire 是 `codex-responses`(CodexResponsesUpstream → native rustls 传输
→ 指纹头),与账号/生产路径共用同一传输层。runtime 目录由 runner 生成:

```
tests/netlab/runtime/
  config/   ← 仓库 config 副本(fingerprint.yaml 含上游 Accept-Encoding)
  data/     ← local.yaml(端口+key)、api-keys.json(netlab-mock 条目)、proxy.log
  native/   ← junction 到仓库 native/(rustls addon)
```

## 用法

```bash
npm run netlab:baseline              # 全部场景 + markdown/JSON 报告
node tests/netlab/run-baseline.mjs --filter break-    # 只跑断传场景
node tests/netlab/run-baseline.mjs --keep            # 保留 toxiproxy 进程
NETLAB_TOXIPROXY=docker node …       # 容器模式(需要 Docker Desktop 的
                                     # host.docker.internal;WSL2 引擎用 binary)
```

toxiproxy 默认以原生二进制运行(host loopback,无容器网络依赖);
首次运行自动下载到 `tests/netlab/.bin/`。报告输出到 `tests/netlab/reports/`。

## 场景(scenarios.mjs)

| 场景 | 注入 | 度量目标 |
|---|---|---|
| baseline-plain | 无 | 明文字节基准(压缩对照) |
| baseline-gzip | mock 开 gzip | 上游腿压缩率 + 解压正确性 |
| baseline-gzip-large | 大负载 gzip | 大 JSON 场景压缩率 |
| break-prestream-persistent | reset_peer toxic 持续存在 | 有限重试后干净报错(status-0 重试,不无限循环) |
| break-midstream | mock 硬切 @25KB | 流中断开 → stream_disconnected 暴露延迟 |
| break-stall | mock 静默挂起 | 流空闲看门狗(`streamIdleTimeoutMs` 场景级覆写,默认 4s 预算)→ 半开连接提前暴露 + 连接回收 |
| cancel-client-abort | 客户端 ~20% 处主动 abort | abort 传播到原生层 `httpCancel` → 上游请求被终止(mock `aborted:true`)+ 连接回收 |
| weaknet-slow | latency+bandwidth+slicer | 弱网 TTFT/吞吐 + 心跳有效性 |

每个场景声明 `documents` 字段:区分"符合当前设计"与"已知待优化缺口"。
新增场景 = scenarios.mjs 加一条(mock env + toxics + 验收描述)。场景可选
`streamIdleTimeoutMs` 字段会重启代理并写入 runtime local.yaml,用于验收
上游流空闲看门狗(`tls.stream_idle_timeout_ms`,生产默认 120s,0 关闭,
同时覆盖预 header 挂起阶段)。场景设 `abortAfterMs` 后客户端中途主动断开;
设 `expectConnectionReclaim: true` 时 runner 轮询 mock 的 `openConnections`
统计直到归零(5s 上限),报告标注 `✅ reclaimed` / `❌ LEAKED`——这是
"取消必须回收上游连接"的原生层验收。

## 开发循环

1. `npm run netlab:baseline` → 拿基线报告
2. 改代理代码(src/)
3. 重跑相关场景(--filter)→ 对比报告,验收标准见场景 `documents`
4. 全量回归

注意:跑 netlab 时若本机开着 Clash/v2ray 也不受影响——`tls.proxy_url`
已显式钉住注入点,自动探测被跳过;但不要在 netlab 运行期间手动改
runtime 的 local.yaml(runner 每次重建 runtime 目录)。
