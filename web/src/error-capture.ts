/**
 * Renderer-side uncaught error capture.
 *
 * Hooks `window.error` and `window.unhandledrejection` and forwards
 * each event to the backend's `/admin/error-logs/report` endpoint.
 * The backend redacts secrets, rotates the JSONL file, and exposes
 * the result through the Errors tab.
 *
 * Why fetch (not Electron IPC):
 * - The renderer already runs same-origin against the local HTTP
 *   server, so a fetch costs nothing extra and matches every other
 *   admin call in the dashboard.
 * - IPC would require a contextBridge preload + new ipcMain handler,
 *   adding two surfaces to maintain. Fetch is one round trip.
 *
 * Failures here are deliberately swallowed — error logging that
 * itself throws would just compound the user-visible breakage.
 */

type ReportPayload = {
  source: "renderer";
  error: { name: string; message: string; stack?: string };
  context?: Record<string, unknown>;
};

function safeUrl(): string | undefined {
  try {
    return typeof location !== "undefined" ? location.href : undefined;
  } catch {
    return undefined;
  }
}

/** Build a renderer report from a `window.error` ErrorEvent. Pure for tests. */
export function buildRendererErrorReport(event: {
  error?: unknown;
  message?: string;
  filename?: string;
  lineno?: number;
  colno?: number;
}): ReportPayload {
  const err = event.error;
  const message =
    typeof event.message === "string" && event.message.length > 0
      ? event.message
      : err instanceof Error
        ? err.message
        : "Uncaught error";
  const name =
    err instanceof Error && typeof err.name === "string" ? err.name : "Error";
  const stack = err instanceof Error ? err.stack : undefined;

  const context: Record<string, unknown> = {};
  if (event.filename) context.filename = event.filename;
  if (typeof event.lineno === "number") context.lineno = event.lineno;
  if (typeof event.colno === "number") context.colno = event.colno;
  const url = safeUrl();
  if (url) context.url = url;

  return {
    source: "renderer",
    error: { name, message, stack },
    context: Object.keys(context).length > 0 ? context : undefined,
  };
}

/** Build a renderer report from an `unhandledrejection` PromiseRejectionEvent. Pure for tests. */
export function buildRendererRejectionReport(event: {
  reason?: unknown;
}): ReportPayload {
  const reason = event.reason;
  let name = "UnhandledRejection";
  let message = "Unhandled promise rejection";
  let stack: string | undefined;

  if (reason instanceof Error) {
    name = reason.name || name;
    message = reason.message;
    stack = reason.stack;
  } else if (typeof reason === "string" && reason.length > 0) {
    message = reason;
  } else if (reason !== undefined && reason !== null) {
    try {
      message = JSON.stringify(reason);
    } catch {
      message = String(reason);
    }
  }

  const url = safeUrl();
  return {
    source: "renderer",
    error: { name, message, stack },
    context: url ? { url } : undefined,
  };
}

async function postReport(payload: ReportPayload): Promise<void> {
  try {
    await fetch("/admin/error-logs/report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      // Same-origin localhost — no credential plumbing required, the
      // existing dashboardAuth middleware allows local requests.
    });
  } catch {
    // Drop — see file header.
  }
}

let _installed = false;

/**
 * Idempotently register the global error + rejection listeners.
 * Safe to call from `main.tsx` before `render()` so initial paint
 * crashes are captured.
 */
export function installRendererErrorCapture(): void {
  if (_installed) return;
  if (typeof window === "undefined") return;
  _installed = true;

  window.addEventListener("error", (ev) => {
    void postReport(buildRendererErrorReport(ev as ErrorEvent));
  });

  window.addEventListener("unhandledrejection", (ev) => {
    void postReport(
      buildRendererRejectionReport(ev as PromiseRejectionEvent),
    );
  });
}

/** Test-only — reset install flag so a follow-up call re-installs. */
export function _resetInstallFlagForTest(): void {
  _installed = false;
}
