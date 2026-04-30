# CHANGELOG Format

Codex-proxy follows [Keep a Changelog](https://keepachangelog.com/). Every PR that changes user-visible behavior, public API, configuration, or build/release infrastructure MUST add an entry to `CHANGELOG.md` under `## [Unreleased]`.

## Section Layout

`## [Unreleased]` contains exactly these subsections (in this order, omit empty ones):

```markdown
## [Unreleased]

### Changed

- ...

### Added

- ...

### Fixed

- ...
```

| Subsection | Use for |
|---|---|
| `### Added` | New features, new endpoints, new config keys, new CLI flags |
| `### Changed` | Behavior change of existing features, default value changes, signature changes |
| `### Fixed` | Bug fixes |
| `### Removed` | Deleted features (rare; gate behind a deprecation cycle first) |
| `### Deprecated` | Marking something for future removal |
| `### Security` | Security-relevant fix (CVE, cred leak, etc.) |

## Entry Style

- Use the same language as the existing `[Unreleased]` entries (zh-CN at time of writing). If the file flips to English, follow.
- Lead with the user-visible impact, then mention the file paths in parentheses for reviewer navigation.
- Reference issues / PRs with `(#NNN)` inline.
- Multi-aspect entries get nested bullets.

## Examples (from current `[Unreleased]`)

```markdown
### Added

- 图像生成请求计数（成功 / 失败分流）：`AccountUsage` 新增 `image_request_count` / `image_request_failed_count`...
- Dashboard 用量统计新增「缓存命中率」卡片...
```

```markdown
### Changed

- `bump-electron-beta.yml` 触发改为定时 cron（每天 04:00 / 12:00 UTC）...
```

## When NOT to add a CHANGELOG entry

Skip CHANGELOG for commits that are:

- Test-only (`test:` prefix) — no user impact
- Doc-only edits to internal docs (`CLAUDE.md`, `.claude/`, `docs/dev-notes/`)
- Pure refactors that change zero observed behavior (`refactor:` prefix with no API surface change)
- CI-only changes that do not affect built artifacts (`ci:` prefix)
- Style/formatting (`style:` prefix)

If unsure, **add the entry**. A redundant entry is cheaper than a missing one.

## Multi-line / multi-bullet entries

Use the existing nested bullet pattern:

```markdown
- Ollama bridge cleanup (#403 review followups, closes #405 #406 #407):
  - `src/ollama/bridge.ts` 不再重复实现 `normalizeHostname`...
  - `proxyOpenAIRequest` 转发头扩展到...
  - `MAX_SSE_BUFFER` 重命名为 `MAX_SSE_BUFFER_CHARS`...
```
