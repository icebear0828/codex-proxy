# Test Suite

## Quick Start

```bash
npm test                # auto-detects Windows/Linux suite from the host OS
npm run test:windows    # explicitly select Windows-compatible coverage
npm run test:linux      # explicitly select POSIX/native Linux coverage
npm run test:unit       # unit tests only
npm run test:e2e        # e2e tests only
npm run test:integration # integration tests only
npm run test:stress     # stress tests (separate config, 120s timeout)
npm run test:real       # real upstream tests (requires running proxy)
```

The Windows and Linux configs share `vitest.shared-config.ts`, test discovery, aliases, and test definitions. Add ordinary tests once under the existing `shared`, `tests/unit`, `tests/integration`, `tests/contract`, or `tests/e2e` trees; both platform suites discover them automatically. Wrap OS-native behavior in a shared `describePosix` or `describeWindows` block from `tests/_helpers/platform-test.ts` rather than copying the test cases. POSIX shell tests run on Linux; the Windows suite keeps shared tests and Windows-compatible coverage.

## Structure

```
tests/
├── _fixtures/          # Test data (models.yaml, sse-streams.ts)
├── _helpers/           # Shared test utilities
│   ├── account-pool-factory.ts   # createMemoryPersistence()
│   ├── account-pool-setup.ts     # Pre-declared vi.mock() for AccountPool
│   ├── config.ts                 # createMockConfig(), createMockFingerprint()
│   ├── e2e-setup.ts              # E2E boundary mock (transport, config, fs)
│   ├── events.ts                 # ExtractedEvent factories
│   ├── format-adapter.ts         # createMockFormatAdapter()
│   ├── platform-test.ts          # describePosix(), describeWindows()
│   ├── test-data-directory.ts    # cross-platform isolated test data dirs
│   ├── jwt.ts                    # createJwt(), createValidJwt(), createExpiredJwt()
│   └── sse.ts                    # SSE stream builders (8 functions)
├── unit/               # Unit tests — pure functions, single modules (124 files)
│   ├── auth/           # AccountPool, rotation, quota, refresh, session affinity
│   ├── middleware/      # Dashboard auth, error handler, request-id
│   ├── models/         # Model store, cache, plan routing, fetcher retry
│   ├── proxy/          # CodexApi, SSE parsing, upstream router, proxy pool
│   ├── routes/         # Account CRUD, settings, responses, dashboard login
│   │   └── shared/     # Account acquisition, error handler, response processor
│   ├── services/       # Account import/mutation/query
│   ├── tls/            # Direct fallback, proxy hostname resolution
│   ├── translation/    # All codec pairs (openai/anthropic/gemini ↔ codex)
│   ├── types/          # Zod schema validation
│   ├── utils/          # Jitter, retry, logger, yaml-mutate
│   └── web/            # Theme, cache headers, add-account
├── integration/        # Multi-module workflows (6 files)
├── e2e/                # Full API contract tests (9 files)
├── stress/             # Concurrency & rotation fairness (3 files, separate config)
├── real/               # Real upstream tests (15 files, separate config)
├── bench/              # Benchmark scripts (manual, not vitest)
│   ├── concurrency-bench.ts
│   ├── model-bench.ts
│   └── overhead-bench.ts
└── scripts/            # Manual test utilities
    ├── stress-test.ts
    ├── test-account.ts
    └── e2e-session-affinity.py
```

## Vitest Configs

| Config | Scope | Platform | Notes |
|--------|-------|----------|-------|
| `vitest.shared-config.ts` | aliases + common test discovery | Shared | Factory consumed by both platform configs |
| `vitest.windows.config.ts` | shared unit + integration + e2e + portable Electron unit tests | Windows | Excludes native Electron build/pack/release integration; `npm run test:windows` |
| `vitest.linux.config.ts` | shared unit + integration + e2e + electron | Linux | Full POSIX/native suite; runs from `npm run test:linux` |
| `vitest.config.ts` (root) | host-selected suite | Windows/Linux auto-detect; full suite elsewhere | Used by `npm test` and ad hoc Vitest commands |
| `tests/vitest.config.ts` | stress | Any | 120s timeout; `npm run test:stress` |
| `tests/real/vitest.config.ts` | real | Any | 60s timeout; `npm run test:real` |

## Real-Upstream Coverage Gaps (accepted risk)

The default `npm run test:real` suite only exercises free-tier accounts. The following paths have never been validated against a real Plus/Team upstream and are covered by mocks/fixtures only — documented as accepted risk (#377):

- **Secondary rate-limit rotation** — `secondary-quota.test.ts` stress scenarios use mocks only.
- **Team/Plus plan model access** — e.g. `gpt-5.4` returns `400` on free accounts.
- **Credits balance management** — `credits` is `null` for free accounts.
- **Rate-limit (429) fallback recovery** — cannot trigger a real 429 to validate recovery.
- **Prompt cache hit rates** — upstream returns `cached_tokens=0` for free accounts.

Mocks validate plumbing (field presence, type correctness) but cannot catch cross-plan behavioral differences. When a Plus/Team test account or recorded real-tier fixtures become available, revisit these paths and extend `tests/real/`.

## Conventions

- All test imports use `@src/` alias (never relative `../` into `src/`)
- Helpers use `@helpers/` alias, fixtures use `@fixtures/`
- E2E tests mock only external boundaries (TLS transport, fs, background tasks)
- Stress and real tests run serially (`maxForks: 1`)
- Zero `any` types in test code

## E2E Architecture

```
[Test] → Hono App → Route → translateRequest → handleProxyRequest → CodexApi → [Mock Transport]
                      ↑ real                                             ↑ real       ↑ mocked
```

Mocked: `@src/tls/transport.js`, `@src/config.js`, `@src/paths.js`, `fs` (models.yaml only), background tasks.
Real: AccountPool, CookieJar, ProxyPool, CodexApi, all translation layers, all middleware.
