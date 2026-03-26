/**
 * CurlCliTransport — TLS transport using curl CLI subprocess.
 *
 * Extracted from codex-api.ts (curlPost) and curl-fetch.ts (execCurl).
 * Supports both streaming POST (SSE) and simple GET/POST.
 *
 * Used on macOS/Linux (curl-impersonate CLI) and as fallback on Windows (system curl).
 */

import { spawn, execFile } from "child_process";
import { resolveCurlBinary, getChromeTlsArgs, getProxyArgs, isImpersonate as curlIsImpersonate, supportsCompressed, checkHttp2Fallback } from "./curl-binary.js";
import type { TlsTransport, TlsTransportResponse } from "./transport.js";
import { getConfig } from "../config.js";

const STATUS_SEPARATOR = "\n__CURL_HTTP_STATUS__";
const DEFAULT_HEADER_TIMEOUT_MS = 120_000;

function getHeaderTimeoutMs(): number {
  try {
    return getConfig().api.timeout_seconds * 1000;
  } catch {
    return DEFAULT_HEADER_TIMEOUT_MS;
  }
}

/** Push header args to curl, skipping Accept-Encoding so --compressed can auto-negotiate. */
export function pushHeaderArgs(args: string[], headers: Record<string, string>): void {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === "accept-encoding") continue;
    args.push("-H", `${key}: ${value}`);
  }
}

export class CurlCliTransport implements TlsTransport {
  /**
   * Streaming POST — spawns curl with -i to capture headers + stream body.
   * Used for SSE requests to Codex Responses API.
   */
  post(
    url: string,
    headers: Record<string, string>,
    body: string,
    signal?: AbortSignal,
    timeoutSec?: number,
    proxyUrl?: string | null,
  ): Promise<TlsTransportResponse> {
    return new Promise((resolve, reject) => {
      const args = [
        ...getChromeTlsArgs(),
        ...resolveProxyArgs(proxyUrl),
        "-s", "-S",
        ...(supportsCompressed() ? ["--compressed"] : []),
        "-N",            // no output buffering (SSE)
        "-i",            // include response headers in stdout
        "-X", "POST",
        "--data-binary", "@-",  // read body from stdin
      ];

      if (timeoutSec) {
        args.push("--max-time", String(timeoutSec));
      }

      pushHeaderArgs(args, headers);
      // Suppress curl's auto Expect: 100-continue (Chromium never sends it)
      args.push("-H", "Expect:");
      args.push(url);

      const child = spawn(resolveCurlBinary(), args, {
        stdio: ["pipe", "pipe", "pipe"],
      });

      // Abort handling
      const onAbort = () => {
        child.kill("SIGTERM");
      };
      if (signal) {
        if (signal.aborted) {
          child.kill("SIGTERM");
          reject(new Error("Aborted"));
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }

      // Write body to stdin then close
      child.stdin.write(body);
      child.stdin.end();

      let headerBuf = Buffer.alloc(0);
      let headersParsed = false;
      let bodyController: ReadableStreamDefaultController<Uint8Array> | null = null;

      // Header parse timeout — kill curl if headers aren't received
      const headerTimer = setTimeout(() => {
        if (!headersParsed) {
          child.kill("SIGTERM");
          reject(new Error(`curl header parse timeout after ${getHeaderTimeoutMs()}ms`));
        }
      }, getHeaderTimeoutMs());
      if (headerTimer.unref) headerTimer.unref();

      const bodyStream = new ReadableStream<Uint8Array>({
        start(c) {
          bodyController = c;
        },
        cancel() {
          child.kill("SIGTERM");
        },
      });

      child.stdout.on("data", (chunk: Buffer) => {
        if (headersParsed) {
          bodyController?.enqueue(new Uint8Array(chunk));
          return;
        }

        // Accumulate until we find \r\n\r\n header separator
        headerBuf = Buffer.concat([headerBuf, chunk]);

        // Loop to skip intermediate header blocks (CONNECT tunnel 200, 100 Continue, etc.)
        while (!headersParsed) {
          const separatorIdx = headerBuf.indexOf("\r\n\r\n");
          if (separatorIdx === -1) return; // wait for more data

          const headerBlock = headerBuf.subarray(0, separatorIdx).toString("utf-8");
          const remainder = headerBuf.subarray(separatorIdx + 4);

          const parsed = parseHeaderDump(headerBlock);

          // Skip intermediate responses: CONNECT tunnel, 1xx informational
          if (parsed.status < 200 || isConnectResponse(headerBlock)) {
            headerBuf = remainder;
            continue;
          }

          // Real response found
          headersParsed = true;
          clearTimeout(headerTimer);

          if (remainder.length > 0) {
            bodyController?.enqueue(new Uint8Array(remainder));
          }

          if (signal) {
            signal.removeEventListener("abort", onAbort);
          }

          resolve({
            status: parsed.status,
            headers: parsed.headers,
            body: bodyStream,
            setCookieHeaders: parsed.setCookieHeaders,
          });
        }
      });

      let stderrBuf = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBuf += chunk.toString();
      });

      child.on("close", (code) => {
        clearTimeout(headerTimer);
        if (signal) {
          signal.removeEventListener("abort", onAbort);
        }
        if (!headersParsed) {
          checkHttp2Fallback(stderrBuf, code);
          reject(new Error(`curl exited with code ${code}: ${stderrBuf}`));
        } else if (code !== 0 && code !== null) {
          // curl died mid-stream (e.g. connection reset, SIGPIPE) — signal error to reader
          try {
            bodyController?.error(new Error(`curl exited with code ${code} mid-stream: ${stderrBuf.trim() || "connection lost"}`));
          } catch { /* stream already closed */ }
        } else {
          bodyController?.close();
        }
      });

      child.on("error", (err) => {
        clearTimeout(headerTimer);
        if (signal) {
          signal.removeEventListener("abort", onAbort);
        }
        reject(new Error(formatSpawnError(err)));
      });
    });
  }

  /**
   * Simple GET — execFile curl, returns full body as string.
   */
  get(
    url: string,
    headers: Record<string, string>,
    timeoutSec = 30,
    proxyUrl?: string | null,
  ): Promise<{ status: number; body: string }> {
    const args = [
      ...getChromeTlsArgs(),
      ...resolveProxyArgs(proxyUrl),
      "-s", "-S",
      ...(supportsCompressed() ? ["--compressed"] : []),
      "--max-time", String(timeoutSec),
    ];

    pushHeaderArgs(args, headers);
    args.push("-H", "Expect:");
    args.push("-w", STATUS_SEPARATOR + "%{http_code}");
    args.push(url);

    return execCurl(args);
  }

  /**
   * GET with Set-Cookie header capture via -D /dev/stderr.
   * Used by warmup to establish session cookies after account import.
   */
  getWithCookies(
    url: string,
    headers: Record<string, string>,
    timeoutSec = 30,
    proxyUrl?: string | null,
  ): Promise<{ status: number; body: string; setCookieHeaders: string[] }> {
    const args = [
      ...getChromeTlsArgs(),
      ...resolveProxyArgs(proxyUrl),
      "-s", "-S",
      "-D", "/dev/stderr",
      ...(supportsCompressed() ? ["--compressed"] : []),
      "--max-time", String(timeoutSec),
    ];

    pushHeaderArgs(args, headers);
    args.push("-H", "Expect:");
    args.push("-w", STATUS_SEPARATOR + "%{http_code}");
    args.push(url);

    return execCurlWithHeaders(args);
  }

  /**
   * Simple (non-streaming) POST — execFile curl, returns full body as string.
   * Used for OAuth token exchange, device code requests, etc.
   */
  simplePost(
    url: string,
    headers: Record<string, string>,
    body: string,
    timeoutSec = 30,
    proxyUrl?: string | null,
  ): Promise<{ status: number; body: string }> {
    const args = [
      ...getChromeTlsArgs(),
      ...resolveProxyArgs(proxyUrl),
      "-s", "-S",
      ...(supportsCompressed() ? ["--compressed"] : []),
      "--max-time", String(timeoutSec),
      "-X", "POST",
    ];

    pushHeaderArgs(args, headers);
    args.push("-H", "Expect:");
    args.push("-d", body);
    args.push("-w", STATUS_SEPARATOR + "%{http_code}");
    args.push(url);

    return execCurl(args);
  }

  isImpersonate(): boolean {
    return curlIsImpersonate();
  }
}

/**
 * Format a spawn error with architecture hint for EBADARCH (-86) on macOS.
 * This commonly happens when curl-impersonate binary doesn't match the CPU arch.
 */
export function formatSpawnError(err: Error & { errno?: number; code?: string }): string {
  // errno -86 = EBADARCH (Bad CPU type in executable) on macOS
  if (err.errno === -86 || err.message.includes("-86")) {
    const binary = resolveCurlBinary();
    return (
      `curl-impersonate binary has wrong CPU architecture for this system. ` +
      `Binary: ${binary}, Host arch: ${process.arch}. ` +
      `Fix: run "npm run setup -- --force" to download the correct binary, ` +
      `or delete bin/curl-impersonate to fall back to system curl.`
    );
  }
  return `curl spawn error: ${err.message}`;
}

/** Execute curl via execFile, parse status + Set-Cookie headers from stderr (-D /dev/stderr). */
function execCurlWithHeaders(args: string[]): Promise<{ status: number; body: string; setCookieHeaders: string[] }> {
  return new Promise((resolve, reject) => {
    execFile(
      resolveCurlBinary(),
      args,
      { maxBuffer: 2 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const castErr = err as Error & { errno?: number; code?: string };
          if (castErr.errno === -86 || err.message.includes("-86")) {
            reject(new Error(formatSpawnError(castErr)));
          } else {
            const exitCode = typeof castErr.code === "string" ? parseInt(castErr.code, 10) : null;
            checkHttp2Fallback(stderr, Number.isNaN(exitCode) ? null : exitCode);
            reject(new Error(`curl failed: ${err.message} ${stderr}`));
          }
          return;
        }

        const sepIdx = stdout.lastIndexOf(STATUS_SEPARATOR);
        if (sepIdx === -1) {
          reject(new Error("curl: missing status separator in output"));
          return;
        }

        const body = stdout.slice(0, sepIdx);
        const status = parseInt(stdout.slice(sepIdx + STATUS_SEPARATOR.length), 10);

        // Parse Set-Cookie from dumped headers in stderr
        const setCookieHeaders = stderr
          .split(/\r?\n/)
          .filter((line) => /^set-cookie:/i.test(line))
          .map((line) => line.replace(/^set-cookie:\s*/i, ""));

        resolve({ status, body, setCookieHeaders });
      },
    );
  });
}

/** Execute curl via execFile and parse the status code from the output. */
function execCurl(args: string[]): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      resolveCurlBinary(),
      args,
      { maxBuffer: 2 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const castErr = err as Error & { errno?: number; code?: string };
          // Check for EBADARCH first (architecture mismatch)
          if (castErr.errno === -86 || err.message.includes("-86")) {
            reject(new Error(formatSpawnError(castErr)));
          } else {
            const exitCode = typeof castErr.code === "string" ? parseInt(castErr.code, 10) : null;
            checkHttp2Fallback(stderr, Number.isNaN(exitCode) ? null : exitCode);
            reject(new Error(`curl failed: ${err.message} ${stderr}`));
          }
          return;
        }

        const sepIdx = stdout.lastIndexOf(STATUS_SEPARATOR);
        if (sepIdx === -1) {
          reject(new Error("curl: missing status separator in output"));
          return;
        }

        const body = stdout.slice(0, sepIdx);
        const status = parseInt(stdout.slice(sepIdx + STATUS_SEPARATOR.length), 10);

        resolve({ status, body });
      },
    );
  });
}

/**
 * Resolve proxy args for curl CLI.
 * undefined → global default | null → no proxy | string → specific proxy
 */
function resolveProxyArgs(proxyUrl: string | null | undefined): string[] {
  if (proxyUrl === null) return [];
  if (proxyUrl !== undefined) return ["-x", proxyUrl];
  return getProxyArgs();
}

/** Parse HTTP response header block from curl -i output. */
function parseHeaderDump(headerBlock: string): {
  status: number;
  headers: Headers;
  setCookieHeaders: string[];
} {
  const lines = headerBlock.split("\r\n");
  let status = 0;
  const headers = new Headers();
  const setCookieHeaders: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i === 0) {
      const match = line.match(/^HTTP\/[\d.]+ (\d+)/);
      if (match) status = parseInt(match[1], 10);
      continue;
    }
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (key.toLowerCase() === "set-cookie") {
      setCookieHeaders.push(value);
    }
    headers.append(key, value);
  }

  return { status, headers, setCookieHeaders };
}

/** Detect CONNECT tunnel responses (e.g. "HTTP/1.1 200 Connection established"). */
function isConnectResponse(headerBlock: string): boolean {
  const firstLine = headerBlock.split("\r\n")[0] ?? "";
  return /connection\s+established/i.test(firstLine);
}
