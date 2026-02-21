/**
 * CurlCliTransport — TLS transport using curl CLI subprocess.
 *
 * Extracted from codex-api.ts (curlPost) and curl-fetch.ts (execCurl).
 * Supports both streaming POST (SSE) and simple GET/POST.
 *
 * Used on macOS/Linux (curl-impersonate CLI) and as fallback on Windows (system curl).
 */

import { spawn, execFile } from "child_process";
import { resolveCurlBinary, getChromeTlsArgs, getProxyArgs, isImpersonate as curlIsImpersonate } from "./curl-binary.js";
import type { TlsTransport, TlsTransportResponse } from "./transport.js";

const STATUS_SEPARATOR = "\n__CURL_HTTP_STATUS__";
const HEADER_TIMEOUT_MS = 30_000;

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
  ): Promise<TlsTransportResponse> {
    return new Promise((resolve, reject) => {
      const args = [
        ...getChromeTlsArgs(),
        ...getProxyArgs(),
        "-s", "-S",
        "--compressed",
        "-N",            // no output buffering (SSE)
        "-i",            // include response headers in stdout
        "-X", "POST",
        "--data-binary", "@-",  // read body from stdin
      ];

      if (timeoutSec) {
        args.push("--max-time", String(timeoutSec));
      }

      for (const [key, value] of Object.entries(headers)) {
        args.push("-H", `${key}: ${value}`);
      }
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
          reject(new Error(`curl header parse timeout after ${HEADER_TIMEOUT_MS}ms`));
        }
      }, HEADER_TIMEOUT_MS);
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
        const separatorIdx = headerBuf.indexOf("\r\n\r\n");
        if (separatorIdx === -1) return;

        headersParsed = true;
        clearTimeout(headerTimer);
        const headerBlock = headerBuf.subarray(0, separatorIdx).toString("utf-8");
        const remaining = headerBuf.subarray(separatorIdx + 4);

        const { status, headers: parsedHeaders, setCookieHeaders } = parseHeaderDump(headerBlock);

        if (remaining.length > 0) {
          bodyController?.enqueue(new Uint8Array(remaining));
        }

        if (signal) {
          signal.removeEventListener("abort", onAbort);
        }

        resolve({
          status,
          headers: parsedHeaders,
          body: bodyStream,
          setCookieHeaders,
        });
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
          reject(new Error(`curl exited with code ${code}: ${stderrBuf}`));
        }
        bodyController?.close();
      });

      child.on("error", (err) => {
        clearTimeout(headerTimer);
        if (signal) {
          signal.removeEventListener("abort", onAbort);
        }
        reject(new Error(`curl spawn error: ${err.message}`));
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
  ): Promise<{ status: number; body: string }> {
    const args = [
      ...getChromeTlsArgs(),
      ...getProxyArgs(),
      "-s", "-S",
      "--compressed",
      "--max-time", String(timeoutSec),
    ];

    for (const [key, value] of Object.entries(headers)) {
      args.push("-H", `${key}: ${value}`);
    }
    args.push("-H", "Expect:");
    args.push("-w", STATUS_SEPARATOR + "%{http_code}");
    args.push(url);

    return execCurl(args);
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
  ): Promise<{ status: number; body: string }> {
    const args = [
      ...getChromeTlsArgs(),
      ...getProxyArgs(),
      "-s", "-S",
      "--compressed",
      "--max-time", String(timeoutSec),
      "-X", "POST",
    ];

    for (const [key, value] of Object.entries(headers)) {
      args.push("-H", `${key}: ${value}`);
    }
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

/** Execute curl via execFile and parse the status code from the output. */
function execCurl(args: string[]): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      resolveCurlBinary(),
      args,
      { maxBuffer: 2 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`curl failed: ${err.message} ${stderr}`));
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
