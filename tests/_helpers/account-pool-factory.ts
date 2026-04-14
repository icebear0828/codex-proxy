/**
 * AccountPool factory helpers for unit tests.
 *
 * Provides createMemoryPersistence() so tests can inject in-memory storage
 * into AccountPool without mocking the "fs" or "paths" modules.
 *
 * Usage:
 *   import "@helpers/account-pool-setup.js";               // vi.mock declarations first
 *   import { createMemoryPersistence } from "@helpers/account-pool-factory.js";
 *   import { AccountPool } from "@src/auth/account-pool.js";
 *   import { createValidJwt } from "@helpers/jwt.js";       // real JWT parsing, no mock needed
 *
 *   const pool = new AccountPool({ persistence: createMemoryPersistence() });
 *   pool.addAccount(createValidJwt({ email: "a@test.com", planType: "team" }));
 */

import type { AccountPersistence } from "@src/auth/account-persistence.js";
import type { AccountEntry } from "@src/auth/types.js";

/**
 * In-memory AccountPersistence implementation.
 * Backed by a plain array — no disk I/O, no fs mock required.
 *
 * @param initial  Pre-populate with these entries (optional).
 */
export function createMemoryPersistence(
  initial: AccountEntry[] = [],
): AccountPersistence & { _store: AccountEntry[] } {
  const _store: AccountEntry[] = initial.map((e) => ({ ...e }));
  return {
    _store,
    load() {
      return { entries: _store.map((e) => ({ ...e })), needsPersist: false };
    },
    save(entries: AccountEntry[]) {
      _store.length = 0;
      _store.push(...entries.map((e) => ({ ...e })));
    },
  };
}
