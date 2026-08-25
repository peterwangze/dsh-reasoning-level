# 发布检查清单 — v0.7.2

> 对照 Task REL-003 范围 = MAINT-017 + MAINT-015（DEC-013；不含 MAINT-018/019/020）。
> 发布日期：2026-08-26

## 0. 范围一致性（DEC-013）

| # | 检查项 | 结果 | 事实依据 |
|---|--------|------|---------|
| 0.1 | 发布范围与 DEC-013 一致 | **PASS** | 范围 = MAINT-017（通用 7 档词汇表 + 临时声明→实测→固化收敛 + 黑名单文案等）+ MAINT-015（client.js 4 处 i18n 文案对齐 MAINT-013 新语义）；MAINT-015 已并入 MAINT-017 交付（commit 829eaa3，EVD-019） |
| 0.2 | 范围外事项已排除 | **PASS** | MAINT-018（主动探测演进，0.7.3+）、MAINT-019（R1 P2-1~3 建议，0.7.3）、MAINT-020（R1 P3-1~4 记录，0.7.3）不在本次发布；CHANGELOG Notes 已注明 |
| 0.3 | 未完成功能已排除 | **PASS** | 4 个发布 commit 全部为已审查闭环功能（REVIEW-MAINT-017-R1 APPROVED_WITH_NOTES/0）；用户环境实测验收（M7.7）为发布后用户自验项，非发布阻断 |

## 1. 变更日志完整性

| # | 检查项 | 结果 | 事实依据 |
|---|--------|------|---------|
| 1.1 | CHANGELOG.md 存在且覆盖 0.7.2 段落 | **PASS** | 新建 0.7.2 段落：`Added`（MAINT-017 通用 7 档词汇表）、`Fixed`（MAINT-017 探测等级发现修复 + MAINT-015 黑名单文案）、无 breaking |
| 1.2 | 新增/变更/修复/breaking changes 各段齐全 | **PASS** | Added、Fixed、Changed、Removed、Notes 五段覆盖 |
| 1.3 | 与 commit 列表对照一致 | **PASS** | 4 个功能 commit（6db5993 F1+F3 / 78fd5e1 F2+F5 / b2526a7 F4 README-VERIFICATION 文档 / 829eaa3 MAINT-015 文案+R0 收尾，基线上限 4978114=v0.7.1）全部体现在 changelog；版本号同步与发布资产 commit 属发布资产（0.7.1 先例 a50aa03/4978114），不入功能条目 |
| 1.4 | 0.7.1/0.7.0 段落保留不动 | **PASS** | 仅插入 0.7.2 段落于顶部，历史段落逐字未改 |
| 1.5 | 已知问题已列出 | **PASS** | MAINT-019（P2-1 isFullVocabShape 形状判定/P2-2 收敛计数文案/P2-3 levelsFilter 收敛）与 MAINT-020（P3-1~4 记录级）已入账 0.7.3，CHANGELOG Notes 注明 |

## 2. 版本号一致性

| # | 检查项 | 结果 | 事实依据 |
|---|--------|------|---------|
| 2.1 | package.json `version` → 0.7.2 | **待同步** | 当前 `"version": "0.7.1"`（package.json:4）——Developer 并行执行 0.7.1→0.7.2 同步（REL-003 任务上下文），完成后为 **PASS** |
| 2.2 | README.md 版本声明 → 0.7.2 | **待同步** | 行 5 badge `version-0.7.1-green` → `version-0.7.2-green`；同上 |
| 2.3 | VERIFICATION.md 协议版本 → v0.7.2 | **待同步** | 行 1 标题 `验证协议（v0.7.1）` → `（v0.7.2）`；同上 |
| 2.4 | lib/index.js 注释版本引用 | **不改** | README:38/39、VERIFICATION:73 的 `v0.7.0/v0.7.1` 为功能引入标记，不应改为 0.7.2（0.7.1 先例 checklist 2.4） |
| 2.5 | 版本号 semver 合规（PATCH） | **PASS** | 0.7.1→0.7.2：PATCH——本次为修复性发布（探测等级发现修复 + 文案修正），无新功能 API、无 breaking、无依赖更新；bump 理由充分（先例 REL-002 结构） |
| 2.6 | 三处版本声明同步后一致 | **见 2.1-2.3** | Developer 版本号同步 commit 完成后一致 |

## 3. Breaking Changes 标注

| # | 检查项 | 结果 | 事实依据 |
|---|--------|------|---------|
| 3.1 | 代码 diff 中是否有 breaking change | **无** | 词汇表新增 xhigh 档为 additive（`LEVELS` 为 `THINKING_LEVEL_VOCABULARY` 兼容别名，lib/index.js:75-77）；手写声明保 wire 并入语义（不覆盖既有声明）；probeBlacklist 字段兼容保留（零数据破坏）；probeEfforts 键语义不变 |
| 3.2 | CHANGELOG 已显式标注"无 breaking changes" | **PASS** | `Changed` 段首行 `无 breaking changes` |
| 3.3 | 配置迁移是否需要用户操作 | **不需要** | 所有变更 additive 或向后兼容；既有 probeBlacklist 数据安全忽略 |

## 4. 依赖更新

| # | 检查项 | 结果 | 事实依据 |
|---|--------|------|---------|
| 4.1 | dependencies 是否仍为空 | **PASS** | `"dependencies": {}`（package.json:39）未变更 |
| 4.2 | peerDependencies 是否仍为 `*` | **PASS** | 4 项 peer 全 `*`（package.json:40-45）未变更 |
| 4.3 | devDependencies 是否有变更 | **无变更** | devDeps（package.json:46-50）未变 |
| 4.4 | package-lock.json 是否需同步 | **不需要** | devDeps 未变，lock 无需更新 |

## 5. 审查证据

| # | 检查项 | 结果 | 事实依据 |
|---|--------|------|---------|
| 5.1 | 产品代码变更后置独立审查通过 | **PASS** | REVIEW-MAINT-017-R1 **APPROVED_WITH_NOTES unresolved_blockers=0**（0 P0/P1；3 P2+4 P3 登记 MAINT-019/020；corresponding review record `.governance/review-MAINT-017-R1.md`） |
| 5.2 | 审查返工闭环 | **PASS** | R0 NEEDS_CHANGE（F1/F2 P1 + F3/F4/F5 P2，REVIEW-MAINT-017-R0）→ Developer 返工 → R1 复审（全部"已修复"独立证据 + 6 新真实可失败测试核验） |
| 5.3 | 被审查功能与发布范围一致 | **PASS** | 审查对象 = MAINT-017 + MAINT-015 全部 4 commit（EVD-019）；无未审查范围内的代码进入发布 |

## 6. 验证命令结果

| # | 检查项 | 结果 | 事实依据 |
|---|--------|------|---------|
| 6.1 | `node --check lib/index.js` | **PASS** | exit 0（EVD-019） |
| 6.2 | `node --check lib/client.js` | **PASS** | exit 0（EVD-019） |
| 6.3 | `node --test` | **PASS（43/43）** | 60.2s，fail 0（R0 37 + 新增 6：F1×2/F2×1/F3×2/F5×1，全部真实可失败断言；并发 3 连跑 3/3 通过） |
| 6.4 | `node scripts/client-smoke.mjs` | **PASS** | client-smoke: OK — 4 components（exit 0，EVD-019） |
| 6.5 | 代码健康 | **PASS** | lib/ 无 mock/硬编码/TODO 残留；工作树干净（EVD-019） |

> **注**：上述验证命令结果来自 EVD-019（各 MAINT commit 均由 Coordinator 复验）。本清单记录已知事实。

## 7. 回滚方案

| # | 检查项 | 结果 | 事实依据 |
|---|--------|------|---------|
| 7.1 | 回滚方案文档存在 | **PASS** | `docs/release/rollback-plan-0.7.2.md` 已创建 |
| 7.2 | 主回滚路径可执行 | **PASS** | `dsh plugin --profile <x> remove`（0.7.1 REL-002 先例主路径，canary 实战验证；含重启 + 金丝雀冒烟验证 + 时间预算） |
| 7.3 | 数据兼容说明 | **PASS** | 向前：probeBlacklist 兼容保留零破坏、probeEfforts 键兼容、xhigh 为 additive 新增档；向后：能力声明惰性残留（卸载重启失效）、xhigh 值清理路径已写明 |
| 7.4 | tag 未通知前可撤回 | **PASS** | `git push origin :refs/tags/v0.7.2` + 本地 `git tag -d v0.7.2` |

## 8. Feature Flag 状态

| # | 检查项 | 结果 | 事实依据 |
|---|--------|------|---------|
| 8.1 | 本次修复是否需要 Feature Flag | **不需要** | 词汇表+探测收敛/文案修正均为默认行为修正，非灰度功能 |
| 8.2 | Kill Switch 是否需新增 | **不需要** | 既有 `enabled: false` 开关可关闭整个插件；`statsPublic` 控制端点暴露；本次无新增端点 |

## 9. CI 预期（发布链观测）

| # | 检查项 | 结果 | 事实依据 |
|---|--------|------|---------|
| 9.1 | push main 后 CI check job success 预期 | **预期 PASS** | 0.7.1 先例：main push 32828553473 check+release 双 success（EVD-018）；本次 push = 4 功能 commit + 版本号同步 + 发布资产 commit |
| 9.2 | tag push 后 CI check+release 双 job success 预期 | **预期 PASS** | 0.7.1 先例：tag push 32828622151 双 job success（EVD-018）；CI 配置本次不改动 |
| 9.3 | GitHub Release 资产齐备预期 | **预期 PASS** | 0.7.1 先例：tar.gz + SHA256SUMS.txt（EVD-018）；Release body 用人工 changelog（CHANGELOG 0.7.2 段） |
| 9.4 | 观测窗口 | **发布后回填** | 发布执行后 ≤24h 回填双 job success + Release 资产事实（0.7.1 先例 EVD-018 当日闭环） |

> **注**：本清单为发布前检查（候选态）。上述 CI 预期由发布执行环节实际观测后回填为 PASS/FAIL（9.4）。

## 10. 整体裁决

| # | 检查项 | 结果 |
|---|--------|------|
| 10.1 | 全部检查项通过 | **条件 PASS**（需 Developer 完成版本号三处同步 2.1-2.3 后完全 PASS——与 REL-002 先例同构） |
| 10.2 | 阻断项 | 无（版本号同步为非功能阻断，发布链时间线内由并行 Developer 完成；0.7.1 先例 a50aa03） |
| 10.3 | 发布推荐 | 版本号同步后即可执行发布链：push main → annotated tag v0.7.2 → push tag → CI 观测 → GitHub Release（人工 changelog body） |
| 10.4 | 发布后验证 | 用户环境实测验收（M7.7，用户自验）——v0.7.1 教训（MAINT-014 mock 假绿）后，真实环境验证为发布后观察期必办项 |

---

*检查清单版本：v0.7.2 | 编制：Release Agent REL-003 | 日期：2026-08-26*
