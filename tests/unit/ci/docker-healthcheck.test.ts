import { afterAll, beforeAll, expect, it } from "vitest";
import { describePosix } from "@helpers/platform-test.js";
import { spawn } from "child_process";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";

let server: Server;
let responseStatus = 200;
let serverPort: number;

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.statusCode = responseStatus;
    res.setHeader("content-type", "application/json");
    res.end('{"status":"ok"}');
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      serverPort = (server.address() as AddressInfo).port;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => err ? reject(err) : resolve());
  });
});

function runHealthcheck(): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["docker-healthcheck.sh"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HTTP_PROXY: "http://127.0.0.1:9",
        HTTPS_PROXY: "http://127.0.0.1:9",
        ALL_PROXY: "http://127.0.0.1:9",
        http_proxy: "http://127.0.0.1:9",
        https_proxy: "http://127.0.0.1:9",
        all_proxy: "http://127.0.0.1:9",
        NO_PROXY: "",
        no_proxy: "",
        PORT: String(serverPort),
      },
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  });
}

describePosix("docker-healthcheck.sh", () => {
  it("bypasses proxy variables for the local health endpoint", async () => {
    responseStatus = 200;
    await expect(runHealthcheck()).resolves.toBe(0);
  });

  it("returns a failure when the local health endpoint is unhealthy", async () => {
    responseStatus = 503;
    await expect(runHealthcheck()).resolves.not.toBe(0);
  });
});
