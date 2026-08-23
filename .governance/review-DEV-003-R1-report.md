# 代码审查报告 — DEV-003：返工复审（Round R1）

## 0. 报告头部

| 字段 | 值 |
|---|---|
| Task ID | DEV-003 |
| Round | **R1** |
| prev_report | `.governance/review-DEV-003-R0-report.md`（机器记录 review-DEV-003-R0.md：NEEDS_CHANGE / next_round=R1 已核对） |
| 审查对象 | 返工提交 4c6c96f..HEAD（207c7fa D1、bfb334c T3-1、d94fde9 注释）；事实源 .dev003/rework-r1.diff（7.5KB，已通读；与 HEAD 抽查一致） |
| **审查结论** | **APPROVED_WITH_NOTES**（unresolved_blockers = 0） |
| 依据 | R0 的 2 个 P1（D1/T3-1）均已修复并有回归守卫；新引入扫描无 P0/P1/P2；仅 P3 记录项 |

## 1. R0 findings 逐条比对

| # | R0 级别 | 状态 | 证据 |
|---|---|---|---|
| **D1** | P1 | **已修复** | lib/index.js:775 字符集预检 `/[^a-z0-9.:[\]-]/` 拒绝；gate-access.test.mjs:58-62 新增 gate-d1 三恶意形态（127.0.0.1/x、x@127.0.0.1、127.0.0.1#y → 403）；TDD 红 29/1 → 绿 29/29 |
| **T3-1** | P1 | **已修复** | ci.yml:38-42 `npm ci --legacy-peer-deps --ignore-scripts --no-audit --no-fund` + 行内根因注释；test/README.md:56-63 处方记录；本地实证（无 flag→ERESOLVE exit 1 dsh-brand 冲突；有 flag→4 包 exit 0 + 29/29）与 R0 推演一致 |
| T2 | P2 | 已修复（确认保持） | resolve-fallback dshHomeOf 三态 + 反向用例（R0 已核，未变） |
| N4 严格引擎边界 | P2 | 已修复（注释级）+ 记录保持 | d94fde9 修正 N4 注释表述；schema-semantics 诚实说明保持 |
| P3×5 | 记录/讨论 | 已修复 3 项 + 记录 2 项 | TDD 守卫语义 ×3；N4 表述修正；::ffff:/非法端口收紧记录保持 |

## 2. D1 实现语义专项核验

1. toLowerCase 先于预检——`Host: LOCALHOST` 归一放行（RFC 9110 大小写不敏感）✓；`X@127.0.0.1` 小写后 @ 命中预检 403 ✓
2. 字符集 `[^a-z0-9.:[\]-]` 语法合法，覆盖 @ # / % 空格全部旁路字符 ✓
3. Zone-id（%25eth0）被拒——非回环形态且旧实现同样拒绝（无回归）——P3 记录
4. 空 Host 放行与旧实现完全一致（无回归）——P3 记录，建议不动
5. URL catch 分支仍必要（:::1 等纯合法字符非法形态）双保险 ✓
6. gate-d1 三形态均在预检被拒，harness host 参数支持断言真实通过 ✓

**结论：D1 修复正确、无新引入问题（仅 2 条 P3 记录）。**

## 3. T3-1 核验
YAML 合法；处方一致性 CI=本地=README ✓；运行时契约不变（dependencies {} / peers * / 发布物不含 test）✓；CI 首跑为经验证处方（Developer 本地实证）——P3 可观测项。

## 4. 注释修正核验
N4 注释方向正确（末句宽松表述不再追，P3 已关闭）；TDD 守卫 ×3 与事实一致；gate-5 标注更新 ✓；Test Reviewer P2-01 交叉部分已随 d94fde9 落实。

## 5. hunk 重排诚实性核验
git show --stat 三提交逐一定界：207c7fa（index.js +5 / gate-access +11/-1）、bfb334c（ci.yml +4/-1 / README +7/-1）、d94fde9（index.js +5/-2 / 2 注释文件 +3/-1）——主题与内容一致，无跨主题污染；reset --soft 重排自述与提交边界一致——**诚实性核验通过**。

## 6. 新引入扫描
无新 P0/P1/P2。P3 记录 ×5：zone-id 拒绝 / 空 Host 放行（既有）/ N4 末句 / CI 首跑经验证 / ::ffff: 与非法端口收紧（正效应）。

## 7. 设计原则对照
原则 1✓（全部论断实证）；原则 2✓（字符集+回退分支全推演）；原则 3✓（旧兼容保持）；原则 4✓（TDD 先行+守卫保留）；原则 7✓（门控边界恢复+恶意形态加防）；编程要求 4✓（三提交主题单一，重排核验通过）。

## 8. 硬门槛自检
P0=0 ✓；P1=0 ✓；5 维度+AI 专项完成 ✓；发现 100% 标级（0/0/0/5×P3）✓；只读约束遵守 ✓。

## 9. 结论
**APPROVED_WITH_NOTES —— unresolved_blockers = 0**。R1 为通过终态，复审链结束，无需 R2。DEV-003 产品代码部分通过；测试设计质量由 Test Reviewer 线闭环（已 APPROVED_WITH_NOTES）。
