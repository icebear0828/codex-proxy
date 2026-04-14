/**
 * Vitest globalSetup for real tests.
 *
 * When TEST_ACCOUNT is set (email or id), isolates that account via
 * the shared isolateAccount() helper — only disables accounts with RT.
 */

import { isolateAccount } from "./_helpers.js";

const TEST_ACCOUNT = process.env.TEST_ACCOUNT ?? "";

let restoreFn: (() => Promise<void>) | null = null;

export async function setup(): Promise<void> {
  if (!TEST_ACCOUNT) return;

  const { target, restore } = await isolateAccount(TEST_ACCOUNT);
  restoreFn = restore;
  console.log(`[global-setup] Isolated account ${target.email ?? target.id}`);
}

export async function teardown(): Promise<void> {
  if (!restoreFn) return;
  await restoreFn();
  restoreFn = null;
  console.log("[global-setup] Accounts restored");
}
