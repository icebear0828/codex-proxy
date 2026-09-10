// 用法: node .github/scripts/sync-package-version.mjs 2.1.7[-beta.1]
//
// 幂等地把新版本写入 package.json 顶层、package-lock.json 顶层以及根
// workspace 入口（packages[""].version）。仅改版本字段，保留依赖/workspaces
// 等其余内容。由 bump-electron.yml 在稳定发版打 tag 后调用。
import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version ?? "")) {
  console.error(`usage: sync-package-version.mjs <x.y.z[-prerelease]> (got "${version ?? ""}")`);
  process.exit(2);
}

for (const f of ["package.json", "package-lock.json"]) {
  const json = JSON.parse(readFileSync(f, "utf8"));
  json.version = version;
  if (f === "package-lock.json" && json.packages?.[""]) {
    json.packages[""].version = version; // 根 workspace 入口
  }
  // 保持 2 空格缩进 + 末尾换行，与现有文件格式一致
  writeFileSync(f, `${JSON.stringify(json, null, 2)}\n`);
}
