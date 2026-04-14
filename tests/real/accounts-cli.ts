#!/usr/bin/env npx tsx
/**
 * Account management CLI for real tests.
 *
 * Usage:
 *   npx tsx tests/real/accounts-cli.ts list
 *   npx tsx tests/real/accounts-cli.ts disable-all
 *   npx tsx tests/real/accounts-cli.ts enable-all
 *   npx tsx tests/real/accounts-cli.ts isolate <email|id>
 *   npx tsx tests/real/accounts-cli.ts restore
 *   npx tsx tests/real/accounts-cli.ts test <email|id>
 */

import {
  listAccounts, getActiveAccounts, setAccountStatus,
  isolateAccount, sendQuickRequest,
} from "./_helpers.js";

async function list(): Promise<void> {
  const accounts = await listAccounts();
  console.log(`Total: ${accounts.length}\n`);
  console.log("ID               Email                              Status    RT   Plan");
  console.log("─".repeat(90));
  for (const a of accounts) {
    console.log(
      `${a.id}  ${(a.email ?? "—").padEnd(35)} ${a.status.padEnd(10)} ${(a.hasRefreshToken ? "✓" : "✗").padEnd(4)} ${a.planType ?? "—"}`,
    );
  }
  const statusCounts = accounts.reduce<Record<string, number>>((acc, a) => {
    acc[a.status] = (acc[a.status] ?? 0) + 1;
    return acc;
  }, {});
  const rtCount = accounts.filter((a) => a.hasRefreshToken).length;
  console.log(`\n${Object.entries(statusCounts).map(([s, c]) => `${s}: ${c}`).join(", ")} | RT: ${rtCount}/${accounts.length}`);
}

async function disableAll(): Promise<void> {
  const active = await getActiveAccounts();
  if (active.length === 0) { console.log("No active accounts"); return; }
  await setAccountStatus(active.map((a) => a.id), "disabled");
  console.log(`Disabled ${active.length} accounts`);
}

async function enableAll(): Promise<void> {
  const accounts = await listAccounts();
  const disabled = accounts.filter((a) => a.status === "disabled");
  if (disabled.length === 0) { console.log("No disabled accounts"); return; }
  await setAccountStatus(disabled.map((a) => a.id), "active");
  console.log(`Enabled ${disabled.length} accounts`);
}

async function isolate(target: string): Promise<void> {
  const { target: acct } = await isolateAccount(target);
  console.log(`Isolated ${acct.email ?? acct.id}`);
}

async function test(target: string): Promise<void> {
  const { restore } = await isolateAccount(target);
  try {
    const { status, body } = await sendQuickRequest();
    if (status === 200) {
      const choices = body.choices as Array<{ message: { content: string } }> | undefined;
      console.log(`→ ${status} OK: ${choices?.[0]?.message?.content ?? JSON.stringify(body)}`);
    } else {
      const err = body.error as { message?: string } | undefined;
      console.log(`→ ${status} FAIL: ${err?.message ?? JSON.stringify(body)}`);
    }
  } finally {
    await restore();
    console.log("Accounts restored");
  }
}

const [cmd, arg] = process.argv.slice(2);
switch (cmd) {
  case "list": await list(); break;
  case "disable-all": await disableAll(); break;
  case "enable-all": await enableAll(); break;
  case "isolate":
    if (!arg) { console.error("Usage: isolate <email|id>"); process.exit(1); }
    await isolate(arg); break;
  case "restore": await enableAll(); break;
  case "test":
    if (!arg) { console.error("Usage: test <email|id>"); process.exit(1); }
    await test(arg); break;
  default:
    console.log("Commands: list | disable-all | enable-all | isolate <email|id> | restore | test <email|id>");
}
