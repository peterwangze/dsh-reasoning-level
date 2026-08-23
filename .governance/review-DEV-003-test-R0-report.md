# 测试审查报告 — DEV-003（Round R0，Test Reviewer）

## 0. 报告头部

| 字段 | 值 |
|---|---|
| Task ID | DEV-003（测试产物部分；产品代码 diff 由并行 Code Reviewer 审查） |
| Round | **R0**（Test Reviewer 链首轮） |
| Review Agent | Test Reviewer（只读） |
| 审查对象 | test/ 全部变更（.dev003/dev003-tests.diff 39.8KB + 仓库当前 10 文件）+ QA 三报告（qa-dev003-report.md / -defects.md / -testlog.txt） |
| 运行结果事实 | node --test 28 pass / 0 fail / exit 0（Coordinator 独立复核；npm install 前后各一次）；node --check ×2 / client-smoke exit 0 |
| **审查结论** | **APPROVED_WITH_NOTES**（unresolved_blockers=0；P0=0，P1=0，P2=1 非阻塞，P3=3） |

## 1. 硬门槛裁决（全过）

- **边界 5 类覆盖**（≥5 类每类≥1 用例）：null（DEF-002 有意不锁 bug 行为，复现证据完整）/ 空（空 body 400、空 results）/ 超长（64KB body）/ 并发（峰值=3 断言）/ 超时（30s abort→blocked，全局 setTimeout 捕获 + signal 真实中止路径，无真实等待）——逐项存在且断言具体 ✓
- **回归通过率 100%**：28/28 转绿证据链完整——baseline-before-fix（25 pass/3 fail：client.js:142 95s / client.js:197 probeAll 重置 / index.js:770-780 URL 归一化）→ after-fix（28/0）；**测试文件修复前后零改动，无弱化断言痕迹** ✓
- **性能基线**：无基线可接受——本任务为测试防护网，并发峰值断言即主负载边界 ✓
- 阻塞/关键缺陷 = 0 ✓；安全 HIGH/CRITICAL = 0 ✓

## 2. 六维度结论

1. **策略完整性**：QA 覆盖矩阵（19 缺口→三态）声明完整且与测试代码一致；T3 CI 环境说明充分（devDeps 3 包精确锁版 + lock 入库 + ci.yml npm ci + node --test；import 链全覆盖，发布契约未破）✓
2. **边界覆盖**：见硬门槛 ✓
3. **集成契约**：harness 仅替换外部 seams（settings/llm/webServer），被测逻辑未被复制；resolve-fallback 的 dshHomeOf 与产品 resolveDshHomeSafe 同源语义（$DSH_HOME 非空优先）✓
4. **性能基线**：如上 ✓
5. **安全深度**：403 门控矩阵（gate-1~5）覆盖访问控制面；IPv6 修复（DEF-001）有 gate-5 回归守护 ✓
6. **缺陷报告质量**：qa-dev003-defects.md 的 DEF-001/002 含严重级别+复现步骤+影响范围 ✓

## 3. 发现清单

**P0：0 ｜ P1：0**

**P2（非阻塞，跟踪表）：1**
- **P2-01**：TDD-FAILS-UNTIL 残留注释已过时且误导——client-meta-constants.test.mjs:2,7（"当前会失败…期望失败"）、client-probe-summary.test.mjs:122、gate-access.test.mjs:49,54（描述旧 bug 实现+"当前 403=缺陷"）与 test/README.md 自相矛盾（9-12 行"已转绿 28/28" vs 44-47 行"（当前失败）"×2 + 40s）。建议改"修复守卫"语义或清理。**（处置：已在 Developer 返工范围内——注释小项）**

**P3：3**
- **P3-01**：N4 测试已退化为自比较/恒真——prod schema 已被 Developer 按 N4 建议改为显式 union（lib/index.js:112），测试 explicit 与 prod 同构造；注释声称的"未来严格引擎先失败"canary 永不可能触发；z.string() 回退也无法被发现。建议改写或移除。
- **P3-02**：parseProbeInput 放行臂（statsPublic=true × 非回环 × probe/test/apply 200）未覆盖。
- **P3-03**：QA 报告计数口径（"25 个通过断言"含 2 个文件级 pass；"新增 22 用例"实为 20 test()）。

**说明**：DEF-002（null body 200+error，P3 产品缺陷）有意不锁测试（不固化 bug 行为），复现证据完整——处置正确。

## 4. 结论

**APPROVED_WITH_NOTES —— unresolved_blockers = 0**。测试线通过终态；P2-01 并入 Developer 返工（注释小项已在范围），P3-01/02/03 遗留跟踪（后续维护任务候选）。
