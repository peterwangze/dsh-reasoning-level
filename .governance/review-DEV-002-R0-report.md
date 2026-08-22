# 代码审查报告 — DEV-002：v0.7.0 产品代码变更独立审查（Round R0）

## 0. 报告头部

| 字段 | 值 |
|---|---|
| Task ID | DEV-002（审查对象：v0.7.0 产品代码变更） |
| Round | **R0**（首轮；前轮引用：无） |
| Review Agent | Code Reviewer（独立审查，只读） |
| 审查范围 | `dsh-reasoning-level` 仓库 5faf825..HEAD（2 提交：`c157085` lib/index.js + lib/client.js；`33a071e` package.json + README.md + VERIFICATION.md）— 以 `.dev002/original-full.diff`（已验证 SHA256 D23EA42D…）为 diff 事实源，共 5 files +536/-108 |
| 审查基准 | docs/development-principles.md（7 原则 + 4 编程要求）；skills/code-review 规范 |
| **审查结论** | **NEEDS_CHANGE**（P0 阻塞 = **0**；P1 关键 = **2**，不得直接通过；建议修复后进入 R1 复审） |
| 验收标准自检 | ①5 维度全覆盖 ✔ ②AI 专项 5 项 ✔ ③发现全部标级 ✔ ④设计一致性逐条 ✔ ⑤结论明确 ✔ |

> 说明：按调度指令（禁止事项），本报告不落盘 `.governance/review-DEV-002.md`（未修改任何文件），由 Coordinator 经 review-record CLI 机器持久化。
> 全流程只读：未执行任何项目命令/测试，未修改任何文件。对 DSH 契约的核实通过**阅读**本环境 DSH 运行时包（`node_modules/@deepseek-ai/*`）的类型与实现源文件完成，非执行验证——所用运行时报版本即为该插件 peer（`*`）契约下 DSH 维护的平坦回退树实例。

---

## 1. 五维审查结论与证据

### 维度 1：正确性 —— **发现有缺陷（P1×1，P2×1，P3×3）**

| 检查项 | 结论 | 证据 |
|---|---|---|
| 逻辑正确 | 主干逻辑正确；**F1 为已证实缺陷** | 见发现 F1 |
| 边界条件 | 基本覆盖 | 空 results（index.js:907 `undefined → {writes:0}`；`:917` 空数组）、无候选（`:873-875` error='no candidate levels'）、403（`:1005-1009` 等）、HTTP 层异常被 catch。**F5 客户端无超时边界**（client.js:191-216） |
| 并发安全 | 安全 | worker 池（index.js:877-886）`next++` 同步自增后 await，`results` 按 level 键互不冲突；黑名单 Map 单线程。缺失项：并发 /probe 无服务端全局上限（P3） |
| 资源管理 | 基本正确 | `probeLevelOnce` finally 清 timeout（index.js:836-838）；`for await` 首个 finish chunk 即 break（`:816-817`），DSH 契约保证 usage 后才出 finish，break 安全。**F2**：replace 失败时内存台账先落、持久化后落，状态分叉（P2） |

关键事实核实（对 DSH 运行时源码/类型逐项核对，全部通过）：
- **ContentBlock 修复正确**：DSH `UserMessage.content` 契约即 `ContentBlock[]`（dsh-llm/types/message.d.ts:126,132、types.d.ts:72）；`[{type:'text',text:'ping'}]` 是合法构造 → 旧字符串 `content` 触发 `content.some is not a function` 的根因诊断成立。
- **`probe:true` 旁路成立**：`LlmRuntime.stream` 原样传给 waterfall（dsh-llm/lib/index.js:1640 `ctx.waterfall(this,"llm/stream",options,…)`；事件签名 dsh-llm/types/index.d.ts:43 `(options: GenerateOptions, …)`），插件是调用方 → 自身 listener 能读到 `options.probe`（index.js:654 早退，不注入、不统计）。
- **`signal` 是合法字段**：`GenerateOptions.signal?: AbortSignal`（types.d.ts:356），adapter 契约 `implementations must honor options.signal`（dsh-llm types/index.d.ts:164-168）。中止后 DSH 归一化为 finish `{kind:'aborted', failure}`（lib/index.js:1644-1655）→ 落入 blocked 而非 rejected，符合"限流/超时不误判"。
- **错误分类正确**：`UNSUPPORTED_REASONING_EFFORT` 是 DSH 真实错误码且文案为 `…does not support reasoning effort "{{level}}"`（dsh-llm/lib/index.js:1471/1475）——插件 `rejectionLevelOf` 正则 `/reasoning effort "([^"]+)"/`（index.js:201）与 code 判断（`:894`）双重匹配成立。
- **`llm.resolveModelInfo` 非幻觉 API**（dsh-llm/types/index.d.ts:313），`api.llm.models({})` 非幻觉（dsh-host-apiproxy RPC `llm.models`，响应 `{groups:[{id,name,models:[{id,name,reasoning?}]}]}`，group.id = 注册路由 id——lib/index.js:1010-1049），且二者均为 v0.4~v0.6 既有用法。
- **F1（P1）已证实**：见发现清单——`Config.probeEfforts` 值 schema `z.union([...LEVELS, null])`（index.js:102）无法表示 `generatedEffortsFor` 对 zai/deepseek 格式产生的 wire 值 `'disabled'`（index.js:69）。schemastery const 解析为严格 `deepEqual`、union 逐支尝试失败即抛（bundle `Schema.extend("const"…)` / `extend("union"…)`）；`settings.mutate` 先校验后持久（dsh-settings types/index.d.ts:240-275），校验失败 → `persistProbeEfforts`（index.js:250）被 `.catch` 静默吞掉 → **zai/deepseek 格式路由的 probeEfforts 永不落盘**。

### 维度 2：安全性 —— **通过（无 P0），有 P2×1 关注项 + P3×2**

| 检查项 | 结论 | 证据 |
|---|---|---|
| 输入校验 | 通过 | provider/model 字符串类型化（index.js:1010-1011, 1059-1060）；level 任意字符串由 DSH `resolveCallWithInfo` 先校验后 I/O（"Unsupported explicit efforts reject before provider I/O"，dsh-llm types）→ 无任意 level 注入；**探测消息为固定常量** `PROBE_MESSAGES`（index.js:797），无用户内容进入 LLM 请求 |
| 注入防护 | 通过 | body JSON 解析有 try/catch（index.js:987-989）；无 SQL/命令面；能力声明写入值被 `GENERATED_LEVELS`+`generatedEffortsFor` 白名单约束（index.js:924, 941-945） |
| 敏感数据 | 通过 | 无硬编码密钥；错误 message 回显到本地 UI 无泄密面（默认回环） |
| 权限检查 | **有条件通过** | 新增 `/probe`、`/probe/apply` 复用既有 loopback/statsPublic 门（index.js:983-990）✔；**但 F6**：`statsPublic:true` 时 LAN 无认证可触发任意 LLM 请求（成本）**与配置写入**（`/probe/apply` → `settings.replace(llm-pi-ai)` + `mutate(NS)`）——OWASP 访问控制面从"读统计+发请求"扩展为"改配置"，默认配置不暴露，不构成 P0，建议写入端点强制回环或显示确认（P2） |
| 资源耗尽 | P3 | `readBody` 无体积上限（index.js:974-981）；并发 /probe 无服务端上限（30s 超时与单模型并发 3 是有界因子） |

### 维度 3：可维护性 —— **P2×2，P3×3**

- 命名/注释质量好（注释解释了 pin/黑名单/持久化语义）；函数长度合规。
- **F3（P2）**：i18n 键 `probeAll`/`probeEmpty`/`probeColModel`/`probeColWorking`/`probeColRejected`/`probeColBlocked`（client.js:60/63/66/101/104/107）在 zh/en 均定义但**零引用**（已 grep 证实）；新 UI 按钮与表头硬编码中文（client.js:261, 269, 272-275），在 en locale 下探测面板全中文，破坏 v0.5 建立的 zh/en 双语模式。
- **F4（P3）**：client.js:280 存在恒等条件分支 `(r.error !== undefined ? '—' : '—')`（两分支相同，疑似应为错误文案或省略）；`probeSummary` 恒绿（client.js:266），apply 失败也显示绿色成功文案。
- **F7（P3）**：UI 移除单品测试后，`/reasoning-level-stats/test` 端点（index.js:1000-1043）与 `testOk`/`testFail`/`blacklisted` 键（client.js:57-59/98-100）成死代码（`testOk` 等为 v0.5 起遗留，本 diff 维持其死状态）。
- 结构性注意：lib/index.js 已 1131 行，本次再 +250 行，探测基建建议后续拆模块（P3，非本轮义务）。

### 维度 4：性能 —— **通过（有 P2×1）**

- 单模型并发 3 的 worker 池正确实现（index.js:877-886）；无 O(n²)；`applyProbeResults` 整节 clone+replace O(节大小)，与 v0.6 applyPiAi 同模式。
- **F5（P2）**：客户端逐模型串行 `/probe`（client.js:187-201）且 fetch 无超时；最坏 N 模型 × 2 轮 × 30s（单模型两个并发窗口），若某 adapter 未即时响应 abort，整个"探测中"状态可永久悬挂。建议客户端 AbortController（如 40s）+ 显示模型级进度即可缓解。
- P3：每模型 `resolveModelInfo` 无缓存（一次性成本可接受）。

### 维度 5：测试覆盖 —— **P1×1（F8）**

- 本 diff **未新增任何自动化测试**（仓库 `scripts/client-smoke.mjs` 与 `ci.yml` 未在本 diff 中变更）。
- 新增核心逻辑零测试：探测分类（UNSUPPORTED/限流/超时分支）、`applyProbeResults` 用户声明保护与 pin、`persistBlacklist`/`persistProbeEfforts`/`hydrateBlacklist`、`/probe` `/probe/apply` 路由、客户端 probeAll 流程——均无自动化覆盖，仅 VERIFICATION.md 提供人工步骤。
- 现有 smoke（脚本读 client.js 挂载渲染）与新代码**构造上兼容**（stub 提供 `llm.models`，probe useEffect 可解析），**未运行验证**（只读约束）。
- 违反用户约定**开发原则 4（测试看护/防护网）**——按项目规则 P1 级记录。

---

## 2. AI 代码专项检查（5 项）

| 检查项 | 结论 | 证据 |
|---|---|---|
| mock 残留 | **无** | diff 全文无 mock/fixture 混入产品路径 |
| 硬编码返回值 | **无服务端硬编码**；客户端 1 处坏味道 | F4：client.js:280 恒等分支（非硬编码返回值但属可疑构造）；client.js:261/272-275 中文硬编码属 i18n 问题（F3） |
| 幻觉 API | **无**（全部核实） | `llm.resolveModelInfo`（dsh-llm dts:313）、`api.llm.models`（dsh-host-apiproxy RPC+schema）、`settings.replace/mutate`（dsh-settings dts:262/275）、`llm.stream` 的 `signal`（types.d.ts:356）、`probe` 透传（waterfall 原样传参）、ContentBlock 消息契约 |
| 未实现 TODO | **无 TODO 残留**；存在未使用定义 | F3（probeEmpty 等 7 键从未渲染）、F7（/test 端点无调用方） |
| 过度实现 | 轻度 | `/probe` 的 `levels` 过滤参数客户端从未发送（index.js:1066）；`/test` 保留为无调用方端点；`applyProbeResults` 的 `skipped[]` 客户端不消费（只显示 writes 计数） |

---

## 3. 发现清单（全部标级）

### P0（阻塞）：0 项

### P1（关键）：2 项

**F1 — probeEfforts 持久化 schema 无法表示自身数据：zai/deepseek 格式路由的"重启生效"静默失效**
- 位置：lib/index.js:102（`probeEfforts: z.dict(z.dict(z.union([...LEVELS, null]), z.string()), z.string()).default({})`）；产生方 index.js:69（`off = 'disabled'`）；写入方 index.js:239-258（`persistProbeEfforts` → `settings.mutate`）。
- 事实：`generatedEffortsFor` 对 zai/deepseek thinking 格式对 `off` 产出 wire 值 `'disabled'`；`applyProbeResults` 把 `verified[off]='disabled'` 写入 `pendingVerified` → `persistProbeEfforts` → `settings.mutate(NS, set probeEfforts)`。schemastery `const` 解析为严格 `deepEqual`、`union` 全部不匹配即抛 ValidationError（bundled `Schema.extend("union"/"const"…)`）；dsh-settings `mutate` 在持久化前对注册 schema 校验（dsh-settings types/index.d.ts:263-275）。→ 该类路由 `probeEfforts` 永未写成功，仅 `.catch` 打 warn（index.js:250-253）。
- 影响：功能主题①④"能力声明+两级配置持久化 settings.yaml、重启生效"对 zai/deepseek（含 `compat.thinkingFormat` 任意值）路由失效；重启后 pin 台账无源。注：子集形状声明重启后仍按"用户形状"工作（非 6 键生成形状不触发升级），故**今日运行时影响有限**——但文档承诺不成立、失败完全静默、且未来生成表升级时 pin 保护缺位。
- 修复建议：内层值 schema 放宽为 `z.string().nullable()`（或再并 `'disabled'`）；或持久化时序列化 wire 值 → 需配套 hydrate 反算。推荐前者（一行）。

**F8 — 新核心逻辑零自动化测试，违反开发原则 4**
- 位置：diff 全文（无测试文件变更）；index.js:639-1104（探测/固化/端点）、client.js:179-220（probeAll）均无对应测试。
- 事实：仓库仅有 `scripts/client-smoke.mjs`（渲染冒烟，未覆盖服务端逻辑），diff 未新增任何用例；VERIFICATION.md 仅人工步骤。
- 影响：分类黑名单/用户声明保护/pin+持久化/端点权限是 P1 级逻辑，回归无防护网（开发原则 4：测试看护，避免后续问题反复）。
- 修复建议：至少为 (a) `probeModelLevels` 分类（ok/rejected=UNSUPPORTED/blocked=aborted）、(b) `applyProbeResults` 用户手写跳过 + working 白名单 + pin、(c) `persistBlacklist`/`hydrateBlacklist` 幂等合并、（d）一个 `settings.mutate` 校验失败断言（直接覆盖 F1）补 4~6 个断言用例。

### P2（建议）：4 项

- **F3**（client.js:60-67, 101-108, 261, 269, 272-275）— 7 个新 i18n 键定义未用 + 探测面板硬编码中文，打破 zh/en 双语模式（v0.5 基础）；建议引用 `t('probeAll')`/`t('probeCol*')`/`t('probeEmpty')`（`probeEmpty` 可在 probeTargets 为空时输出）。
- **F5**（client.js:191-216）— 客户端无超时/取消；最坏 N×2×30s 串行 + 潜在永久"探测中"；建议每模型 fetch 加 AbortController（如 40s），并可展示剩余模型数。
- **F6**（index.js:983-990 门控 + :1052-1066 / :1086-1093 端点）— `statsPublic:true` 时 LAN 可无认证触发 LLM 成本请求与**配置写入**（`settings.replace` llm-pi-ai + `mutate` NS）；默认回环不暴露；建议 `/probe/apply`（及 `/probe`）在 `statsPublic` 下仍要求回环或加二次确认 token，至少在 README 显式说明风险。
- **F2**（index.js:957-959 vs :961-969）— `verifiedEfforts`/`pendingVerified` 在 `settings.replace` 成功前先落内存；replace 失败时返回 `{writes:0}` 但内存 pin 已生效（状态分叉）；建议先 replace 后写台账，或失败时回滚内存台账。

### P3（讨论/疑问）：6 项

- **F4**（client.js:280, 266, 199）— 恒等分支 `'—' : '—'`；`probeSummary` 失败也绿；网络错误行缺 `key`（首列空白）。
- **F7**（index.js:1000-1043；client.js:57-59, 98-100）— `/test` 端点与 `testOk/testFail/blacklisted` 键无调用方（死代码；若为保留 API 请注释说明）。
- **F9**（index.js:907, 974-981, 283）— `rawSection` 为 undefined 时 skipped 信息丢失；`readBody` 无体积上限；`hydrateBlacklist` catch 无日志（有注释说明，可接受，建议加一条 debug 级日志）。
- **F10（待验证）**（client.js:168）— `group.id.endsWith('-router')` 跳过规则：本环境 DSH 包中无该命名证据（组 id = 注册路由 id），dsh-agent-router 为外部插件；若约定与实际不符则跳过无效果或漏探测，请提供该命名约定的依据或改为显式路由过滤。
- **F11**（index.js:1020）— `/test` 的 markRejected 等级推导 `result.code !== undefined ? effort : rejectionLevelOf(result)`：当 code 存在但非 UNSUPPORTED 而 message 匹配拒绝文案时，按 effort（请求档）标注，与 `rejectionLevelOf` 提取的等级可能不一致（仅 /test 路径，概率低）。
- **F12（待验证）**（index.js:654 旁路）— 探测请求仅绕过本插件 hook；DSH 其他 `llm/stream` 中间件（如 dsh-llm-retry 重试策略）仍会对探测请求生效（可能放大请求/延迟），30s 超时按单次尝试计。属外部契约面，建议 README/注释补充说明。

---

## 4. 设计一致性比对

**v0.7.0 功能主题 vs 实现：**

| 主题 | 结论 | 证据要点 |
|---|---|---|
| ① 一键探测全部模型全部候选等级；可用写回能力声明、拒绝入黑名单；两级持久化重启生效 | **部分达成（F1 使 zai/deepseek 路由的 probeEfforts 持久化失效）** | 客户端全目录探测（client.js:159-177）、候选三级来源（index.js:856-871）、黑名单持久化 schema `array(string)` **正确**、`probeEfforts` schema **错误**（F1） |
| ② ContentBlock 修复 / probe 旁路统计 / 30s 超时 / 单模型并发 3 / 限流超时与不可用严格区分 | **达成（已对照 DSH 运行时逐项证实）** | client 契约 `content: ContentBlock[]`（dsh-llm message.d.ts:126）；waterfall 原样传 opts（lib/index.js:1640）；`signal` 是 `GenerateOptions` 正规字段（types.d.ts:356）且 adapter 契约强制 honor；`'aborted'` 归一化路径（lib/index.js:1644-1655）；worker 池（index.js:877-886）；`PROBE_TIMEOUT_MS=30000`（:82）、`PROBE_CONCURRENCY=3`（:84） |
| ③ 用户手写声明永不被探测覆盖 | **达成**（唯一不可分辨情形为手工写出与生成表完全一致的 6 键形状——与 v0.4-v0.6 既有"生成形状即归属插件"语义一致，非本轮引入） | index.js:935-938（`user-declared` 跳过）；:616-620 注释 |
| ④ 0.6.0→0.7.0 版本号与文档更新 | **达成** | package.json:4 `"0.7.0"`；README/VERIFICATION diff 与实现一致（`probeBlacklist`/`probeEfforts` 键名、`/probe` `/probe/apply` 端点、`probe:true` 标记、ContentBlock 修复描述全部与代码相符） |

**docs/development-principles.md 逐条：**

| 条目 | 判定 |
|---|---|
| 原则 1 事实推演 | 基本遵守；**F10（-router 命名约定）无事实依据即写为注释结论**（P3 待验证）；F1 表明 schema 推演有遗漏 |
| 原则 2 全面分析 | **违反（F1）**——wire 值集合未在 schema 中全量推演（漏 `'disabled'`） |
| 原则 3 原功能影响 | 达标：既有注入/统计/路由默认收敛路径未被破坏（pin 检查置于生成升级之前，index.js:342-346）；原"单品测试"按钮被一键探测替换（README 明示）；`/test` 保留为死端点为唯一残留（F7,P3） |
| 原则 4 测试看护 | **违反（F8，P1）** |
| 原则 5 泛化性 | 基本达标：探测目标从目录/声明/生成集三级推导，非单点写死；schema 硬编码自有 wire 词汇表是泛化性欠佳的局部体现（并入 F1） |
| 原则 6 高质量交付 | 部分违反：静默吞掉的持久化失败 + 死 i18n 键 + 恒绿成功色（F1/F3/F4） |
| 原则 7 修复安全性 | 达标：无用户数据损坏路径；replace 写入物由白名单约束（index.js:924, 941-945）；唯一新增风险面为 F6（conditional，P2） |
| 编程要求 1/2（可扩展/防腐化） | 达标：无新架构债；探测基建函数职责清晰（probeLevelOnce/probeModelLevels/applyProbeResults），未引入上帝模块；lib/index.js 体量增大为 P3 维护性备注 |
| 编程要求 3（职责单一） | 达标（同上） |
| 编程要求 4（一 commit 一问题） | **达标**：`c157085` 实现 + `33a071e` 版本/文档，分离干净 |

---

## 5. 硬门槛自检

| 门槛 | 结果 |
|---|---|
| P0 阻塞数 = 0 | **是（0 项）** |
| 5 维度全覆盖 | **是**（各维度逐项有结论与证据） |
| 每条发现标级 | **是**（0×P0 / 2×P1 / 4×P2 / 6×P3，含"待验证"如实标注） |
| 设计一致性检查 | **已完成**（4 主题 + 11 条原则逐条比对） |
| AI 专项 5 项 | **全部完成**（各带证据） |
| 只读约束 | 遵守（0 写操作、0 命令执行、0 子 agent、0 用户交互；DSH 契约核实为源码阅读） |

**复审触发说明：** 结论为 NEEDS_CHANGE（round R0；P0=0，P1=2）。按 M7.4 step 4.6，Coordinator 应退回 Developer 处理（**F1 必须修复——它是可证实的功能缺陷；F8 补测试**；P2 建议本轮一并处理，P3 可遗留跟踪），随后**重 spawn 同一 Code Reviewer 复审（R1）**；复审时需逐条标注"已修复/未修复/新引入"。

**给 Coordinator 的备注：** 若 Coordinator 评估后希望做"有条件合并"（SKILL 关闭规则：P0=0 且 P1>0 且有遗留计划），则等价于 APPROVED_WITH_NOTES——按 Check 30 语义该终态要求 `unresolved_blockers=0` 且**不得包含未解决 BLOCKING finding**；本报告 P1 为关键而非阻塞，但 F1 属已验证功能缺陷，我**不建议**跳过修复直接通过：其修复成本一行、影响面覆盖插件文档重点强调的 zai/deepseek 路由，R1 复审成本远低于缺陷遗留成本。最终处置权在 Coordinator。
