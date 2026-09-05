/**
 * Runtime tracking of fallback usage.
 *
 * The dashboard wants to visually signal when requests are being served by a
 * fallback — a backup account from the pool, or the last-resort fallback
 * upstream apikey. This module keeps a lightweight in-memory "recently used"
 * window so the UI can flash the fallback indicator while it is active and go
 * back to its normal look once requests stop relying on fallbacks.
 *
 * 语义说明：这里的“active”表示“最近 60 秒内曾使用过后备”，近似于“最近一次用过
 * 后备”的指示灯行为，而不是“后备当前正在正常提供服务中”。后备是否真正服务成功
 * 由后续的请求结果决定，但指示灯的亮起/熄灭只依赖本次时间窗，二者并不挂钩。
 */

let lastFallbackUseMs: number | null = null;

/**
 * How long a fallback is considered "active" after its last use.
 * 60 秒时间窗：最后一次触发后备之后的这段时间内，指示灯保持点亮。
 */
const ACTIVE_WINDOW_MS = 60_000;

/**
 * 标记“已使用后备”。注意它是在取得后备账号的那一刻即被触发，而非等到确认后备
 * 已经成功完成服务之后才触发（也就是“切到后备账号”就点亮，而不是“后备请求成功”
 * 才点亮）。因此即便后备随后失败（例如重试也报错），指示灯仍会在约 60 秒内保持
 * 点亮——这是“最近一次使用过后备”的近义行为，语义是“最近用过”，不是“当前正常
 * 服务中”。
 */
export function markFallbackUsed(nowMs: number = Date.now()): void {
  lastFallbackUseMs = nowMs;
}

export function isFallbackActive(nowMs: number = Date.now()): boolean {
  return lastFallbackUseMs !== null && nowMs - lastFallbackUseMs < ACTIVE_WINDOW_MS;
}

export function getFallbackActivity(): { active: boolean; lastUsedAt: string | null } {
  const active = isFallbackActive();
  return {
    active,
    lastUsedAt: lastFallbackUseMs !== null ? new Date(lastFallbackUseMs).toISOString() : null,
  };
}
