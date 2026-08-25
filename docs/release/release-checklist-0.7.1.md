# 发布检查清单 — v0.7.1

> 对照 Task REL-002 范围 = MAINT-013 + MAINT-014 + MAINT-016（不含 MAINT-015）。
> 发布日期：2026-08-25

## 1. 变更日志完整性

| # | 检查项 | 结果 | 事实依据 |
|---|--------|------|---------|
| 1.1 | CHANGELOG.md 存在且覆盖 0.7.1 段落 | **PASS** | 新建 `CHANGELOG.md`，包含 `Added`（MAINT-014 发现增强）、`Fixed`（MAINT-013 黑名单修正 + MAINT-016 短超时）、无 breaking |
| 1.2 | 新增/变更/修复/breaking changes 各段齐全 | **PASS** | Added、Fixed、Changed、Removed、Notes 五段覆盖 |
| 1.3 | 与 commit 列表对照一致 | **PASS** | 3 个发布 commit（efeae57 MAINT-013、553eb1d MAINT-014、3339b48 MAINT-016）全部体现在 changelog；GOV-002（8bd1eb3）属治理记录，不入 changelog |
| 1.4 | 未完成功能已排除 | **PASS** | MAINT-015（client.js 文案同步）不在发布范围，changelog Notes 段已注明 |

## 2. 版本号一致性

| # | 检查项 | 结果 | 事实依据 |
|---|--------|------|---------|
| 2.1 | package.json `version` → 0.7.1 | **待更新** | 当前 `"version": "0.7.0"`，需改为 `"version": "0.7.1"` |
| 2.2 | README.md 版本声明 → 0.7.1 | **待更新** | 行 5 badge `version-0.7.0-green` → `version-0.7.1-green`（`[![version](https://img.shields.io/badge/version-0.7.0-green)](./package.json)`） |
| 2.3 | VERIFICATION.md 协议版本 → 0.7.1 | **待更新** | 行 1 标题 `v0.7.0` → `v0.7.1`（`# dsh-reasoning-level 验证协议（v0.7.0）`） |
| 2.4 | lib/index.js 注释版本引用 | **不改** | 注释中 `v0.7.0` 为功能引入版本标记（如 `// v0.7.0：一键探测固化`），语义上指该功能始于 0.7.0，不应改为 0.7.1；仅新增 `MAINT-013 起不再写入` 等版本上下文已存在于当前代码注释中 |
| 2.5 | 三处版本声明一致（package.json/README/VERIFICATION） | **见上** | 更新 package.json → README → VERIFICATION 后一致 |

## 3. Breaking Changes 标注

| # | 检查项 | 结果 | 事实依据 |
|---|--------|------|---------|
| 3.1 | 代码 diff 中是否有 breaking change | **无** | MAINT-013：probeBlacklist 字段兼容保留（零数据破坏）；MAINT-014：候选并集仅增加新候选（不改变既有行为）；MAINT-016：新参数可选（向后兼容） |
| 3.2 | CHANGELOG 已显式标注"无 breaking changes" | **PASS** | `Changed` 段首行 `无 breaking changes` |
| 3.3 | 配置迁移是否需要用户操作 | **不需要** | 所有变更 additive 或向后兼容；既有 probeBlacklist 数据安全忽略 |

## 4. 依赖更新

| # | 检查项 | 结果 | 事实依据 |
|---|--------|------|---------|
| 4.1 | dependencies 是否仍为空 | **PASS** | `"dependencies": {}`（package.json 行 39）未变更 |
| 4.2 | peerDependencies 是否仍为 `*` | **PASS** | 4 项 peer 全 `*`（行 40-44）未变更 |
| 4.3 | devDependencies 是否有变更 | **无变更** | 本次发布不涉及 devDeps 变动 |
| 4.4 | package-lock.json 是否需同步 | **不需要** | devDeps 未变，lock 无需更新 |

## 5. 回滚方案

| # | 检查项 | 结果 | 事实依据 |
|---|--------|------|---------|
| 5.1 | 回滚方案文档存在 | **PASS** | `docs/release/rollback-plan-0.7.1.md` 已创建 |
| 5.2 | 主回滚路径可执行 | **PASS** | `dsh plugin --profile <x> remove`（v0.7.0 REL-001 R0 先例，canary 实战验证） |
| 5.3 | 数据兼容说明 | **PASS** | probeEfforts 新键 remove 后惰性残留（READ ME 卸载节清理路径）；probeBlacklist 兼容保留零破坏 |
| 5.4 | tag 未通知前可撤回 | **PASS** | `git push origin :refs/tags/v0.7.1` |

## 6. 验证命令结果

| # | 检查项 | 结果 | 事实依据 |
|---|--------|------|---------|
| 6.1 | `node --check lib/index.js` | **PASS** | 已在各 MAINT commit 验证（EVD-013/015/016） |
| 6.2 | `node --check lib/client.js` | **PASS** | 同上 |
| 6.3 | `node --test` | **PASS（37/37）** | MAINT-016 最终状态 37/37（383ms），MAINT-013 29/29 → MAINT-014 34/34 → MAINT-016 37/37 逐次增量通过 |
| 6.4 | `node scripts/client-smoke.mjs` | **PASS** | 各 MAINT commit 均验证通过 |

> **注**：上述验证命令由 Coordinator 复验。本清单记录已知事实。

## 7. Feature Flag 状态

| # | 检查项 | 结果 | 事实依据 |
|---|--------|------|---------|
| 7.1 | 本次修复是否需要 Feature Flag | **不需要** | 黑名单修正/探测增强/超时优化均为默认行为修正，非灰度功能 |
| 7.2 | Kill Switch 是否需新增 | **不需要** | 既有 `enabled: false` 开关可关闭整个插件；`statsPublic` 控制端点暴露；本次无新增端点 |

## 8. 整体裁决

| # | 检查项 | 结果 |
|---|--------|------|
| 8.1 | 全部检查项通过 | **条件 PASS**（需 Coordinator 完成版本号三处同步后完全 PASS） |
| 8.2 | 阻断项 | 版本号声明同步（2.1-2.3）——非功能阻断，发布时间线内可完成 |
| 8.3 | 发布推荐 | 版本号同步后即可执行发布链：push main → annotated tag v0.7.1 → push tag → CI 观测 → GitHub Release |

---

*检查清单版本：v0.7.1 | 编制：Release Agent REL-002 | 日期：2026-08-25*
