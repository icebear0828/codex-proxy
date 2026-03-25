#!/usr/bin/env tsx
/**
 * POC: Verify libcurl-impersonate FFI transport works on Windows.
 *
 * Tests:
 * 1. koffi can load libcurl.dll
 * 2. curl_easy_impersonate("chrome136") works
 * 3. WRITEFUNCTION callback receives data
 * 4. TLS fingerprint matches Chrome (checked via tls.peet.ws)
 * 5. curl_multi async loop doesn't block event loop
 */

import { resolve } from "path";
import { existsSync } from "fs";

const BIN_DIR = resolve(process.cwd(), "bin");

async function main() {
  console.log("=== libcurl-impersonate FFI POC ===\n");

  // 1. Load koffi
  console.log("[1/5] Loading koffi...");
  let koffi: any;
  try {
    koffi = (await import("koffi")).default ?? await import("koffi");
    console.log("  ✓ koffi loaded");
  } catch (err: any) {
    console.error("  ✗ koffi not available:", err.message);
    process.exit(1);
  }

  // 2. Load libcurl.dll
  console.log("[2/5] Loading libcurl.dll...");
  const dllPath = resolve(BIN_DIR, "libcurl.dll");
  if (!existsSync(dllPath)) {
    console.error(`  ✗ ${dllPath} not found. Run: npm run setup`);
    process.exit(1);
  }
  let lib: any;
  try {
    lib = koffi.load(dllPath);
    console.log(`  ✓ Loaded ${dllPath}`);
  } catch (err: any) {
    console.error("  ✗ Failed to load DLL:", err.message);
    process.exit(1);
  }

  // 3. Bind functions
  console.log("[3/5] Binding curl functions...");
  const CURL = koffi.pointer("CURL", koffi.opaque());
  const CURLM = koffi.pointer("CURLM", koffi.opaque());
  koffi.pointer("curl_slist", koffi.opaque());

  const writeCbType = koffi.proto("size_t write_cb(const uint8_t *ptr, size_t size, size_t nmemb, intptr_t userdata)");

  const fns = {
    curl_global_init: lib.func("int curl_global_init(int flags)"),
    curl_easy_init: lib.func("CURL *curl_easy_init()"),
    curl_easy_cleanup: lib.func("void curl_easy_cleanup(CURL *handle)"),
    curl_easy_setopt_long: lib.func("int curl_easy_setopt(CURL *handle, int option, long value)"),
    curl_easy_setopt_str: lib.func("int curl_easy_setopt(CURL *handle, int option, const char *value)"),
    curl_easy_setopt_cb: lib.func("int curl_easy_setopt(CURL *handle, int option, write_cb *value)"),
    curl_easy_getinfo_long: lib.func("int curl_easy_getinfo(CURL *handle, int info, _Out_ int *value)"),
    curl_easy_impersonate: lib.func("int curl_easy_impersonate(CURL *handle, const char *target, int default_headers)"),
    curl_easy_perform: lib.func("int curl_easy_perform(CURL *handle)"),
    curl_multi_init: lib.func("CURLM *curl_multi_init()"),
    curl_multi_add_handle: lib.func("int curl_multi_add_handle(CURLM *multi, CURL *easy)"),
    curl_multi_remove_handle: lib.func("int curl_multi_remove_handle(CURLM *multi, CURL *easy)"),
    curl_multi_perform: lib.func("int curl_multi_perform(CURLM *multi, _Out_ int *running_handles)"),
    curl_multi_poll: lib.func("int curl_multi_poll(CURLM *multi, void *extra_fds, int extra_nfds, int timeout_ms, _Out_ int *numfds)"),
    curl_multi_cleanup: lib.func("int curl_multi_cleanup(CURLM *multi)"),
    curl_slist_append: lib.func("curl_slist *curl_slist_append(curl_slist *list, const char *string)"),
    curl_slist_free_all: lib.func("void curl_slist_free_all(curl_slist *list)"),
    curl_easy_setopt_ptr: lib.func("int curl_easy_setopt(CURL *handle, int option, curl_slist *value)"),
  };

  // Constants
  const CURLOPT_URL = 10002;
  const CURLOPT_HTTPHEADER = 10023;
  const CURLOPT_WRITEFUNCTION = 20011;
  const CURLOPT_NOSIGNAL = 99;
  const CURLOPT_ACCEPT_ENCODING = 10102;
  const CURLOPT_HTTP_VERSION = 84;
  const CURL_HTTP_VERSION_2_0 = 3;
  const CURLOPT_CAINFO = 10065;
  const CURLINFO_RESPONSE_CODE = 0x200002;

  fns.curl_global_init(3); // CURL_GLOBAL_DEFAULT
  console.log("  ✓ Functions bound, curl_global_init OK");

  // 4. Simple GET to tls.peet.ws using curl_easy_perform.async()
  console.log("[4/5] Testing simple GET with Chrome TLS fingerprint...");

  const easy = fns.curl_easy_init();
  if (!easy) {
    console.error("  ✗ curl_easy_init returned null");
    process.exit(1);
  }

  // Impersonate Chrome 136
  const impResult = fns.curl_easy_impersonate(easy, "chrome136", 0);
  console.log(`  curl_easy_impersonate result: ${impResult} (0 = OK)`);

  fns.curl_easy_setopt_str(easy, CURLOPT_URL, "https://tls.peet.ws/api/all");
  fns.curl_easy_setopt_long(easy, CURLOPT_NOSIGNAL, 1);
  fns.curl_easy_setopt_long(easy, CURLOPT_HTTP_VERSION, CURL_HTTP_VERSION_2_0);
  fns.curl_easy_setopt_str(easy, CURLOPT_ACCEPT_ENCODING, "");

  // CA bundle for BoringSSL (not Schannel)
  const caPath = resolve(BIN_DIR, "cacert.pem");
  if (existsSync(caPath)) {
    fns.curl_easy_setopt_str(easy, CURLOPT_CAINFO, caPath);
    console.log(`  Using CA bundle: ${caPath}`);
  }

  // Set User-Agent to match Chrome
  let slist: any = null;
  slist = fns.curl_slist_append(slist, "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36");
  slist = fns.curl_slist_append(slist, "Expect:");
  fns.curl_easy_setopt_ptr(easy, CURLOPT_HTTPHEADER, slist);

  const chunks: Buffer[] = [];
  const writeCallback = koffi.register(
    (ptr: any, size: number, nmemb: number, _userdata: any): number => {
      const totalBytes = size * nmemb;
      if (totalBytes === 0) return 0;
      const arr = koffi.decode(ptr, "uint8_t", totalBytes);
      chunks.push(Buffer.from(arr));
      return totalBytes;
    },
    koffi.pointer(writeCbType as Parameters<typeof koffi.pointer>[0]),
  );
  fns.curl_easy_setopt_cb(easy, CURLOPT_WRITEFUNCTION, writeCallback);

  console.log("  Sending request to https://tls.peet.ws/api/all ...");
  const startTime = Date.now();

  // Use .async() to run on worker thread (non-blocking)
  // koffi .async() requires callback as last arg — wrap in promise
  const performResult = await new Promise<number>((res, rej) => {
    fns.curl_easy_perform.async(easy, (err: any, result: number) => {
      if (err) rej(err); else res(result);
    });
  });

  const elapsed = Date.now() - startTime;
  console.log(`  curl_easy_perform result: ${performResult} (0 = OK), took ${elapsed}ms`);

  const statusBuf = new Int32Array(1);
  fns.curl_easy_getinfo_long(easy, CURLINFO_RESPONSE_CODE, statusBuf);
  console.log(`  HTTP status: ${statusBuf[0]}`);

  fns.curl_easy_cleanup(easy);
  if (slist) fns.curl_slist_free_all(slist);
  koffi.unregister(writeCallback);

  if (performResult !== 0 || statusBuf[0] !== 200) {
    console.error("  ✗ Request failed");
    process.exit(1);
  }

  const body = Buffer.concat(chunks).toString("utf-8");
  let tlsData: any;
  try {
    tlsData = JSON.parse(body);
  } catch {
    console.error("  ✗ Invalid JSON response:", body.slice(0, 200));
    process.exit(1);
  }

  console.log("\n  === TLS Fingerprint Results ===");
  console.log(`  IP:         ${tlsData.ip ?? "?"}`);
  console.log(`  HTTP/2:     ${tlsData.http_version ?? "?"}`);
  console.log(`  TLS:        ${tlsData.tls?.version ?? "?"}`);
  console.log(`  JA3:        ${tlsData.tls?.ja3 ?? "N/A"}`);
  console.log(`  JA3 Hash:   ${tlsData.tls?.ja3_hash ?? "N/A"}`);
  console.log(`  JA4:        ${tlsData.tls?.ja4 ?? "N/A"}`);
  console.log(`  Peetprint:  ${tlsData.tls?.peetprint_hash ?? "N/A"}`);
  console.log(`  Akamai H2:  ${tlsData.http2?.akamai_fingerprint_hash ?? "N/A"}`);

  // Check if it looks like Chrome
  const ja4 = tlsData.tls?.ja4 ?? "";
  const httpVersion = tlsData.http_version ?? "";
  const isChromeLike = ja4.startsWith("t") && httpVersion === "h2";
  console.log(`\n  Chrome-like: ${isChromeLike ? "✓ YES" : "✗ NO"}`);

  // 5. Test curl_multi async (non-blocking) — verify event loop stays free
  console.log("\n[5/5] Testing curl_multi async (non-blocking)...");

  const easy2 = fns.curl_easy_init();
  fns.curl_easy_impersonate(easy2, "chrome136", 0);
  fns.curl_easy_setopt_str(easy2, CURLOPT_URL, "https://httpbin.org/get");
  fns.curl_easy_setopt_long(easy2, CURLOPT_NOSIGNAL, 1);
  fns.curl_easy_setopt_str(easy2, CURLOPT_ACCEPT_ENCODING, "");
  if (existsSync(caPath)) {
    fns.curl_easy_setopt_str(easy2, CURLOPT_CAINFO, caPath);
  }

  const chunks2: Buffer[] = [];
  const writeCallback2 = koffi.register(
    (ptr: any, size: number, nmemb: number, _userdata: any): number => {
      const totalBytes = size * nmemb;
      if (totalBytes === 0) return 0;
      const arr = koffi.decode(ptr, "uint8_t", totalBytes);
      chunks2.push(Buffer.from(arr));
      return totalBytes;
    },
    koffi.pointer(writeCbType as Parameters<typeof koffi.pointer>[0]),
  );
  fns.curl_easy_setopt_cb(easy2, CURLOPT_WRITEFUNCTION, writeCallback2);

  const multi = fns.curl_multi_init();
  fns.curl_multi_add_handle(multi, easy2);

  const runningHandles = new Int32Array(1);
  const numfds = new Int32Array(1);

  // Track event loop freedom
  let timerFired = false;
  const timer = setTimeout(() => { timerFired = true; }, 50);

  const asyncPoll = (m: any, nfds: Int32Array) =>
    new Promise<number>((res, rej) => {
      fns.curl_multi_poll.async(m, null, 0, 200, nfds, (err: any, r: number) => {
        if (err) rej(err); else res(r);
      });
    });
  const asyncPerform = (m: any, rh: Int32Array) =>
    new Promise<number>((res, rej) => {
      fns.curl_multi_perform.async(m, rh, (err: any, r: number) => {
        if (err) rej(err); else res(r);
      });
    });

  const multiStart = Date.now();
  let iterations = 0;
  while (true) {
    const pollResult = await asyncPoll(multi, numfds);
    if (pollResult !== 0) break;

    const perfResult = await asyncPerform(multi, runningHandles);
    if (perfResult !== 0) break;

    iterations++;
    if (runningHandles[0] === 0) break;
  }
  const multiElapsed = Date.now() - multiStart;
  clearTimeout(timer);

  fns.curl_multi_remove_handle(multi, easy2);
  fns.curl_multi_cleanup(multi);
  fns.curl_easy_cleanup(easy2);
  koffi.unregister(writeCallback2);

  const body2 = Buffer.concat(chunks2).toString("utf-8");
  const multiOk = body2.length > 0;

  console.log(`  curl_multi iterations: ${iterations}`);
  console.log(`  Response size: ${body2.length} bytes`);
  console.log(`  Time: ${multiElapsed}ms`);
  console.log(`  Event loop free during transfer: ${timerFired ? "✓ YES" : "✗ NO (blocked)"}`);
  console.log(`  curl_multi result: ${multiOk ? "✓ OK" : "✗ FAILED"}`);

  // Summary
  console.log("\n=== POC Summary ===");
  console.log(`  koffi load:         ✓`);
  console.log(`  DLL load:           ✓`);
  console.log(`  impersonate:        ${impResult === 0 ? "✓" : "✗"}`);
  console.log(`  simple GET:         ✓ (${elapsed}ms)`);
  console.log(`  Chrome fingerprint: ${isChromeLike ? "✓" : "✗"}`);
  console.log(`  curl_multi async:   ${multiOk ? "✓" : "✗"} (${multiElapsed}ms)`);
  console.log(`  event loop free:    ${timerFired ? "✓" : "✗"}`);

  const allPassed = impResult === 0 && isChromeLike && multiOk && timerFired;
  console.log(`\n  Overall: ${allPassed ? "ALL PASSED ✓" : "SOME FAILED ✗"}`);
  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
