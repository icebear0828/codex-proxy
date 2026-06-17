/**
 * Tees process.stdout / process.stderr writes into a daily log file.
 *
 * Used in dev so terminal scrollback isn't the only place errors live.
 * Production stays pure stdout/stderr — log shippers handle persistence there.
 */

import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";

export interface InstallFileLoggerOptions {
  dir: string;
  filename?: string;
}

export interface FileLoggerHandle {
  path: string;
  uninstall(): void;
}

type WriteFn = typeof process.stdout.write;

export function installFileLogger(opts: InstallFileLoggerOptions): FileLoggerHandle {
  mkdirSync(opts.dir, { recursive: true });
  const filename = opts.filename ?? defaultFilename(new Date());
  const path = join(opts.dir, filename);
  const fd = openSync(path, "a");

  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;

  process.stdout.write = wrap(originalStdout, process.stdout, fd);
  process.stderr.write = wrap(originalStderr, process.stderr, fd);

  let uninstalled = false;

  return {
    path,
    uninstall(): void {
      if (uninstalled) return;
      uninstalled = true;
      process.stdout.write = originalStdout;
      process.stderr.write = originalStderr;
      try {
        closeSync(fd);
      } catch {
        // best-effort: closing twice or after process tear-down is harmless
      }
    },
  };
}

function wrap(original: WriteFn, stream: NodeJS.WriteStream, fd: number): WriteFn {
  const wrapped = function (this: unknown, ...args: unknown[]): boolean {
    try {
      const chunk = args[0];
      const encoding =
        typeof args[1] === "string" ? (args[1] as BufferEncoding) : undefined;
      writeSync(fd, toBuffer(chunk, encoding));
    } catch {
      // never let the file sink break the caller — stdout/stderr must stay live
    }
    return (original as (...a: unknown[]) => boolean).apply(stream, args);
  };
  return wrapped as WriteFn;
}

function toBuffer(chunk: unknown, encoding: BufferEncoding | undefined): Buffer {
  if (typeof chunk === "string") {
    return Buffer.from(chunk, encoding ?? "utf8");
  }
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk);
  }
  return Buffer.from(String(chunk));
}

function defaultFilename(date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `dev-${yyyy}-${mm}-${dd}.log`;
}
