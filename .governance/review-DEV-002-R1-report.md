# 代码审查报告 — DEV-002：v0.7.0 返工复审（Round R1）

## 0. 报告头部

| 字段 | 值 |
|---|---|
| Task ID | DEV-002 |
| Round | **R1** |
| prev_report（R0 引用） | `.governance/review-DEV-002-R0-report.md`（机器记录 `review-DEV-002-R0.md`，R0 结论 NEEDS_CHANGE / next_round R1 已核对） |
| 审查对象 | 返工提交 33a071e..HEAD（5 个：4107cb3 F1、a15d26a F2、6d730e1 F3+F4+F5+F10、441d9b4 F8、e3a21d1 F6）；事实源 `.dev002/rework-r1.diff`（31.5KB，SHA256 81ED7A88…，已与全文通读、与 HEAD 抽查比对一致） |
| **审查结论** | **APPROVED_WITH_NOTES**（`unresolved_blockers=0`） |
| 复审结论依据 | P0=0；P1=0（R0 的 2 个 P1 —— F1 经环境事实修正降级为 P2、F8 已修复）；P2=1（新引入 N1，非阻塞）；P3 若干（遗留跟踪） |

## 0.5 【R0 结论修正段】（事实优先强制修正）

**R0 F1 的"probeEfforts 持久化静默失效"影响论断在本环境下不成立，予以修正。**

对本机实际运行时树（`C:\Users\peter\.dsh\profiles\node_modules\@deepseek-ai\schemastery`，version **3.18.1**）源码逐项核实，Developer 的环境事实修正**属实**：

1. `Schema.from`：`if (isNullable(source)) return Schema.any()`——`Schema.from(null)` 编译为 **any()**（实际源码，已验证）；
2. union 成员编译：`case "list": schema.list = args[index].map(Schema.from)`——`z.union([...LEVELS, null])` 的 null 成员即 any()；
3. union 解析器逐支尝试、any() 对任意值通过——旧 schema 实际**接受 'disabled' 乃至任何值**，R0 所述"const 严格匹配 → 校验失败 → persist 静默失败"**不成立**：zai/deepseek 路由的 `probeEfforts` 当时**能落盘**（代价是线值零校验）。

**修正定级**：R0 F1 由 **P1（功能缺陷）→ P2（schema 值校验缺失 + 引擎语义耦合的稳健性缺陷）**。修复本身仍然正确且值得做（消灭 any 直通、恢复线值校验），但性质是加固而非功能止损。R0 判决方向的另一支柱 F8（零测试）完整成立且已修复——R0 NEEDS_CHANGE 方向不受影响。

**新 schema 双引擎判定**：`z.dict(z.dict(z.string(), z.string()), z.string())` 在本引擎 3.18.1 下语义 = `string | null`（null 走顶层 nullable 直通——`Schema.resolve` 实现已核实；'disabled' 走 string 解析器；123 抛 ValidationError）——与 Developer 自述一致 ✓；在"严格 union/null 语义"的未来引擎下依赖"未 required 直接放行 null"行为。**建议（P3，非阻塞）改用显式 `z.union([z.string(), z.const(null)])`（成员均为 Schema 对象，双引擎语义一致）。**

## 1. R0 发现逐条比对

| # | R0 级别 | 状态 | 证据 | 说明 |
|---|---|---|---|---|
| **F1** | P1→**P2（修正）** | **已修复** | lib/index.js:101-111 | 新 schema + 注释；注释对旧 union 退化机制（`Schema.from(null)→any()`）的描述与源码核实一致 |
| **F2** | P2 | **已修复** | lib/index.js:926, 967-982 | `pendingPins` 延迟到 `settings.replace` 成功后统一写入；失败 catch → `{writes:0,error}`，无内存/磁盘分叉；测试 (e) 验证事件顺序与失败路径 |
| **F3** | P2 | **已修复** | client.js:67-69/111-113（新键 probeLabel/probeResultsTitle/probeFooter）；:278-301（全部改用 t()） | 原 7 个死键全部恢复引用；CSV 按钮改 t('export')；探测中复用 t('testing')。残留 P3：统计主表表头硬编码为 v0.5 起既有 |
| **F4** | P3 | **已修复** | client.js:306（恒等分支已删）；:292（probeSummaryOk 红绿双色）；:214-216（target.key 兜底） | 三处均落实；发现新残留 N2（P3） |
| **F5** | P2 | **部分修复 + 新引入 N1（P2）** | client.js:141, 203-219 | AbortController 40s 已加、finally 清 timer、中止行兜底。**但 40s < 服务端单模型最坏时长（6 候选 ÷ 3 并发 × 30s = 2 波 ≈ 60s）→ 慢而可用的模型被客户端提前判失败**（N1） |
| **F6** | P2 | **已修复（文档级最低档达标）** | README.md:151-152 | 警示内容准确；架构级加固（statsPublic 下强制回环）为 P3 增强遗留 |
| **F8** | P1 | **已修复** | test/ 4 新文件 | 见 §2 专项核实：stub 真实驱动生产路径、断言非恒真、覆盖 a-e + F1/F2 回归；3 个 P3 基建问题（T1/T2/T3） |
| **F9** | P3 | 未修复（遗留跟踪） | index.js:916, 983-990, 283 | 全部 P3，建议 DEV-003/维护阶段 |
| **F10** | P3（待验证） | **已修复（注释级，处置合理）** | client.js:170-173 | 注释诚实明示"未证实的启发式…待上游/真实部署确认"；本环境无法证伪，处置符合事实红线 |
| **F11** | P3 | 未修复（遗留跟踪） | /test 路由 | 仅影响无调用方端点 |
| **F12** | P3（待验证） | 未修复（遗留跟踪） | index.js:654 | 外部契约面，建议注释/文档补充 |

## 2. F8 测试基建专项核实

- **真实驱动生产路径（非旁路）——是**：`makeCtx`+`mount` → 真实 `mod.apply(ctx)`，路由经 `webServer.register` 捕获后投递模拟 req/res；`parseProbeInput→probeModelLevels→probeLevelOnce→llm.stream(桩)→markRejected→persistBlacklist/hydrateBlacklist→applyProbeResults→settings.replace/mutate` 全链路与生产共用；stub 仅替换 seams。
- **断言真实覆盖——是**（5 用例期望值与生产路径逐一核过）：(a) 分类三态+黑名单持久化；(b1) 用户手写跳过+零 replace/mutate；(b2) zai off='disabled' 固化 + xhigh 白名单滤除 + pin；(c) hydrate 去重幂等；(d) F1 回归经真实注册 Config schema（schemastery schema 可调用性已源码证实，`assert.throws(schema({…off:123}))` 非恒真）；(e) F2 回归（replace 失败零 mutate + 事件序）。
- **resolve-fallback 可移植性——T2（P3）**：硬编码 `~/.dsh` 未读 `$DSH_HOME`；建议 `process.env.DSH_HOME ?? homedir()`。
- **CI 接续——T3（P3，DEV-003 前置）**：ci.yml 未跑 `node --test`；CI ubuntu 无 profiles 树，接入前需解决依赖供给。
- **注释准确性——T1（P3）**：probe.test.mjs (b2) 注释"旧 schema 会因 'disabled' 校验失败"按 §0.5 修正（旧 schema 实际 any 直通）；断言本身不受影响。
- **mock 残留/恒真断言——无**；test/ 未列入 package.json files（不随发布）。
- 覆盖缺口（P3 附注）：/test 端点、403 门控、err 分支、30s abort 未覆盖——DEV-003 增补候选。

## 3. 返工 diff 五维 + AI 专项复检

- **正确性**：F1/F2 修复路径正确；F4/F5 客户端逻辑正确；新引入 N1（P2 超时竞态）、N2（P3 颜色未重置）。
- **安全性**：无新攻击面；F6 文档缓解达标；测试钩子仅测试进程使用。
- **可维护性**：注释准确诚实（schema/F10/pendingPins）；i18n zh/en 对齐；test/ 自包含。
- **性能**：N1 之外无新增；UI 有界。
- **测试覆盖**：F8 达标；剩余缺口 P3。
- **AI 专项**：mock 残留无 / 硬编码无新增 / 幻觉 API 无（node:module.register、EventEmitter、AbortController 均标准）/ TODO 无 / 过度实现无新增。

**发现清单（R1）**：P0=0；P1=0；P2=1（N1 客户端 40s 超时 < 服务端单模型最坏 60s——系统性漏判慢模型档位，建议超时上调 ≥65s 或服务端整体限时，或 partial 返回）；P3=9（N2 probeSummaryOk 未重置 / N3=T1 注释 / N4 双引擎 schema 写法建议 / T2 $DSH_HOME / T3 CI 接入 / F7 / F9 / F11 / F12 + 测试缺口）。

**确定性结论**：唯一保留的事实红线段 = 测试**运行结果**（Reviewer 只读未执行 node；执行证据以 Developer 侧与 Coordinator 复核为准）；静态审查确认测试与生产路径真实结合。

## 4. 设计一致性复核

主题①由 R0"部分达成（F1 失效）"修正为"**达成**"（旧 schema 零校验但实际落盘；新 schema 已补校验更稳健）。原则 2 由"违反(F1)"→"已修复"；原则 4 由"违反(F8)"→"已修复"；原则 6"静默吞掉持久化失败"表述按事实修正（该失败从未发生）。其余与 R0 一致。

## 5. 硬门槛自检

P0=0 ✓；5 维度全覆盖 ✓；发现 100% 标级（0×P0/0×P1/1×P2/9×P3）✓；设计一致性完成 ✓；AI 专项 5 项完成 ✓；只读约束遵守（契约核实为运行时树源码阅读）✓。

## 6. 结论

**APPROVED_WITH_NOTES —— unresolved_blockers = 0**（无未解决 BLOCKING finding）。逐条：F1（已修复，P1 修正为 P2）、F2/F3/F4/F5/F6/F10/F8（已修复或达成最低档）、F9/F11/F12（P3 遗留跟踪）、N1（P2 非阻塞建议）。

**非阻塞建议（跟踪表登记）**：① N1 超时对齐（可本轮一行常量或 DEV-003）；② N2 状态重置；③ N4 双引擎 schema；④ T2 $DSH_HOME；⑤ T3 CI 接入（DEV-003 前置）；⑥ F7/F9/F11/F12 与测试缺口。

**复审链提示**：R1 为通过终态（APPROVED_WITH_NOTES + unresolved_blockers=0），复审链结束，无需 R2。
