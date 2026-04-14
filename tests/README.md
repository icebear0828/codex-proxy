# Test Suite

## Quick Start

```bash
npm test                # unit + integration + e2e (default suite)
npm run test:unit       # unit tests only
npm run test:e2e        # e2e tests only
npm run test:integration # integration tests only
npm run test:stress     # stress tests (separate config, 120s timeout)
npm run test:real       # real upstream tests (requires running proxy)
```

## Structure

```
tests/
├── _fixtures/          # Test data (models.yaml, sse-streams.ts)
├── _helpers/           # Shared test utilities (8 modules)
│   ├── account-pool-factory.ts   # createMemoryPersistence()
│   ├── account-pool-setup.ts     # Pre-declared vi.mock() for AccountPool
│   ├── config.ts                 # createMockConfig(), createMockFingerprint()
│   ├── e2e-setup.ts              # E2E boundary mock (transport, config, fs)
│   ├── events.ts                 # ExtractedEvent factories
│   ├── format-adapter.ts         # createMockFormatAdapter()
│   ├── jwt.ts                    # createJwt(), createValidJwt(), createExpiredJwt()
│   └── sse.ts                    # SSE stream builders (8 functions)
├── unit/               # Unit tests — pure functions, single modules (106 files)
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
├── integration/        # Multi-module workflows (5 files)
├── e2e/                # Full API contract tests (10 files)
├── stress/             # Concurrency & rotation fairness (3 files, separate config)
├── real/               # Real upstream tests (17 files, separate config)
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

| Config | Scope | Timeout | Included in `npm test` |
|--------|-------|---------|----------------------|
| `vitest.config.ts` (root) | unit + integration + e2e + electron | 5s | Yes |
| `tests/vitest.config.ts` | stress | 120s | No (`npm run test:stress`) |
| `tests/real/vitest.config.ts` | real | 60s | No (`npm run test:real`) |

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
