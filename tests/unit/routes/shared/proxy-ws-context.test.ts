import { describe, expect, it } from "vitest";
import { WsConnectionPool } from "@src/proxy/ws-pool.js";
import { buildWsPoolContext, type BuildWsPoolContextDeps } from "@src/routes/shared/proxy-ws-context.js";

function createPool(): WsConnectionPool {
  return new WsConnectionPool({ enabled: false }, { startGc: false });
}

function createDeps(pool = createPool()): {
  deps: BuildWsPoolContextDeps;
  logLines: string[];
  getPoolCalls: number;
} {
  const logLines: string[] = [];
  let getPoolCalls = 0;
  return {
    deps: {
      getWsPool: () => {
        getPoolCalls += 1;
        return pool;
      },
      log: (line) => {
        logLines.push(line);
      },
    },
    logLines,
    get getPoolCalls() {
      return getPoolCalls;
    },
  };
}

function baseOptions(): Parameters<typeof buildWsPoolContext>[0] {
  return {
    useWebSocket: true,
    conversationId: "conv-1",
    entryId: "entry-A",
    variantHash: "vh-123",
    requestId: "request-abcdef",
    tag: "Responses",
  };
}

describe("buildWsPoolContext", () => {
  it("does not create the singleton pool when WebSocket is disabled", () => {
    const deps = createDeps();

    const context = buildWsPoolContext({ ...baseOptions(), useWebSocket: false }, deps.deps);

    expect(context).toBeUndefined();
    expect(deps.getPoolCalls).toBe(0);
  });

  it("does not create the singleton pool without a stable conversation id", () => {
    for (const conversationId of [null, undefined, ""]) {
      const deps = createDeps();

      const context = buildWsPoolContext({ ...baseOptions(), conversationId }, deps.deps);

      expect(context).toBeUndefined();
      expect(deps.getPoolCalls).toBe(0);
    }
  });

  it("builds a pool context keyed by entry id, chain conversation id, and variant hash", () => {
    const pool = createPool();
    const deps = createDeps(pool);

    const context = buildWsPoolContext(baseOptions(), deps.deps);

    expect(context).toBeDefined();
    expect(context?.pool).toBe(pool);
    expect(context?.entryId).toBe("entry-A");
    expect(context?.poolKey).toBe("entry-A:conv-1:vh-123");
    expect(deps.getPoolCalls).toBe(1);
  });

  it("logs pool decisions with the route tag and shortened request id", () => {
    const deps = createDeps();
    const context = buildWsPoolContext(baseOptions(), deps.deps);

    context?.onDecision?.({ kind: "bypass", reason: "busy" });
    context?.onDecision?.({ kind: "retry-after-stale-reuse", wsId: "ws-1" });
    context?.onDecision?.({ kind: "reuse", wsId: "ws-2" });
    context?.onDecision?.({ kind: "new", wsId: "ws-3" });

    expect(deps.logLines).toEqual([
      "[Responses] Account entry-A | rid=request- | ws=bypass(busy)",
      "[Responses] Account entry-A | rid=request- | ws=retry-after-stale-reuse:ws-1",
      "[Responses] Account entry-A | rid=request- | ws=reuse:ws-2",
      "[Responses] Account entry-A | rid=request- | ws=new:ws-3",
    ]);
  });
});
