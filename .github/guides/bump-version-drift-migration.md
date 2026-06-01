# Bump version 漂移根治方案（stable bump → tag-only）

> 状态：proposal（待评估，未实施）
> 背景事故：2026-06-01，promote-dev→master 因 fast-forward 前提被破坏，静默失败约 3 周。
> 已落地的相关修复：PR #616（`-s ours` reconcile 恢复 ff 前提）、#617（promote 失败告警）、#618（拔根删 `sync-changelog.yml`，消除**主**漂移源）。
> 本方案处理**残留的第二漂移源**：`bump-electron.yml` 的 version bump commit。

## 1. 问题

`bump-electron.yml`（master 分支，cron 16:00 UTC）每次 stable 发版时在 master 上：

```
写 package.json / package-lock.json / packages/electron/package.json 的 version
→ git commit "chore: bump version to X.Y.Z [skip ci]"
→ git tag vX.Y.Z + push --follow-tags
→ git push origin master:dev          # "Sync bump commit back to dev (FF)"
→ trigger release.yml + docker-publish
```

第 4 步是 **FF push**，而 `dev` 几乎总是领先 `master`（持续接 PR）→ FF **必然被拒**，workflow 里只 `::warning::` 不报错。于是每次 stable 发版都给 master 留下一个**回不去 dev 的 commit**，下次 `promote-dev-to-master.yml` 的 `git merge-base --is-ancestor origin/master origin/dev` 失败 → promote 卡死 “manual rebase needed”。

这是 2026-06-01 事故的第二根因（主因 `sync-changelog.yml` 已由 #618 拔根）。

## 2. 根本原因

stable bump **在 master 单边产生 commit**。master 上任何独立 commit 都无法 FF 回领先的 dev，只能 reconcile。对称地看：`bump-electron-beta.yml`（dev，04:00/12:00）**只打 tag、不写 package.json、零 commit**，所以 beta 链路从不造成漂移。差异仅在于 stable bump 多做了一次 package.json commit。

## 3. 关键事实（已验证，非推断）

发版/打包/auto-update **不依赖仓库里 commit 的 package.json version**：

- `release.yml`（line 125 / 286）打包时用 `--config.extraMetadata.version="$VERSION"`，`VERSION` 从 **tag** 读取，覆盖打包产物的 version。
- Electron 运行时 `app.getVersion()` 读的是**打包进 app** 的 `packages/electron/package.json` version（= 被 extraMetadata 覆盖的 tag 版本）。
- `auto-updater.ts` 走 electron-updater 的 `checkForUpdates()`，比对的“当前版本”即上面的 `app.getVersion()`。

结论：stable bump 那个 `chore: bump version` commit **对发布产物零作用**，纯噪音 commit。beta 链路已证明 tag-only 模式可正常发版。

## 4. 方案 A：stable bump 改为 tag-only（推荐，对称 beta）

让 stable bump 像 beta 一样**只打 tag、不 commit package.json**。

### `bump-electron.yml` 改动点

1. **删除** “Bump version + tag” 步骤里写 `package.json` / `package-lock.json` / `packages/electron/package.json` + `git commit` + `git push master --follow-tags` 的 commit 部分；只保留 `git tag -a vX.Y.Z -m ...` + `git push origin <tag>`。
2. **删除** “Sync bump commit back to dev (FF)” 整个步骤（没有 commit 要回流了）。
3. 版本计算（`check` 步骤）：patch 改为**纯从 last stable tag 自增**（`vX.Y.{patch+1}`）；series（major.minor）仍从 `package.json` 读取——该 package.json 由 promote 从 dev 带来，**不在 master 单独修改**。
4. `release.yml` / `docker-publish` 触发不变。

### 结果

master 不再产生任何 bump commit → 第二漂移源消除 → promote ff 前提长期稳定。

## 5. package.json version 字段的真实作用（tag-only 后如何保留）

| 作用 | tag-only 后 | 影响 |
|------|------------|------|
| 打包产物版本 / auto-update 比对 | 由 `extraMetadata.version`（tag）注入 | ✅ 不依赖仓库 commit，正确 |
| `bump-electron` 算 series（major.minor） | 读 package.json；**开发者在 dev 手动 bump major.minor 声明新 series**，随 promote 到 master | ✅ 不产生 master-only commit |
| `bump-electron-beta` 算 NEXT_BASE | 已有 `isPkgGreater` 逻辑：package.json 与 last-stable-tag 取大，patch 停更后自动落到 tag+1 | ✅ 逻辑已兼容 |

即：**package.json 的 patch 字段不再被 bump 维护（停在旧值），实际 patch 完全由 tag 决定；major.minor 仍由开发者在 dev 手动 bump 声明 series**。仓库 package.json 的 patch 会“过时”，但只影响开发态 `npm start` 的 `app.getVersion()` 显示，不影响任何发布产物。

## 6. 风险 / 上线前必须验证项

1. **series 升级路径**：确认开发者在 dev 手动改 major.minor（随 promote 到 master）后，`bump-electron` 的 `check` 能以新 series 起 `.0`（保留并测试现有 “new series → start at .0” 分支）。
2. **beta NEXT_BASE 在 patch 停更后的行为**：patch 长期落后时，beta 仍应取 `last-stable-tag-patch+1`；用真实数据跑 `node -e` 那段确认 `isPkgGreater=false` 分支生效。
3. **开发态版本显示过时**：`npm start` 本地 `app.getVersion()` 会显示旧 patch；可接受，若在意可在 dev 偶尔同步 patch（非必须）。
4. **package-lock.json version 停更**：顶层 `version` 字段过时，不影响 `npm ci` 依赖解析（非关键字段）。

## 7. 测试 / 验证计划（遵守 E2E 红线，mock 绿 ≠ 完成）

- workflow 改动先用 `act` 或在分支 `workflow_dispatch` dry-run，确认 tag 计算正确、不产生 commit、不 push master。
- **真实发一次 beta + 一次 stable**，验证：① 产物 version = tag ② auto-update 能从旧版本检测并实际升级 ≥1 次 ③ 发版后 `git log origin/dev..origin/master` 为空（不再漂移）。
- 观察次日 promote 自动跑通，ff 前提保持。

## 8. 备选方案 B：version 移到 dev 维护

在 dev 上 bump package.json + commit，promote 带到 master，bump-electron 在 master 只打 tag。比 A 多保留“仓库 version 始终最新”的好处，但需决定 dev 上谁/何时 bump patch（每次发版前？），引入额外 dev commit 与时序耦合。**A 更简洁、对称 beta、改动最小**，推荐 A。

## 9. 回滚

纯 workflow 改动，`git revert` 即可恢复旧 bump 行为；已打的 tag 不受影响。

## 参考

- 记忆：`infra/release-flow.md` insight #1（sync-back 命门 + FF sync-back 对领先 dev 注定失败）
- 相关 workflow：`.github/workflows/bump-electron.yml`、`bump-electron-beta.yml`、`promote-dev-to-master.yml`、`release.yml`
