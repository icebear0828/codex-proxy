# Issue Type Specs

Required and optional fields per issue type. The skill enforces "required" — every required field must have either an answer or an explicit "not applicable" / "unknown" before the issue can be filed.

## Bug

| Field | Required | Notes |
|---|---|---|
| One-line summary | yes | Becomes part of the title; ≤72 chars |
| Expected behavior | yes | What the user thought would happen |
| Actual behavior | yes | What actually happened |
| Reproduction steps | yes | Numbered list, deterministic |
| Codex-proxy version | yes | `npm pkg get version` or About dialog |
| Deployment mode | yes | Electron / Docker / `npm start` / dev / source |
| OS + arch | yes | e.g. macOS 14.5 arm64, Windows 11 x64, Ubuntu 22.04 x64 |
| Relevant logs | yes | Redact secrets; "none" is acceptable |
| Frequency | yes | always / intermittent / once |
| Workaround | no | If the user found one |
| First broken version | no | If known (helps bisect) |
| Related issues | no | `Refs #N` |

## Feature Request

| Field | Required | Notes |
|---|---|---|
| One-line summary | yes | Title material |
| Problem statement | yes | The user-facing motivation. NOT the proposed solution. |
| Proposed solution | yes | High level; implementation detail is welcome but optional |
| Alternatives considered | yes | Even "I considered X but it doesn't fit because Y" |
| Who benefits | yes | single user / all users / specific deployment mode / specific upstream |
| Impact if NOT done | no | Does the user have a workaround? Is this blocking? |
| Related issues / PRs | no | `Refs #N` |
| Mockups / sketches | no | For UI features |

## Question

| Field | Required | Notes |
|---|---|---|
| What you're trying to accomplish | yes | The end goal, not the immediate confusion |
| What you tried | yes | Commands, config, links to docs read |
| What you expected | yes | |
| What happened | yes | |
| Relevant config | yes | Redact secrets; "none" if no config involved |
| Codex-proxy version | yes | |
| Deployment mode | yes | |

If a "question" turns out to be a bug during the interview, switch to the Bug template — do not file under `question`.

## Performance

All Bug fields, plus:

| Field | Required | Notes |
|---|---|---|
| Baseline measurement | yes | Numbers from a known-good version or expected baseline |
| Current measurement | yes | Same metric, current version |
| Measurement methodology | yes | How the numbers were taken — script, manual stopwatch, profiler |
| Reproduction harness | yes | Script, `tests/bench/...` reference, or steps |
| Resource constraint hit | no | CPU, memory, network, file descriptors, etc. |

A perf report without numbers is a bug report — switch templates.

## Documentation

| Field | Required | Notes |
|---|---|---|
| Doc location | yes | File path (`README.md`, `CLAUDE.md`, `docs/...`) or URL |
| What is wrong / missing | yes | Specific quote of the offending text, or "this section is missing" |
| Suggested fix | no | Welcome but not required |
| Audience affected | no | New users / operators / contributors / API consumers |
