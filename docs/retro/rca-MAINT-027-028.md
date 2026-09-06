# RCA 报告 — MAINT-027 + MAINT-028：探测结果不保留 / 全局最大未随模型切换生效

- **Task ID**: MAINT-027（P1）+ MAINT-028（P1）——同一 RCA 批次
- **阶段**: 阶段 1 只读分析（本报告为唯一写入产物；未修改任何产品代码/测试/脚本/治理记录）
- **分析人**: Maintenance Agent
- **日期**: 2026-09-05
- **宿主环境**: DSH 0.1.2-rc.1（npx checkout 实测）；插件 v0.7.4（tag=45c05f1=工作树 HEAD；用户安装 link: 直连工作树）
- **症状（用户报障原文，唯一症状事实）**: ①「探测结果不会保留」②「已经默认设置全局最大，但是切换模型推理等级没有按照设置使用最大，需要手动调整」
- **视觉证据（三截图提取，可信症状事实）**: 全局=启用+最大+同步 agent 勾选，状态行「已应用：1 个路由 / 2 个模型 · DeepSeek 官方：设置为 最大」；输入区控件（宿主）显示 glm-5.3 等级 **High**；统计=最大×2039/(默认)×17/高×4；探测区无任何结果痕迹；「（12 个模型 · 实测用 1-token 请求）」。

---

## 0. 结论速览

**MAINT-027（探测结果不保留）——已证实，复合根因（非数据丢失型缺陷）**：

1. **探测的持久化产物其实已落盘**：用户磁盘 `settings.yaml` 的 glm-local 两模型带有 **7 键全量词表 `reasoningEfforts`（含 xhigh）**——该形状只能由探测链路产生（生成表 `generatedEffortsFor` 恒 6 键无 xhigh，lib/index.js:83-86；README:139），且固化载体 = 服务端 `settings.replace('llm-pi-ai')`（lib/index.js:1041/1293）+ `settings.mutate('llm-reasoning',[set probeEfforts])`（lib/index.js:334），**从不经过 MAINT-025 打断的客户端 remote 写路径**（假设 A 证伪；git 实证 ed3c784 只改 client.js+tests，v0.7.2→v0.7.3 lib/index.js 仅命名空间接缝、v0.7.3→HEAD 零改动，探测链与用户实测验证过的 v0.7.2 同源）。
2. **但 pin（probeEfforts）从未写入 + 计数恒 0**（进程内证明 P1，真实代码驱动）：全 7 档可用时收敛走 **no-change 路径不写 pin**（lib/index.js:1081，= MAINT-019 P3-1），随后客户端 /probe/apply 恒 **already-verified, writes=0**（lib/index.js:1279-1281，= MAINT-019 P2-2）→ UI 显示「固化 0 处」（lib/client.js:411）。
3. **探测结果表是纯内存瞬态**：`probeResults/probeSummary` 为组件 useState（lib/client.js:330-331），刷新/重启后探测区空白，无任何持久重建（假设 B 证实——by-design 瞬态 × 用户「保留」期望 = 需求差）。
4. **12 个探测目标中不在 llm-pi-ai 配置的模型（本例 10 个）探测结果完全不落盘**：converge 跳过（lib/index.js:1002-1004 model-not-in-pi-ai-config）+ apply 跳过（lib/index.js:1230-1233），UI 不提示——这些模型的「不保留」是字面真实。
5. 用户感知 = (2) 计数 0 + (3) 界面无痕 + (4) 多数模型真没写 —— 三者叠加成「探测结果不会保留」；能力声明本体已持久且重启存活（isFullVocabShape 保护，lib/index.js:431/435）。

**MAINT-028（全局最大未随模型切换生效）——已证实，插件侧缺陷（非纯宿主边界）**：

1. **磁盘铁证**：`llm-pi-ai.providers.glm-local.reasoning: high`——路由默认停在 **high**，而全局 `level: max`、`llm-deepseek.reasoningEffort: max`、`agent-default-model.reasoningEffort: max` 都已是 max。状态行「已应用：1 个路由」按**字段存在性**计数（lib/client.js:743-744），把陈旧 high 也计成「已应用」——掩盖了不一致。
2. **根因 = 所有权门控 × 内存台账重启失忆**（进程内证明 P2，真实代码驱动）：applyPiAi 仅当 `current===undefined || current===mineLevel` 才写路由默认（lib/index.js:468），而 `myRouteReasoning` 是纯内存 Map（lib/index.js:177-179）——重启后插件无法认领自己先前写的 'high'，视为用户手改值永不升级到 max（对照实验：无先验值→写 max ✓；同进程 high→max ✓；仅重启后卡死 ✗）。**对照面**：applyDeepseek 无所有权门控直接对齐 level（lib/index.js:496-500）→ deepseek 已升 max；applyDefaultAgent 同样直写（lib/index.js:527-528）→ agent-default-model 已升 max——这正是「DeepSeek 官方：最大/agent 默认已最大，但 pi-ai 路由卡 high」不对称的完整解释。
3. **宿主链路放大到输入区控件**：目录 `defaultEffort` = `describableReasoningLevel(model, profile.reasoning)`（dsh-llm-pi-ai lib/index.js:1724/1633-1641）→ 陈旧 high 使 glm-5.3 目录 defaultEffort=high → 宿主模型选择器**切换模型时把 defaultEffort 作为显式 reasoningEffort 发送**（dsh-client-ui-model-selection lib/client.js:411-419）→ selectModel 经 resolveCallConfig 物化进会话选择（dsh-api-session-controller lib/index.js:600-614 + dsh-llm lib/index.js:1570-1576）→ 控件显示 High（model-selection:422 `state.current?.reasoningEffort ?? defaultEffort`）→ 后续请求携带**显式** high → 插件尊重显式选择不覆盖（lib/index.js:590，README:19/21 承诺）→ 用户必须每次手动调 max（其手动 max + agent 默认 max = 统计最大×1719/1191/129 的来源）。
4. **(默认)×17 的确切语义（假设 B 裁决）**：记账发生在 llm/stream hook 入口（lib/index.js:698/721），而路由默认的物化发生在 adapterStream **内部**（dsh-llm lib/index.js:1656-1689 → dsh-llm-pi-ai:1756 `options.reasoningEffort ?? profile.reasoning`）——(默认) = 调用入口无显式等级（辅助调用/router 手建调用等），**其 wire 实际携带的是（陈旧的）路由默认 high**，并非「插件注入失败」。statsHint 文案（lib/client.js:58「默认物化后的最终值」）与实现不符（显示层准确性缺陷，同族）。
5. 假设 A 部分证实（输入区控件确为宿主自有状态、插件无同步 API——remote 面仅 describe/update/mutate/modelCatalog，无 session.selectModel 写入口），但**它不是根因**：若路由默认为 max，切换模型会物化 max、控件显示最大——缺陷在插件侧的陈旧路由默认，宿主行为按设计正确传递了它。

---

## 1. MAINT-027 分析

### 1.1 固化落盘的实际载体（file:line）

| 载体 | 写入点 | 读取/恢复点 | 判定 |
|---|---|---|---|
| `llm-pi-ai.providers[route].models[].reasoningEfforts`（能力声明） | 探测收敛 `settings.replace`（lib/index.js:1041）；客户端固化 `settings.replace`（lib/index.js:1293）；applyLevel 自动声明（lib/index.js:432/456） | 宿主 pi-ai adapter 每请求实时读取（dsh-llm-pi-ai:1655 注释）；插件 boot 读取 | **服务端 dsh-settings 面**，MAINT-025 未触及 |
| `llm-reasoning.probeEfforts`（实测 pin） | `persistProbeEfforts` → `settings.mutate`（lib/index.js:324-342，仅 :334 一处） | `hydrateVerifiedEfforts` boot 恢复（lib/index.js:347-359） | 同上；**用户磁盘缺失该字段**（见 §1.3） |
| 探测结果表（working/rejected/blocked） | 无任何持久化 | 无 | **纯 React useState**（lib/client.js:330-331） |

MAINT-025 打断的是**客户端 remote.settings.update/mutate 网关元数守卫**（ed3c784 修复，只改 lib/client.js+scripts+tests）；探测链全程 `fetch` 直连 HTTP → 服务端 handler → 服务端 settings 面。**假设 A（v0.7.3 写路径全灭致探测固化确定性失败）机制级证伪**——探测固化从未走那条断路。

### 1.2 假设逐一裁决

**假设 A（v0.7.3 写路径全灭→定级从未落盘）——❌ 证伪**
- git 实证：`ed3c784`（MAINT-025 修复）变更 = lib/client.js + scripts/client-smoke.mjs + 两个 test 文件，**lib/index.js 零改动**；`v0.7.2→v0.7.3 lib/index.js` diff 仅 MAINT-021 命名空间接缝（import 形态），探测链函数体不变；`v0.7.3→HEAD` lib/index.js 无 diff。
- v0.7.2 探测链用户实测验证通过（EVD-023，2026-08-27「③探测固化正确」）——同源代码在 v0.7.3/v0.7.4 行为一致。
- 磁盘工件实证（§1.3）：探测产物（7 键声明）**在盘**。

**假设 B（探测结果展示为内存瞬态，刷新/重启不回显）——✅ 证实（代码级）**
- `probeResults`/`probeSummary`/`probeProgress` 均为 StatsPanel 局部 useState（lib/client.js:328-332）；组件卸载即失。挂载路径（useEffect :335-369）只拉统计与模型目录，**无任何从 pin/probeEfforts/声明重建结果表的逻辑**。
- 判定：by-design 瞬态展示 × 用户「保留」期望 = **需求差**（README:38/40 承诺的是「能力声明持久化」，从未承诺结果历史回显——但 UX 文案「一键探测全部模型并固化配置」引发保留预期合理）。

**假设 C（固化链路仍有断裂）——✅ 部分证实（精确定位三处，均非「数据丢失」）**
- **C1（决定性，进程内证明 P1）**：全 7 档可用模型 → 临时声明=working 集 → 收敛 no-change（lib/index.js:1081 `return { writes: 1, skipped: 'no-change' }`，**不经过 :1043-1047 的 replace+persistProbeEfforts**）→ pin 不落盘（MAINT-019 P3-1 实锤）→ 客户端 /probe/apply 见 current==verified → `already-verified` writes=0（lib/index.js:1279-1281，MAINT-019 P2-2 实锤）→ probeDone「固化 0 处」（lib/client.js:411 `applied.writes ?? 0`）。**能力声明本身正确在盘**（临时声明即最终态），坏的是计数口径与 pin。
- **C2**：探测目标 12 个来自 modelCatalog 全组（lib/client.js:354-366，跳过 -router 组）；持久化只写 llm-pi-ai **用户配置内**的模型——converge `model-not-in-pi-ai-config`（lib/index.js:1002-1004）/apply `not-in-pi-ai-config`（lib/index.js:1230-1233）静默跳过，UI 无任何标注。本例 glm-local 2 模型在配置内，其余 10 个目标的结果**真不保留**。
- **C3（次级，未兑现于本例）**：`persistProbeEfforts` 失败仅 warn（lib/index.js:334-341）静默于 UI；converge 仅在 `tempDeclWritten` 时触发（lib/index.js:1201-1203）——已声明全词表的模型完全依赖客户端后续 /probe/apply（该 fetch 失败则本轮零持久化）。

### 1.3 磁盘实证（$DSH_HOME 只读，secret 已脱敏）

```
llm-pi-ai.providers.glm-local:      # api: openai-completions, baseURL: open.bigmodel.cn
  models[glm-5.3].reasoningEfforts:   {off:null, minimal:minimal, low:low, medium:medium, high:high, xhigh:xhigh, max:max}   ← 7 键全量词表
  models[glm-5.3-flash].reasoningEfforts: 同上 7 键
  reasoning: high                     ← MAINT-028 铁证（见 §2）
llm-reasoning: { level: max, syncDefaultAgent: true }   ← probeEfforts/models/purposes 均缺失
llm-deepseek: { reasoningEffort: max }
agent-default-model: { provider: glm-local, model: glm-5.3, reasoningEffort: max }
```

- 7 键含 xhigh = `buildFullVocabDeclaration`（lib/index.js:973-979）专属产物；生成表无 xhigh（lib/index.js:83-86）→ **探测固化已发生且存活**。
- `probeEfforts` 缺失 = C1 no-change 路径不写 pin 的直接工件（与 P1 证明输出逐字段一致）。
- 状态行「已应用：1 个路由 / 2 个模型」= presence 计数（lib/client.js:743-750）：1=glm-local.reasoning 存在（值 high），2=两模型声明存在——与截图吻合。

### 1.4 进程内可执行证明（P1，真实 lib/index.js + 桩 ctx）

种子 = 用户磁盘同构（glm-local 无声明模型 + level max）；llm.stream 恒返回 stop（全档可用）：

```
P1-a boot 自动声明键集: high,low,max,medium,minimal,off          ← applyLevel 生成 6 键 + 路由默认 max
P1-b /probe working = off,minimal,low,medium,high,xhigh,max       ← 词表 7 档全可用
P1-c 探测后声明键集 = ...,xhigh（7 键）                            ← 临时声明留存 = 用户磁盘形态 ✓
P1-d 探测后 pin（probeEfforts）= "(ABSENT)"                        ← no-change 不写 pin ✓（缺陷）
P1-e /probe/apply = {"writes":0,"skipped":[{reason:"already-verified"}]} ← 计数恒 0 ✓（缺陷）
P1-f apply 后 pin = "(ABSENT)"
```

修复后链路是否端到端可用：**是**（探测→声明持久→重启存活机制完好，v0.7.4 与 v0.7.2 同源）；坏的是 pin/计数/回显/越界目标透明度四处展示与账本语义，见 §4。

### 1.5 MAINT-027 五个为什么（≥3 层，含系统性层）

1. **为何用户说「探测结果不会保留」？** 探测区刷新后空白（结果表是 useState 瞬态）、「固化 0 处」计数、模型级默认区空（探测本就不写 `llm-reasoning.models`，那是另一功能）——三重视觉信号都指向「没保存」。
2. **为何计数显示 0 而实际已固化？** 全可用模型的收敛 no-change 路径不写 pin 也不改声明（lib/index.js:1081），客户端 apply 又把「已一致」计为 already-verified/0（:1279-1281）——「固化 N 处」的口径 = apply 写入数，从不计入收敛成果与「已一致」状态（MAINT-019 P2-2/P3-1 的叠加兑现）。
3. **为何 10/12 个模型的结果真的没保留？** 探测目标按目录全组收集，持久化按 llm-pi-ai 用户配置裁剪，两者集合不一致且跳过静默（lib/index.js:1002-1004/1230-1233）——「测量一切，只持久化配置内」的边界从未向用户表达。
4. **为何展示层与持久层没有共享的结果记录？**（系统性）探测功能从 v0.4「实测按钮」演进到 v0.7.x「探测+收敛+固化」，**唯一被建模的持久产物是能力声明**；「一次探测」作为用户事件（何时、测了什么、结局如何）从未有持久实体——UI 只能展示内存态。EVD-023 验收验证的是能力效果（模型选择器出现等级），从未验收「探测区回显」。
5. **为何这类「展示承诺 × 账本现实」断裂反复出现？**（系统性根因）插件的核心账本（myRouteReasoning/myModelEfforts/verifiedEfforts/pin）分布在**内存 Map + settings 字段**两层且不完整（pin 在 no-change 缺写、路由账本完全不持久），而 UI 摘要（appliedSummary/probeDone）基于**字段存在性**而非值语义——没有任何单一事实源回答「插件现在实际应用了什么」。MAINT-025（信封/元数假设替代契约）与本例（存在性替代值相等）同族：**断言建立在不被校验的间接信号上**。

---

## 2. MAINT-028 分析

### 2.1 等级决策与注入链全景（file:line）

| 层 | 机制 | 位置 |
|---|---|---|
| 全局默认（pi-ai 路由） | `providers[route].reasoning = level`（声明式，非逐请求注入） | lib/index.js:463-475（所有权门控 :468） |
| 全局默认（DeepSeek 官方） | `llm-deepseek.reasoningEffort = level`（直写无门控） | lib/index.js:492-513 |
| 全局默认（agent 默认模型） | `agent-default-model.reasoningEffort = level`（syncDefaultAgent，直写） | lib/index.js:516-534 |
| 模型级默认注入（loop 请求） | `agent/request`：仅 `cfg.models[provider/model]`；**显式 effort 直接尊重** | lib/index.js:587-605（:590 guard） |
| purpose/模型级注入（手建调用） | `llm/stream`：purposes → models 两级；全局 level **不在此注入** | lib/index.js:737-759 |
| 路由默认物化（wire 层） | adapter 内 `resolveReasoningLevel(model, options.reasoningEffort ?? profile.reasoning)` | dsh-llm-pi-ai:1756（经 dsh-llm adapterStream:1656-1689，**在插件 hook 之后**） |
| 会话显式选择物化 | selectModel → resolveCallConfig：`requested ?? reasoning.defaultEffort` 写入会话选择 | dsh-api-session-controller:600-629 + dsh-llm:1559-1584 |
| 输入区控件显示 | `state.current?.reasoningEffort ?? model.reasoning.defaultEffort` | dsh-client-ui-model-selection:422 |
| 切换模型时发送 | `selection.reasoningEffort = model.reasoning.defaultEffort`（目录默认，**显式**） | dsh-client-ui-model-selection:411-419 |

### 2.2 假设逐一裁决

**假设 A（输入区控件为宿主自有状态，插件仅 wire 注入不接管显示）——✅ 证实（但非根因）**
- 控件数据源 = 宿主 session 选择 + 目录 defaultEffort（model-selection:411-422）；插件 inject 面（lib/client.js:942 `['slots','locale','remote','remote.settings','remote.session']`）只有 settings 读写与 modelCatalog 读——**无 session.selectModel 写入口**，插件确实无法直接同步控件。
- 但 defaultEffort 本身 = `profile.reasoning`（pi-ai:1724/1640）——**插件写入的路由默认正是控件的默认来源**。路由默认正确（max）时：切换模型 → 目录 defaultEffort=max → 宿主物化显式 max → 控件显示最大 ✓。因此「控件不同步」不是缺陷本身，**陈旧的路由默认才是**。

**假设 B（切换后部分调用未注入 → (默认)×17）——✅ 语义判明（记账口径，非注入失败）**
- `(默认)` = llm/stream hook 入口 `options.reasoningEffort` 为空（lib/index.js:698 beginRecord / :721 effortKey）——发生在物化之前（物化在 adapterStream 内部，见 §2.1 表）。
- 这些调用（辅助调用 compaction/session-title——purposes 未设、models 空 → 插件两级注入均无目标；及 router 手建调用）的 **wire 实际携带路由默认**（本例为陈旧 high）。statsHint 文案（lib/client.js:58 声称「默认物化后的最终值」）与实现不符——展示准确性缺陷（同族扫查 §3.4）。
- 「高×4」= 陈旧 defaultEffort=high 被物化为显式选择的那几次切换（或用户显式选 High）；「最大×2039」= 用户手动 max + agent 默认 max 的调用——与「需要手动调整」的症状叙述完全互洽。

**假设 C（显式等级被尊重不覆盖 vs 全局强制覆盖的语义决策）——现状判明 + 裁决项移交**
- 当前代码行为：显式 effort（含宿主物化的 defaultEffort）**永远优先**（lib/index.js:590；README:19「显式选择永远优先」/ :21 优先级链）——与文档承诺一致，非缺陷。
- 但「显式」的构成里混入了**宿主物化的路由默认**——当路由默认陈旧时，用户看到的是「我的全局设置被无视」。修复 F1(028) 后路由默认恢复正确，切换即物化 max，语义无需变更；**是否进一步要求「全局强制覆盖一切显式选择」属语义变更，需用户裁决**（见 §6）。

### 2.3 进程内可执行证明（P2，真实 lib/index.js + 桩 ctx，模拟重启=新 apply(新 ctx) 共享同 store）

种子 = 用户磁盘现状（reasoning: high + 双模型 7 键声明 + level max）：

```
P2-a 重启后 applyLevel(level=max)：路由 reasoning = high     ← 卡死（缺陷实证，RED）
P2-b 对照 llm-deepseek.reasoningEffort = max                  ← 无所有权门控路径已正确升级
P2-c 对照（无先验值）：路由 reasoning = max                    ← 门控放行条件 current===undefined ✓
P2-d 同进程 high→max（无重启）：先写 high → 升级后 = max       ← mineLevel 在内存时可认领 ✓
P2-e 重启后 enabled=false：路由 reasoning 仍 = high            ← 还原路径同样失忆（同族缺陷）
```

结论：断裂维度精确为**重启后的台账失忆**（myRouteReasoning 纯内存，lib/index.js:177-179；写入登记 :480-484）。模型能力声明因**形状识别**（isGeneratedEfforts/isFullVocabShape，lib/index.js:239-251）跨重启可认领——这正是「模型声明能升级而路由默认卡死」不对称的机制解释：路由 reasoning 是裸字符串等级值，无形状可识别，只能靠台账，而台账不持久。

### 2.4 MAINT-028 五个为什么（≥3 层，含系统性层）

1. **为何切换到 glm-5.3 控件显示 High、请求带 high？** 目录 defaultEffort=high ← `profile.reasoning='high'`（pi-ai:1724/1640）；宿主切换模型把它物化为会话显式选择（model-selection:417 + session-controller:604-614 + dsh-llm:1570-1576）→ 插件尊重显式（lib/index.js:590）。
2. **为何路由默认是 high 而全局是 max？** 所有权门控（lib/index.js:468）要求 `current===undefined || current===mineLevel`；'high' 是早期会话（默认 level=high 时代）插件写入或用户手写，重启后 myRouteReasoning 清空 → 插件无法认领 → 永不升级（P2-a 实证；P2-d 证明同进程可升级）。
3. **为何台账不持久？** v0.6.0 架构把「我写的 vs 用户写的」区分寄托于内存 Map（apply 生命周期），设计时未考虑「插件跨重启持续管理自己写入」的场景——probeEfforts pin（模型声明侧）后来补了持久化，路由侧从未补。
4. **为何用户与验收都没发现？** 状态行按存在性计数（lib/client.js:743-744），陈旧 high 显示为「已应用 1 个路由」紧邻「DeepSeek 官方：最大」——值不匹配被 presence 掩盖；统计大头是最大（agent 默认/手动 max），wire 多数正确——只有「切换瞬间」暴露，而所有验收（EVD-023/EVD-028/EVD-032）都未包含「改全局等级→重启→切换模型→核对控件与 wire」这一序列。
5. **为何这类跨重启状态断链系统性存在？**（系统性根因）插件对宿主命名空间的写入是**持续管理承诺**（跟随 level 变化、可撤销），但其所有权凭据是**会话态**；同时宿主把目录默认物化为显式选择的机制，使任何陈旧插件写入都会被宿主放大成用户可见行为。「写入的凭据生命周期」与「写入的管理承诺生命周期」不匹配——同族还有 disable 后无法还原（P2-e）、llm-deepseek 的 myDeepseekEffort 还原失忆、模型声明 revert 失忆（§3.1）。

---

## 3. 同类扫查（同模式断裂点全清单）

| # | 同模式点 | 证据 | 判定 |
|---|---|---|---|
| 3.1 | **所有权台账失忆族**：disable 后 revertPiAi/revertDeepseek 同样无法认领（mineLevel/mine/myDeepseekEffort 全内存）→ 关闭开关后插件写入的路由默认/模型声明/llm-deepseek 残留 | lib/index.js:472-474/547-553/568（全部要求 mine!==undefined）；P2-e 实证路由侧 | **同族缺陷**（与 F1(028) 一并修） |
| 3.2 | 形状识别的边界：手写 7 键全量+自定义 wire 被判「生成」走替换（MAINT-019 P2-1 已登记） | lib/index.js:248-251 仅按 key 集 | 已登记，不重复 |
| 3.3 | converge 仅 tempDeclWritten 时触发：已声明全词表模型的持久化完全依赖客户端 /probe/apply fetch 成功 | lib/index.js:1201-1203 | 边界依赖（F3(027) 一并覆盖） |
| 3.4 | statsHint 文案 vs 记账实现：「默认物化后的最终值」不真——物化在 hook 后 | lib/client.js:58（zh/en 两处）+ dsh-llm:1656-1689 | 展示准确性缺陷（F3(028)） |
| 3.5 | appliedSummary presence 计数（值盲） | lib/client.js:740-750 | **本批次根因放大器**（F2(028)） |
| 3.6 | persistProbeEfforts/persistStats 失败仅 warn，UI 无感 | lib/index.js:334-341/681-684 | 次级（防护日志已有，建议端点暴露 error 计数） |
| 3.7 | 探测目标（目录全组）与持久化域（llm-pi-ai 用户配置）集合不一致，静默跳过 | lib/client.js:354-366 + lib/index.js:1002-1004/1230-1233 | **本批次根因成分**（F4(027)） |
| 3.8 | glm-local-router provider（dsh-agent-router 注册）不在 llm-pi-ai 用户配置 → 本插件路由默认不覆盖它；(默认)×4 与其 (默认) 记账同 3.4 | settings.yaml 仅 glm-local/openai-codex | 范围外记录（移父会话评估是否与 agent-router 插件协调） |
| 3.9 | 宿主 saveSelection 把每次选择存为 agent 默认（session-controller:616）——与 syncDefaultAgent 直写存在双写者，用户手动 max 会固化进 agent-default-model（本例已是 max，无冲突表现） | dsh-api-session-controller:614-618 | 记录级（语义上两者同向，暂无缺陷表现） |

---

## 4. 修复方案（供 Developer，分任务；本阶段未写码）

### MAINT-027（目标：探测的「保留」在 UI 与账本双重可感）

- **F1(027) 计数与措辞诚实化（P1，一并正式解决 MAINT-019 P2-2）**：/probe 响应增加每模型持久化结局（`persisted: 'converged' | 'no-change-already-correct' | 'skipped:not-in-pi-ai-config' | 'skipped:no-working'`）；client probeDone（lib/client.js:75/153 probeDone 文案函数）按结局渲染：「能力声明已与实测一致（无需改动）」/「固化 N 处」/「M 个模型不在 llm-pi-ai 配置——结果仅展示，未写入」。
- **F2(027) no-change 路径补写 pin（P1，解决 MAINT-019 P3-1）**：convergeProbeDeclarationCore 的 no-change 分支（lib/index.js:1081 前）同样 `verifiedEfforts.set` + `persistProbeEfforts`（幂等合并已内建）——重启后 pin 在、hydrate 恢复、UI 可据此回显。
- **F3(027) 探测结果持久回显（P2，需求差方案）**：服务端把 lastProbe（时间戳 + 每模型 working/rejected/blocked/持久化结局）并入 `llm-reasoning.lastProbe`（或 storages 文件，二选一由 Developer 按 schema 演进评估）；/probe 与 /probe/apply 收口时更新；client StatsPanel 挂载时从 /reasoning-level-stats 读取并重建结果表（空态文案区分「从未探测」）。同时天然覆盖 3.3（converge 未触发的模型也经 apply 记录结局）。
- **F4(027) 越界目标透明化**：结果表加「持久化」列（数据源 = F1 结局字段）。

### MAINT-028（目标：全局等级跨重启持续管理自己写入的路由默认）

- **F1(028) 所有权台账持久化（P0 修复核心）**：llm-reasoning 新增持久字段（建议 `applied: { routes: {route: level}, deepseek: level|null }`；模型声明侧已有 probeEfforts pin + 形状识别，可不动）；boot 时 hydrate 进 myRouteReasoning/myDeepseekEffort；applyPiAi/revertPiAi/applyDeepseek/revertDeepseek 的所有权判定改用「持久台账 ∪ 内存台账」；写入成功后同步更新持久字段（settings.mutate set path）。修复后 P2-a 变 max、P2-e 可还原。
- **F2(028) 状态行值感知（P1 配套）**：appliedSummary 对每个 reasoning!==undefined 的路由显示值，与全局 level 不一致时警示（「glm-local: high ≠ 全局 max（历史遗留，修复后将自动跟随）」）。
- **F3(028) (默认) 记账语义与 statsHint 修正（P2）**：beginRecord/settleRecord 对 effort===null 的记录尝试用 effortsCache/profile 推导将物化的默认并另记（或最近调用表 effort 列显示「未显式→high」复合标签）；statsHint（lib/client.js:58 zh/en）改为与实现一致的措辞。
- **F4(028) README 澄清（P2，随 F1 发布）**：说明切换模型会把路由默认物化为会话显式等级（宿主行为）；全局默认的对象是「无显式选择的调用 + 目录默认」，显式选择永远优先。

### 实施顺序建议

F2(027)+F1(027)（小，先止血计数/pin）→ F1(028)+F2(028)（核心）→ F3(027)（回显，含 F4）→ F3(028)/F4(028)。MAINT-027/028 同文件 lib/index.js，按 triage 串行。

---

## 5. 回归防护设计（判别用例/冒烟增强；本阶段出设计不实现）

1. **test/probe-persistence.test.mjs（判别组，真实工件）**：固化本报告 §1.4/§2.3 harness（真实 lib/index.js + 桩 settings/llm/webServer，node --test 无浏览器依赖）：
   - 用例 a：全 7 档可用模型探测 → 断言 probeEfforts 落盘（**F2(027) 前 RED**）+ /probe 响应含持久化结局（**F1(027) 前 RED**）+ 声明 7 键在盘（现状 GREEN，防倒退）；
   - 用例 b：部分档位可用（llm.stream 按 effort 拒绝 xhigh）→ 收敛写入 + pin 落盘（现状已 GREEN——防止修复扰动收敛主路径）；
   - 用例 c：not-in-pi-ai-config 模型 → 响应结局显式 skipped（**F1(027) 前 RED**）。
2. **test/route-default-restart.test.mjs（判别组，MAINT-028 核心）**：两段 apply(新 ctx) 共享 store 模拟重启：
   - 用例 d：reasoning=high + level=max 重启 → 断言变 max（**F1(028) 前 RED**）；
   - 用例 e：无先验值 → 写 max（现状 GREEN）；同进程 high→max（现状 GREEN）——锁定断裂维度唯一性；
   - 用例 f：插件写入后重启 + enabled=false → 断言 reasoning 被移除（**F1(028) 前 RED**，覆盖 3.1 同族）；
   - 用例 g：llm-deepseek 对照（升级 GREEN + 重启还原 RED）。
3. **client-smoke 增强**：StatsPanel 挂载渲染 lastProbe（F3(027) 后）；appliedSummary 值感知渲染（F2(028) 后）。
4. **验收清单回灌（M7.7）**：用户真实环境验收固定增加——「改全局等级→重启 DSH→切换模型→控件应显示全局等级 + 会话日志 request/header 的 reasoningEffort=全局等级」；「一键探测→刷新页面→探测区仍显示上次结果（F3(027) 后）」。

---

## 6. 语义裁决项（需用户决定，不替用户决定）

**D-1（MAINT-028 主裁决）：无法认领的既有路由默认（值≠全局等级、无台账）如何处理？**
- 选项 a（推荐）：**持久台账修复**（F1(028)）——保留「用户手改的配置永不被覆盖」承诺（README:19）；陈旧插件写入因台账恢复认领而自动跟随；真正用户手写的值仍被尊重（可配合 F2 状态行提示用户自行处理）。
- 选项 b：**全量收编**（allSupport 即覆盖任何 reasoning 值）——实现最简、立即治愈所有陈旧值；但破坏「用户手改不覆盖」承诺，用户手调某路由低档的合法用法会被全局抹掉。
- 选项 c：**维持现状 + 一次性清理指引**（README 教用户删 reasoning 字段）——零代码风险，但每个新用户都可能再踩。

**D-2（MAINT-028 次裁决）：是否要求「全局默认覆盖会话/控件的显式选择」？**
- 现状：显式优先（README:19/21 承诺，lib/index.js:590）。F1(028) 修复后，切换模型物化的显式值=正确的全局等级，complaint 自然消失——**建议不动语义**。
- 若用户期望「无论控件选什么，一律按全局发」：需新增覆盖模式（如 `overrideExplicit: true`）+ 重写 agent/request/llm/stream 两处 guard——语义变更大，需单独 triage。

**D-3（MAINT-027 范围裁决）：探测结果持久回显（F3(027)）是否入 0.7.5？**
- 入：用户「保留」期望被完整满足（推荐，工作量 1 个 session 内）。
- 不入：0.7.5 只做计数/pin 止血（F1/F2），回显挂 0.7.6+——用户仍会在刷新后看到空探测区（但「固化 N 处/已一致」文案 + 能力声明可查）。

---

## 7. 证据缺口清单（诚实声明）

1. **浏览器级端到端未实测**（只读约束）：切换模型→控件显示 High 的链路经宿主源码 file:line 闭合（model-selection:417/422 + pi-ai:1724/1640 + session-controller:600-629），且磁盘 `reasoning: high` 与截图 High 直接互证；残余风险低。阶段 2 Developer 判别测试 + 用户 M7.7 验收补最终闭环。
2. **路由 'high' 的写入者不可考**：插件早期会话（默认 level=high 时代）写入 vs 用户手写，磁盘形态无区分度——影响 D-1 选项语义（台账修复对两者行为不同），已列裁决项而非假设。
3. **用户最后一次探测的时间/版本不可考**：工件形态（7 键+xhigh 声明、pin 缺失）与 v0.7.2/v0.7.3/v0.7.4 任一版本探测链行为一致（三版 lib/index.js 探测函数同源，git 实证）——不影响根因判定与修复方案。
4. **(默认)×17 逐调用来源未重构**：记账语义已判明（hook 入口捕获、物化在其后）；recent 缓冲不落盘（lib/index.js:35 注释），无法回溯逐条 purpose。阶段 2 可在 F3(028) 中顺带让记账携带物化结果。
5. **glm-local-router provider 未检视**：dsh-agent-router 插件注册的 provider，不在本仓库范围（3.8 记录）。
6. **桩与真实的差异声明**：P1/P2 证明使用桩 settings/llm——桩按 dsh-settings 服务端面语义实现（get/describe 同步返回深拷贝、replace/mutate async）；「探测链是否受 MAINT-025 影响」的判据是**调用面与 git diff**（不经客户端 remote），不依赖桩；用户真实环境探测端到端由 v0.7.2 EVD-023 用户实测背书 + 本报告磁盘工件互证。

---

## 8. 真实环境操作上报（R4——逐条；本任务对真实环境仅只读探查）

| # | 命令（读操作） | 退出码 | 影响路径 | 写语义 |
|---|---|---|---|---|
| 1 | Get-Content `$HOME\.dsh\settings.yaml`（节选 4 命名空间至 %TEMP% 中转文件，secret 正则脱敏，用后已删） | 0 | `C:\Users\peter\.dsh\settings.yaml`（只读） | 无（中转文件已删，核实） |
| 2 | Get-ChildItem / Select-String / Get-Content 于 npx 宿主 checkout（dsh-client-ui-model-selection、dsh-api-session-controller、dsh-llm、dsh-llm-pi-ai 源码节选读取） | 0 | `C:\Users\peter\AppData\Local\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\*`（只读） | 无 |
| 3 | Copy-Item 工作树 lib/index.js + 宿主 schemastery/cosmokit → `%TEMP%\rca027028`；node driver.mjs（进程内证明）；Remove-Item 临时目录 | 0 / 0 / 0 | 写仅 `%TEMP%\rca027028\`（平台临时区，**已删核实**）；源路径只读 | 无工作区/真实环境写 |
| 4 | git log / show --stat / diff / status（工作树） | 0 | 工作树 `.git`（只读） | 无 |

- **$DSH_HOME 零写零删**（红线遵守）；R1 三选一不适用（无真实环境写操作）。
- 工作树 `git status --porcelain` 空（未改任何产品文件；唯一新建 = 本报告 docs/retro/rca-MAINT-027-028.md）。

---

## 附：硬门槛自检

| 门槛项 | 状态 |
|---|---|
| 开发原则 1（结论基于事实） | ✅ 全部结论附 file:line / git 输出 / 磁盘工件 / 进程内证明；假设逐一标注证实/证伪/待证 |
| 5-Why ≥3 层含系统性层 | ✅ 两任务各 5 层（第 4/5 层系统性；两任务系统性根因同族归一：断言建立在不被校验的间接信号上） |
| 同类扫查有痕迹 | ✅ §3 九项（含已登记项交叉引用） |
| 预防措施=方案落地（本阶段=设计） | ✅ §4 修复方案（到函数/字段级）+ §5 回归防护（含 RED 判据） |
| mock/桩不当真实链路证据 | ✅ §7-6 桩差异显式声明；判据用调用面+git+磁盘工件+用户实测背书 |
| $DSH_HOME 只读红线 | ✅ §8 逐条上报，零写零删 |
| 阶段 1 不改产品代码 | ✅ 唯一写入 = 本报告；git status 净 |
| 不与用户交互/不创建子 agent/语义裁决出选项 | ✅ §6 三项裁决（D-1/D-2/D-3）附选项与影响，未代决 |
