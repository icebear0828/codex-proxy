export type AccountExportFormat = "full" | "minimal" | "cockpit_tools" | "sub2api" | "cpa";

export const ACCOUNT_EXPORT_FORMATS: AccountExportFormat[] = [
  "full",
  "minimal",
  "cockpit_tools",
  "sub2api",
  "cpa",
];

export interface AccountImportFile {
  name: string;
  type?: string;
  text(): Promise<string>;
}

export type PreparedAccountImportRequest =
  | { ok: true; contentType: "application/json" | "text/plain"; body: string }
  | { ok: false; error: string };

function isLikelyJsonFile(file: AccountImportFile): boolean {
  const name = file.name.toLowerCase();
  const type = file.type?.toLowerCase() ?? "";
  return name.endsWith(".json") || type.includes("json");
}

function isJsonText(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

export function buildAccountExportUrl(
  selectedIds: string[] | undefined,
  format: AccountExportFormat = "full",
): string {
  const params = new URLSearchParams();
  if (selectedIds && selectedIds.length > 0) params.set("ids", selectedIds.join(","));
  if (format !== "full") params.set("format", format);
  const qs = params.toString();
  return `/auth/accounts/export${qs ? `?${qs}` : ""}`;
}

export function accountExportDownloadName(
  format: AccountExportFormat,
  date = new Date().toISOString().slice(0, 10),
): string {
  const suffix = format === "full" ? "" : `-${format.replaceAll("_", "-")}`;
  return `accounts-export${suffix}-${date}.json`;
}

export async function prepareAccountImportRequest(
  file: AccountImportFile,
): Promise<PreparedAccountImportRequest> {
  const body = await file.text();
  if (!body.trim()) return { ok: false, error: "No importable content" };

  if (isLikelyJsonFile(file) || isJsonText(body)) {
    try {
      JSON.parse(body) as unknown;
      return { ok: true, contentType: "application/json", body };
    } catch {
      if (isLikelyJsonFile(file)) return { ok: false, error: "Invalid JSON file" };
    }
  }

  return { ok: true, contentType: "text/plain", body };
}
