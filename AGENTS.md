## 多 Agent 工作流

- 仅在用户明确授权或任务明确要求时启用；完整规则见 `docs/MULTI_AGENT_WORKFLOW.md`。
- 默认在满足最低安全和验收要求的前提下，优先减少总 token、credits、费用与重复阅读。
- 开工前按语义难度、修改范围、可验证性、失败后果和上下文负担预分类。
- 使用预计可完成任务的最低成本执行体；高性能执行体只用于关键推理、弱机械验收或高后果节点。
- 简单任务不为使用多 Agent 增加调度成本；并行优先用于互不重叠的只读工作。
- 同一工作树和合同域保持单写者；Reviewer/Verifier 默认只读。
- 子 Agent 使用最小上下文、稳定公共前缀与增量证据，避免完整历史复制和重复读取。
- 多 Agent 授权不扩大网络、真实 API、外部写入、提交、发布或破坏性操作权限。
- 达到当前任务验收或停止条件后立即停止，不自动进入下一票据。

## Gemini / Antigravity Schema 与日志

- Gemini / Antigravity 的工具参数及结构化输出 schema 必须按 Gemini 支持的字段白名单清洗；清除 `prefixItems` 等不支持字段后，如果 schema 仍为 `type: array` 且缺少 `items`，需补宽松的 `{}` schema，避免 Gemini 的 `missing field` 校验错误。为此类变换补充嵌套 schema 回归测试。
- 持久化请求/错误诊断时，必须先脱敏并限制单条记录和文件大小；不要提交临时的原始 tools / request dump，也不要记录凭据。

## PR 合并后的自动同步

- PR 合并到 `dev` 后，默认自动同步主工作目录的本地 `dev`，无需再次询问用户；执行前确认当前分支为 `dev` 且工作区干净，然后运行 `git pull --ff-only origin dev`。
- 若主工作目录不在 `dev`、有未提交改动或无法快进，停止自动拉取并说明原因；不得擅自切换分支、stash、reset、覆盖改动或创建合并提交。不得改动其他任务的工作树。
- 同步成功后核对本地 `dev` 与 `origin/dev` 的提交是否一致，并在完成报告中说明同步结果。

## Keepalive safety

- Account keepalive is disabled by default. Enabling the scheduler or calling `POST /admin/keepalive-run` sends real requests to `/codex/usage`; unit tests must mock `CodexApi`, and real-account execution requires explicit user authorization.
