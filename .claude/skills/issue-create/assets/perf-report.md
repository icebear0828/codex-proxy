<!--
Performance report template for codex-proxy issues.
The issue-create skill fills in {{placeholders}}.
A perf report without numbers is just a bug — switch to bug-report.md if
no measurements are available.
-->

## Summary

{{One sentence describing the regression or slowness.}}

## Expected behavior

{{What performance was expected, and where that expectation comes from
(prior version, docs, comparable system).}}

## Actual behavior

{{What is observed instead.}}

## Measurements

| Metric | Baseline | Current | Delta |
|---|---|---|---|
| {{e.g. p95 latency}} | {{200ms}} | {{1.4s}} | {{+600%}} |
| {{e.g. memory RSS}} | {{180MB}} | {{420MB}} | {{+133%}} |

**Methodology:** {{How the numbers were taken — script, manual stopwatch,
profiler, load test. Be specific enough that a maintainer can reproduce.}}

## Reproduction harness

```
{{Script, `tests/bench/...` reference, or numbered steps. Must be
deterministic enough to re-measure.}}
```

## Environment

| Field | Value |
|---|---|
| Codex-proxy version | {{e.g. 1.4.2 or commit SHA}} |
| Deployment mode | {{Electron / Docker / `npm start` / dev}} |
| OS + arch | {{e.g. macOS 14.5 arm64}} |
| First slow version (if known) | {{version or "unknown"}} |
| Resource constraint hit | {{CPU / memory / network / FDs / "none"}} |

## Logs / output

```
{{Relevant log lines or profiler output. SECRETS REDACTED.}}
```

## Additional context

{{Anything else. Remove if empty.}}

## Related

{{Refs #N, Related to #N — remove if none.}}
