import type { ProxyRequest, UsageHint } from "./proxy-handler-types.js";
import {
  applyImplicitResumeRequest,
  restoreImplicitResumeRequestState,
  type ImplicitResumeAffinityLookup,
  type ImplicitResumeRequestSnapshot,
} from "./proxy-implicit-resume-request.js";
import {
  evaluateImplicitResume,
  shouldReplayFullInputAfterImplicitResumeError,
  type ImplicitResumeOpts,
} from "./proxy-session-helpers.js";

type ImplicitResumeEvaluation = ReturnType<typeof evaluateImplicitResume>;
type ImplicitResumeWarn = (message: string) => void;

export type ImplicitResumeEvaluationInput = Omit<ImplicitResumeOpts, "acquiredEntryId">;

export interface CreateImplicitResumeLifecycleOptions {
  request: ProxyRequest;
  snapshot: ImplicitResumeRequestSnapshot;
  affinityMap: ImplicitResumeAffinityLookup;
  tag: string;
  implicitPrevRespId: string | null;
  continuationInputStart: number;
  resumeEvaluationInput: ImplicitResumeEvaluationInput;
  acquiredEntryId: string;
  warn?: ImplicitResumeWarn;
}

export interface ImplicitResumeLifecycle {
  evaluation: ImplicitResumeEvaluation;
  activate(): void;
  canReplayAfterError(err: unknown): boolean;
  getUsageHint(): UsageHint | undefined;
  isActive(): boolean;
  logSkippedWarnings(): void;
  replayFullInputAfterError(err: unknown): boolean;
  restore(): void;
  resumeReasonForAttempt(): string | null;
}

export function createImplicitResumeLifecycle(
  options: CreateImplicitResumeLifecycleOptions,
): ImplicitResumeLifecycle {
  const {
    request,
    snapshot,
    affinityMap,
    tag,
    implicitPrevRespId,
    continuationInputStart,
    resumeEvaluationInput,
    acquiredEntryId,
    warn = console.warn,
  } = options;

  const evaluation = evaluateImplicitResume({
    ...resumeEvaluationInput,
    acquiredEntryId,
  });
  let active = false;
  let usageHint: UsageHint | undefined;

  const restore = (): void => {
    if (!active) return;
    restoreImplicitResumeRequestState({ request, snapshot });
    usageHint = undefined;
    active = false;
  };

  return {
    evaluation,
    activate(): void {
      if (!evaluation.active || active || !implicitPrevRespId) return;
      usageHint = applyImplicitResumeRequest({
        request,
        implicitPrevRespId,
        continuationInputStart,
        affinityMap,
      });
      active = true;
    },
    getUsageHint(): UsageHint | undefined {
      return usageHint;
    },
    isActive(): boolean {
      return active;
    },
    logSkippedWarnings(): void {
      if (evaluation.active) return;
      if (evaluation.missingCallIds && evaluation.missingCallIds.length > 0) {
        warn(
          `[${tag}] 隐式续链跳过：上一轮 response 未记录 tool_result 对应的 call_id=` +
          evaluation.missingCallIds.slice(0, 3).join(","),
        );
      }
      if (evaluation.unansweredCallIds && evaluation.unansweredCallIds.length > 0) {
        warn(
          `[${tag}] 隐式续链跳过：上一轮 function_call 未被全部回复，缺 call_id=` +
          evaluation.unansweredCallIds.slice(0, 3).join(","),
        );
      }
    },
    canReplayAfterError(err: unknown): boolean {
      return shouldReplayFullInputAfterImplicitResumeError(err, active);
    },
    replayFullInputAfterError(err: unknown): boolean {
      if (!shouldReplayFullInputAfterImplicitResumeError(err, active)) return false;
      warn(`[${tag}] 隐式续链 WebSocket 失败，回退为完整历史重放：${err.causeMessage}`);
      restore();
      return true;
    },
    restore,
    resumeReasonForAttempt(): string | null {
      return evaluation.active ? null : evaluation.reason;
    },
  };
}
