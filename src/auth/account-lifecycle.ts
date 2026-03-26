/**
 * AccountLifecycle — owns acquire locks and rotation strategy.
 *
 * Handles: acquire, release, lock management, rotation strategy.
 * Uses AccountRegistry for entry access (no circular dep — one-way reference).
 */

import { getModelPlanTypes, isPlanFetched } from "../models/model-store.js";
import { getRotationStrategy } from "./rotation-strategy.js";
import type { RotationStrategy, RotationState, RotationStrategyName } from "./rotation-strategy.js";
import type { AccountRegistry } from "./account-registry.js";
import type { AccountEntry, AcquiredAccount } from "./types.js";

const ACQUIRE_LOCK_TTL_MS = 5 * 60 * 1000; // 5 minutes

export class AccountLifecycle {
  private acquireLocks: Map<string, number> = new Map();
  private strategy: RotationStrategy;
  private rotationState: RotationState = { roundRobinIndex: 0 };
  private registry: AccountRegistry;

  constructor(registry: AccountRegistry, strategyName: RotationStrategyName) {
    this.registry = registry;
    this.strategy = getRotationStrategy(strategyName);
  }

  acquire(options?: { model?: string; excludeIds?: string[] }): AcquiredAccount | null {
    const now = new Date();
    const nowMs = now.getTime();

    for (const entry of this.registry.getAllEntries()) {
      this.registry.refreshStatus(entry, now);
    }

    // Auto-release stale locks
    for (const [id, lockedAt] of this.acquireLocks) {
      if (nowMs - lockedAt > ACQUIRE_LOCK_TTL_MS) {
        console.warn(`[AccountPool] Auto-releasing stale lock for ${id} (locked ${Math.round((nowMs - lockedAt) / 1000)}s ago)`);
        this.acquireLocks.delete(id);
      }
    }

    const excludeSet = new Set(options?.excludeIds ?? []);

    const available = this.registry.getAllEntries().filter(
      (a) => a.status === "active" && !this.acquireLocks.has(a.id) && !excludeSet.has(a.id),
    );

    if (available.length === 0) return null;

    let candidates = available;
    if (options?.model) {
      const preferredPlans = getModelPlanTypes(options.model);
      if (preferredPlans.length > 0) {
        const planSet = new Set(preferredPlans);
        const matched = available.filter((a) => {
          if (!a.planType) return false;
          if (planSet.has(a.planType)) return true;
          return !isPlanFetched(a.planType);
        });
        if (matched.length > 0) {
          candidates = matched;
        } else {
          return null;
        }
      }
    }

    const selected = this.strategy.select(candidates, this.rotationState);
    this.acquireLocks.set(selected.id, Date.now());
    return {
      entryId: selected.id,
      token: selected.token,
      accountId: selected.accountId,
    };
  }

  release(
    entryId: string,
    usage?: { input_tokens?: number; output_tokens?: number },
  ): void {
    this.acquireLocks.delete(entryId);
    const entry = this.registry.getEntry(entryId);
    if (!entry) return;

    entry.usage.request_count++;
    entry.usage.last_used = new Date().toISOString();
    if (usage) {
      entry.usage.input_tokens += usage.input_tokens ?? 0;
      entry.usage.output_tokens += usage.output_tokens ?? 0;
    }
    entry.usage.window_request_count = (entry.usage.window_request_count ?? 0) + 1;
    if (usage) {
      entry.usage.window_input_tokens = (entry.usage.window_input_tokens ?? 0) + (usage.input_tokens ?? 0);
      entry.usage.window_output_tokens = (entry.usage.window_output_tokens ?? 0) + (usage.output_tokens ?? 0);
    }
    this.registry.schedulePersist();
  }

  releaseWithoutCounting(entryId: string): void {
    this.acquireLocks.delete(entryId);
  }

  /** Clear lock for an entry (called by facade on status mutations). */
  clearLock(entryId: string): void {
    this.acquireLocks.delete(entryId);
  }

  setRotationStrategy(name: RotationStrategyName): void {
    this.strategy = getRotationStrategy(name);
    this.rotationState.roundRobinIndex = 0;
  }

  getDistinctPlanAccounts(): Array<{
    planType: string;
    entryId: string;
    token: string;
    accountId: string | null;
  }> {
    const now = new Date();
    for (const entry of this.registry.getAllEntries()) {
      this.registry.refreshStatus(entry, now);
    }

    const available = this.registry.getAllEntries().filter(
      (a: AccountEntry) => a.status === "active" && !this.acquireLocks.has(a.id) && a.planType,
    );

    const byPlan = new Map<string, AccountEntry[]>();
    for (const a of available) {
      const plan = a.planType!;
      let group = byPlan.get(plan);
      if (!group) {
        group = [];
        byPlan.set(plan, group);
      }
      group.push(a);
    }

    const result: Array<{ planType: string; entryId: string; token: string; accountId: string | null }> = [];
    for (const [plan, group] of byPlan) {
      const selected = this.strategy.select(group, this.rotationState);
      this.acquireLocks.set(selected.id, Date.now());
      result.push({
        planType: plan,
        entryId: selected.id,
        token: selected.token,
        accountId: selected.accountId,
      });
    }

    return result;
  }
}
