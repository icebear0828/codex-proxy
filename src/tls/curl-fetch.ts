/**
 * Simple GET/POST helpers using curl-impersonate.
 *
 * Drop-in replacement for Node.js fetch() that routes through
 * curl-impersonate with Chrome TLS profile to avoid fingerprinting.
 *
 * Used for non-streaming requests (OAuth, appcast, etc.).
 */

import { execFile } from "child_process";
import { resolveCurlBinary, getChromeTlsArgs } from "./curl-binary.js";

export interface CurlFetchResponse {
  status: number;
  body: string;
  ok: boolean;
}

const STATUS_SEPARATOR = "\n__CURL_HTTP_STATUS__";

/**
 * Perform a GET request via curl-impersonate.
 */
export function curlFetchGet(url: string): Promise<CurlFetchResponse> {
  const args = [
    ...getChromeTlsArgs(),
    "-s", "-S",
    "--compressed",
    "--max-time", "30",
    "-w", STATUS_SEPARATOR + "%{http_code}",
    url,
  ];

  return execCurl(args);
}

/**
 * Perform a POST request via curl-impersonate.
 */
export function curlFetchPost(
  url: string,
  contentType: string,
  body: string,
): Promise<CurlFetchResponse> {
  const args = [
    ...getChromeTlsArgs(),
    "-s", "-S",
    "--compressed",
    "--max-time", "30",
    "-X", "POST",
    "-H", `Content-Type: ${contentType}`,
    "-d", body,
    "-w", STATUS_SEPARATOR + "%{http_code}",
    url,
  ];

  return execCurl(args);
}

function execCurl(args: string[]): Promise<CurlFetchResponse> {
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
          reject(new Error(`curl: missing status separator in output`));
          return;
        }

        const body = stdout.slice(0, sepIdx);
        const status = parseInt(stdout.slice(sepIdx + STATUS_SEPARATOR.length), 10);

        resolve({
          status,
          body,
          ok: status >= 200 && status < 300,
        });
      },
    );
  });
}
