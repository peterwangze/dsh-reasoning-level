# 设置页 UI/UX 重构设计规范 — v0.9.0

> 任务：UX-003（观感）+ FEAT-004（易用性）+ FEAT-005（洞察）
> 决策依据：DEC-020（2026-10-20 用户三题确认）；风险：RISK-005（渲染层大改）
> 事实基线：`GET /reasoning-level-stats` 实测 81,926 次调用 / 等级近乎全 `max` / 除 deepseek-official 外 `reasoningTokens=0` / `openai-codex/*` 探测 7 档全 blocked / deepseek-official 探测 `skipped:not-in-pi-ai-config`

## 0. 问题陈述（现状 → 后果）

| 现状（lib/client.js 实测） | 用户后果 |
| --- | --- |
| 等级是裸 `<select>`，7 个中文短词（关闭/极低/…/最大），无含义、无代价、无适用场景 | 用户不知道 `high` 与 `max` 的实际差别 → 全部调 `max`（活体证据：glm-5.3 `max`×20,084、`high`×5） |
| 页面顶部只有一行长句状态（`已应用：…；…；DeepSeek 官方：…`） | 无法一眼回答「我现在到底在用什么」 |
| 模型级默认需在 `<select>` 长下拉（按 provider 分组）中翻找 | 多路由环境（活体 30+ 模型）下添加一个模型成本高 |
| 支持能力只在「已配置行」里显示 | 不知道哪些模型支持哪些档 → 全局设成某档会波及谁不可预知；实际存在「7 档中 deepseek 只接受 4 档」的结构性错配 |
| 探测结果只有 `working / rejected / blocked` 三列 chips | `blocked` 是黑盒：4 个模型全 7 档 blocked，页面只说「无可用等级」，用户无从判断是认证、模型下线还是网关拒绝 |
| `persisted` 列显示「不在 llm-pi-ai 配置——仅展示，未写入」 | 探测成功却「没生效」，无下一步指引 |
| 思考量列大量 `—`（网关不回报 `reasoningTokens`） | 用户以为「没有思考」，实际是有思考但不可观测 |
| 表格 hover 用 React state 模拟、无 `:focus-visible`、无 `aria-*` | 键盘与辅助技术不可用；hover 抖动 |
| 全部样式内联，无法表达 hover/focus/media query/transition | 观感受限；移动端/窄面板布局塌陷 |

## 1. 硬约束（不可违反）

1. **单文件自包含**：`lib/client.js` 由宿主 `makeRequire` 加载，无文件系统解析能力，**不得 import 任何模块**（除 `react`）。
2. **零运行时依赖**；`dependencies` 恒空；`peerDependencies` 全 `*`。
3. **只允许 `react.createElement`**：无 JSX、无 CSS 模块、无第三方 UI 库。
4. **配置 schema 与写路径语义零变更**：`enabled` / `level` / `syncDefaultAgent` / `models`（增/改/删）/ `purposes.compaction` / `purposes.session-title` 七个写入口必须全部保留，调用形状不变（`settings.update({ns, patch})` 与 `settings.mutate({ns, ops:[{op:'unset',path}]})`）。
5. **宿主契约不变**：`hostApiFace` 适配层（describe/update/mutate + session.modelCatalog）与 `HOST_REMOTE_CONTRACT` 镜像段**一行不改**（`test/host-compat-single-source.test.mjs` 锚定）。
6. **服务端新增字段必须向后兼容**：旧客户端忽略新字段不得崩；新客户端在旧服务端（无新字段）下必须优雅降级。
7. **零文档迁移**：用户配置、探测产物 `probeEfforts`、`lastProbe`、`applied` 台账形状不变。
8. **CSV 导出、探测、撤销、i18n zh/en 双全** 为功能红线（不得因重构丢失）。

## 2. 样式体系：从内联样式迁移到注入式样式表

### 2.1 机制

新增 `ensureStyles()`：一次性向 `document.head` 追加 `<style data-dsh-reasoning-level="1">`，内含全部 `.rl-*` 规则。

```js
const STYLE_ID = 'dsh-reasoning-level-styles'
function ensureStyles() {
  try {
    if (typeof document === 'undefined' || document.head === null || document.head === undefined) return
    if (document.getElementById(STYLE_ID) !== null) return
    const style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = STYLESHEET
    document.head.appendChild(style)
  } catch (error) { /* 样式是渐进增强：失败时退化为无样式，不得影响渲染 */ }
}
```

- 在模块 `apply(ctx)` 内调用一次；`ReasoningPage` 首帧再调一次（幂等，覆盖 HMR/重挂载）。
- 无 `document` 环境（`scripts/client-smoke.mjs` 的 vm 沙箱）→ 静默跳过，组件仍必须渲染出完整节点树（冒烟只看结构与文本）。
- **全部选择器 `.rl-` 前缀**，禁止裸标签选择器、禁止 `!important` 用于布局（仅允许用于覆盖宿主 resets 的极小集合，且必须注释说明）。

### 2.2 设计令牌（CSS 自定义属性，挂在 `.rl-root`）

```css
.rl-root {
  --rl-fg: currentColor;                            /* 文本继承宿主 currentColor，天然跟随明暗 */
  --rl-muted: 0.62;                                 /* opacity 用变量不便，改用颜色混合 */
  --rl-line: rgba(128,128,128,.28);
  --rl-line-strong: rgba(128,128,128,.45);
  --rl-surface: rgba(128,128,128,.07);
  --rl-surface-2: rgba(128,128,128,.11);
  --rl-hover: rgba(128,128,128,.14);
  --rl-accent: rgba(25,118,210,.72);
  --rl-accent-soft: rgba(25,118,210,.14);
  --rl-ok: rgba(46,125,50,.95);
  --rl-ok-soft: rgba(76,175,80,.18);
  --rl-warn: rgba(178,106,0,.95);
  --rl-warn-soft: rgba(255,167,38,.2);
  --rl-bad: rgba(198,40,40,.95);
  --rl-bad-soft: rgba(229,57,53,.16);
  --rl-r-card: 12px; --rl-r-ctl: 8px; --rl-r-chip: 999px;
  --rl-s1: 4px; --rl-s2: 8px; --rl-s3: 12px; --rl-s4: 16px; --rl-s5: 24px; --rl-s6: 32px;
  --rl-f-xs: 11px; --rl-f-sm: 12px; --rl-f-md: 13px; --rl-f-lg: 15px; --rl-f-xl: 20px;
  --rl-t: 140ms cubic-bezier(.2,.7,.3,1);
}
```

> 主题策略保持 UX-001 的「半透明灰阶 + currentColor」：**不读宿主主题 API**，明暗底上均可读。

### 2.3 响应式

```css
.rl-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: var(--rl-s4); }
@media (max-width: 720px) { .rl-split { grid-template-columns: 1fr } .rl-hide-sm { display: none } }
```

### 2.4 动效与无障碍

- `transition: background-color var(--rl-t), border-color var(--rl-t), opacity var(--rl-t)`，仅用于颜色/透明度，**不做位移/缩放**。
- `@media (prefers-reduced-motion: reduce) { .rl-root * { transition: none !important } }`
- `:focus-visible { outline: 2px solid var(--rl-accent); outline-offset: 2px; border-radius: inherit }`
- 所有交互控件带 `aria-label`（无可见文本时）或可见 label；`role`/`aria-live` 见 §5。

## 3. 信息架构（页面自上而下）

当前 5 卡 → 重构为 **页头 + 概览 + 4 个功能区 + 说明**：

```
┌────────────────────────────────────────────────────────────────┐
│ ① PageHeader  标题 · 一句价值主张 · 状态胶囊 · 主操作（探测）      │
├────────────────────────────────────────────────────────────────┤
│ ② Overview    4 个 StatTile（当前默认等级 / 生效范围 / 调用总量 /   │
│               思考量可观测性）                                    │
├────────────────────────────────────────────────────────────────┤
│ ③ 全局卡      总开关 · 等级分段控件（含影响预览）· 同步 agent 开关  │
├────────────────────────────────────────────────────────────────┤
│ ④ 模型级卡    搜索 + 已配置行 + [可折叠] 支持矩阵                  │
├────────────────────────────────────────────────────────────────┤
│ ⑤ 辅助调用卡  两行紧凑排布（compaction / session-title）           │
├────────────────────────────────────────────────────────────────┤
│ ⑥ 观测卡      工具栏（暂停/只看异常/导出/探测）· 模型聚合表 ·       │
│               等级对比（FEAT-005）· 最近调用                       │
├────────────────────────────────────────────────────────────────┤
│ ⑦ 说明        既有 details 渐进披露（文案保留，措辞按新语义校正）    │
└────────────────────────────────────────────────────────────────┘
```

**布局**：③⑤ 在宽屏（≥1080px）左右并排（`grid-template-columns: 1.6fr 1fr`），窄屏单列。

### 3.1 ① PageHeader

- 标题 `统一推理等级`（`t('title')`）+ 副标题一句：`一个开关管理所有模型的默认思考强度`（新增 i18n key `pageSubtitle`）。
- **状态胶囊组**（`StatusPill`）：
  - `启用中` / `已停用`（`enabled`，绿/灰）
  - `默认：高`（当前等级，主色）
  - `生效 3 路由 · 2 模型`（求和）
  - 契约不兼容时追加红色 `功能降级`（复用 `contractWarn` 数据源）
- 主操作按钮 `一键探测全部模型并固化配置`（原在观测卡，**上移到页头**——它是页面里最重的动作）；探测进行中显示进度文案并 disabled。

### 3.2 ② Overview（StatTile ×4）

| Tile | 主值 | 副值 | 数据源 |
| --- | --- | --- | --- |
| 当前默认等级 | `高`（大号）+ 档位刻度条 | 该档含义（见 §4.1 `levelHint`） | `value.level` |
| 生效范围 | `3 路由 · 5 模型` | 失配时 `1 路由待同步`（warning 色） | `summary.routes/models` |
| 调用总量 | `81,926` | `自 10:24:07 起` | `stats.totalCalls/since` |
| 思考量 | `9.3M tok` 或 `不可观测` | `4 / 30 模型回报 reasoningTokens` | `stats.models[*].reasoningTokens` |

> 「思考量」Tile 直接回应「除 deepseek-official 外全部 `reasoningTokens=0`」的困惑：把「网关不回报」这件事本身做成可见事实，而不是让表格显示一排 `—`。

`StatTile` 规格：`padding: var(--rl-s3) var(--rl-s4)`；主值 `--rl-f-xl` / 600；副值 `--rl-f-xs` / muted；`min-height: 84px`；hover 背景 `--rl-surface-2`。

### 3.3 ③ 全局卡

1. **总开关**：从裸 checkbox 升级为 `Switch`（`role="switch"` + `aria-checked`），带一句状态说明（开启时「新调用将使用默认等级」/关闭时「本插件写入的配置已还原」）。
2. **等级选择器 = 分段控件（SegmentedControl）**：7 档横排（窄屏换行），每段显示中文档名 + 一行 10px 副标（档位语义，见 §4.1）。选中段：`--rl-accent-soft` 底 + `--rl-accent` 描边 + 600 字重。
   - 键盘：`role="radiogroup"` + 每段 `role="radio"` `aria-checked`；ArrowLeft/ArrowRight 切换焦点，Enter/Space 选中。
   - **不可用档位降级表达**：若当前全局档位不被任何模型支持，不隐藏（会造成「我的设置去哪了」），改为段内显示 `⚠` 并在影响预览里点名。
3. **影响预览（`ImpactPreview`）**：紧贴分段控件下方一行：
   - `影响预览：12 个模型支持「最大」，3 个将跳过（cursor: glm-5.3-flash …）`
   - 数据源 = `llm.models` 目录（页面级共享，见 §3.4）+ 探测固化 `lastProbe`（作为「实测真值优先」的已知支持集）。
   - 计算规则：模型支持集 = `probeEfforts[key]` 实测集（若有）> `model.reasoning.efforts` 目录声明 > 空（未知）。
   - 未知模型不计入「将跳过」，单列 `3 个能力未知`。
4. **同步默认 agent 模型等级**：`Switch` + 一句解释。

### 3.4 ④ 模型级默认卡

1. **搜索添加**：`SearchField`（`placeholder: 搜索模型（provider/model）`）+ 结果下拉（最多 8 条，显示 `provider / model` + 支持 chips）；输入 `provider/model` 精确键也允许（保留原「任意 key」能力）。
   - 空输入时列出去重后的候选（前 20 条）。
   - 选中即添加，等级默认取该模型最高支持档（沿用现逻辑），随后可改。
2. **已配置行**（`ModelRow`，非表格布局的卡片行）：
   ```
   provider / model-name                      [支持: 低 中 高 最大]      [等级 ▾]  [删除]
   ```
   - 支持 chips 中，当前配置档用主色，不支持用 warning + `⚠ 运行时跳过`。
   - 能力未知：显示 `能力未知 · 未探测` + 「探测此模型」快捷按钮（调 `/probe`，带 `models: [key]`）。
3. **[可折叠] 支持矩阵**（`SupportMatrix`）：表格 = 行模型 / 列 7 档 / 单元格 `✓`（支持）/ `✗`（实测拒绝）/ `?`（未知）；默认折叠，标题显示 `30 个模型 · 覆盖率 12/30 已探测`。排序：已探测在前，按支持档数降序。
4. **空态**：`未配置模型级默认——所有未显式选择等级的调用使用全局默认。` + 一个「从最高支持档开始添加」的引导按钮。

### 3.5 ⑤ 辅助调用卡

- 两行：`会话压缩 compaction` / `会话标题 session-title`，各一个 `<select>`（沿用，`follow` + 7 档）+ `已设：关闭` chips。
- 说明一句（`off` 省 token 的理由）。

### 3.6 ⑥ 观测卡

1. **工具栏**（`Toolbar`）：
   - `暂停刷新` / `继续刷新`（`aria-pressed`）
   - `只看异常`（`aria-pressed`；过滤 `errRate>0 || calls===0` 或 `suggestion` 非空）
   - `导出 CSV`
   - 右侧弱文本 `每 2s 刷新 · 最近 100 条`
2. **探测结果区**（保留 + 增强）：
   - 进度：`正在探测 3/17：provider/model` + 线性进度条（`role="progressbar"` + `aria-valuenow`）。
   - 结果表列：模型 / 实测可用 / 实测拒绝 / **其他错误（带归因）** / 持久化。
   - **归因（FEAT-004 ⑦）**：`blocked` 非空时显示错误码 + 一句人话：
     | code 特征 | 归因文案（i18n key） |
     | --- | --- |
     | `UNSUPPORTED_REASONING_EFFORT` 类 | （不会进 blocked，进 rejected） |
     | 含 `auth`/`unauthorized`/`api key` | `凭据或鉴权失败——请检查该 provider 的密钥` |
     | 含 `not found`/`404`/`model` | `模型在该 provider 不存在或已下线` |
     | 含 `rate`/`429`/`quota` | `限流或额度不足——稍后重试` |
     | `aborted`/timeout | `探测超时（30s）——网关无响应` |
     | 其他/未知 | 原样显示 `code: message`（截断 120 字符） |
   - 服务端配合：`lastProbe.models[key]` 新增 `blockedReasons: { [level]: { code, message, kind } }`（旧客户端忽略）。
3. **模型聚合表**：保留列，新增
   - 列头点击排序（calls/思考量/输出/平均耗时/错误率）——`aria-sort`。
   - 「思考」列：`reasoningTokens>0` → `12.4k tok`；否则 `reasoningChars>0` → `~1.2k 字`（附 `aria-label="思考字符近似（网关未回报 reasoning tokens）"`）；都无 → `—`。
   - `suggestion` 列改为可点按钮：`建议用最高档 最大` → 点击即把该模型设为该档（写 `models`）。
4. **等级对比（FEAT-005，新）**：默认折叠，标题 `等级对比（同一模型不同等级的实际代价）`。
   - 数据源 `stats.models[key].byLevel`（服务端新增）。
   - 每个有 ≥2 个等级样本的模型渲染一张小表：等级 / 调用 / 平均耗时 / 平均输出 tok / 平均思考 tok。
   - 无样本时说明：`需要同一模型在两个等级上各跑几次调用才能对比`（回应「全 max」现状：让用户看到自己缺的是什么数据）。
5. **最近调用表**：保留 7 列，行高压缩；`结果` 列 error 用 danger 色；新增**结果过滤**（全部/仅错误）。
6. **思考量不可观测提示**：当 `stats.models` 中回报 rt 的模型占比 < 50% 时，表格下方一行 muted 说明 + `了解如何验证` 折叠（复用既有 hint）。

### 3.7 ⑦ 说明区

保留 `details` 渐进披露，文案按新语义校正（等级含义、优先级、探测语义、物化语义）。**不得**删除既有 4 段 hint，只能增改。

## 4. 文案层（i18n）

### 4.1 等级语义表（新增 `LEVEL_HINTS`，zh/en 双语）

| 等级 | zh 档名 | zh 含义（副标 ≤8 字） | zh 适用场景（hover title） |
| --- | --- | --- | --- |
| `off` | 关闭 | 不思考 | 机械改写/格式化/JSON 修补，追求最快最省 |
| `minimal` | 极低 | 一笔带过 | 简单问答、单轮事实查询 |
| `low` | 低 | 轻量推理 | 摘要、抽取、简单代码补全 |
| `medium` | 中 | 常规推理 | 日常编码、多步指令 |
| `high` | 高 | 深度推理（默认） | 复杂重构、方案设计 |
| `xhigh` | 极高 | 更深推理 | 长链路调试、疑难定位（非所有模型支持） |
| `max` | 最大 | 最深推理 | 难题攻坚；最慢最贵（实测支持才可选） |

en 对照：`Off / Minimal / Low / Medium / High / X-High / Max`；含义 `No thinking / Brief / Light / Standard / Deep / Deeper / Deepest`。

> **UX-002 合并**：`LEVEL_LABELS` 由 zh 单语改为 `{ zh: {...}, en: {...} }`，`levelLabel(l, lang)` 取当前语言；所有展示点（分段控件、下拉、chips、表格、建议、CSV）统一走 `levelLabel`。CSV 跟随当前语言。

### 4.2 新增 key 清单（zh/en 必须成对）

`pageSubtitle` `statusEnabled` `statusDisabled` `statusDegraded` `statusDefault` `statusScope` `tileLevel` `tileScope` `tileCalls` `tileThinking` `tileThinkingUnknown` `tileThinkingCoverage` `levelMeaning` `levelScenario` `impactPreview` `impactSkip` `impactUnknown` `switchOnHint` `switchOffHint` `searchModel` `searchEmpty` `searchExactKey` `supportMatrix` `supportMatrixSummary` `supportYes` `supportNo` `supportUnknown` `probeThisModel` `pauseRefresh` `resumeRefresh` `onlyIssues` `sortBy` `ariaSortAsc` `ariaSortDesc` `thinkingApprox` `suggestionApply` `levelCompare` `levelCompareEmpty` `levelCompareCalls` `levelCompareDuration` `levelCompareOutput` `levelCompareThinking` `probeReasonAuth` `probeReasonNotFound` `probeReasonRate` `probeReasonTimeout` `probeReasonUnknown` `undoSucceeded` `undoAction` `revertedNotice` `saveFailedReverted` `skipRuntime` `notProbed` `coverage` `recentAll` `recentErrorsOnly`

> 现有 key 一律保留；改名需同步 `scripts/client-smoke.mjs` 断言（`demo=高`、`≠全局最大`、`持久化`、`已与实测一致`、`默认→高`）。

## 5. 交互规格

### 5.1 变更与撤销

- 所有写操作统一经 `commit(patch | removeKey)`：
  1. 乐观更新本地 `view.value`（立即反映）；
  2. 发起 `settings.update` / `settings.mutate`；
  3. 失败 → **回滚本地** + 红 toast（含错误文本，`role="alert"`）；
  4. 成功 → 绿 toast + `撤销` 按钮（3s 自动消失，`aria-live="polite"`）。
- 撤销策略：记录 `{ kind:'update', previous: <旧值> }` 或 `{ kind:'unset', key }`；点撤销走反向写（`unset` 删除键 / `update` 写回旧值）。
  - **仅支持一层撤销**（避免栈复杂化）。
  - 撤销本身失败 → 红 toast，不回滚 UI（已显示真实失败）。
- 写操作串行：`busy` 期间禁用全部写控件（沿用），但**不阻塞统计轮询**。

### 5.2 探测

- 入口：页头主按钮 + 支持矩阵每行「探测此模型」。
- 流程与请求形状**完全不变**（`/probe` 逐模型 + `/probe/apply`），仅进度可视化升级。
- 结果持久化回显逻辑不变（`lastProbe` → 结果表）。

### 5.3 统计轮询

- 默认 2s；`暂停`后停止 `setInterval`，恢复即拉一次。
- 组件卸载清理（保留现有 `alive` 守卫）。
- 「只看异常」「排序」「结果过滤」为纯客户端派生，不改请求。

### 5.4 错误与空态

- 数据面失败 → 整页错误态（保留 MAINT-022 R0-F1 的 fail-loud 文本直出），并给「重试」按钮。
- 各卡独立空态（不要用一个「加载中…」覆盖整页：页头与全局卡在 `describe` 成功后才渲染，统计卡可独立显示自己的加载态）。

## 6. 服务端改动（FEAT-005 + FEAT-004 ⑦）

### 6.1 per-level 聚合

`settleRecord` 增加：

```js
const levelKey = record.effort ?? '(默认)'
if (agg.byLevel === undefined) agg.byLevel = {}
const bucket = agg.byLevel[levelKey] ?? (agg.byLevel[levelKey] = { calls: 0, reasoningTokens: 0, outputTokens: 0, reasoningChars: 0, durationMs: 0, errors: 0 })
bucket.calls += 1
if (record.rt !== null) bucket.reasoningTokens += record.rt
if (record.rc !== null) bucket.reasoningChars += record.rc
if (record.ot !== null) bucket.outputTokens += record.ot
if (record.duration !== null) bucket.durationMs += record.duration
if (record.finish === 'error' || record.finish === 'aborted') bucket.errors += 1
```

`statsSnapshot()` 输出 `byLevel`（原样透出，键集合受控——等级键来自 LEVELS + `'(默认)'`，防脏键）。

- **持久化兼容**：`persistStats()`/hydrate 对旧快照（无 `byLevel`）→ 初始化为 `{}`，不得崩。
- **旧字段零改动**：`calls/efforts/reasoningTokens/outputTokens/reasoningChars/durationMs/errors/errRate/rejected/highestUsed/suggestion` 保持原样。
- **`efforts` 与 `byLevel` 的 calls 必须一致**（判别测试）。

### 6.2 探测归因

`probeModelLevelsCore` 返回值增加：

```js
blockedReasons: { [level]: { code, message, kind } }   // 仅 blocked 档位
```

- `recordLastProbe` 与 `lastProbe` 的写入形状同步新增该字段（`test/probe-persistence.test.mjs` 需扩展）。
- 旧数据无该字段 → 客户端按「未知原因」渲染。

## 7. 测试与防护（RISK-005 缓解）

### 7.1 必须新增/更新的判别测试

| 测试 | 断言 |
| --- | --- |
| `scripts/client-smoke.mjs`（扩展） | ①7 个写入口全部存在且触发正确 patch/ops（结构遍历：找到对应控件并调用其 `onChange`）②关键文本保留（既有 5 条断言不变）③新 key 齐备（`pageSubtitle`/`levelCompare` 等在 zh/en 两字典均存在）④无 `document` 环境下渲染不抛错 |
| `test/client-by-level-aggregation.test.mjs`（新） | ①同一模型两个等级产生 `byLevel` 两桶 ②`efforts` 与 `byLevel` calls 之和一致 ③旧快照 hydrate 后 `byLevel={}` 不崩 ④`(默认)` 桶存在 |
| `test/probe-blocked-reasons.test.mjs`（新） | ①blocked 档位的 `code/message` 进入 `blockedReasons` ②rejected 不进入 ③旧 lastProbe（无字段）回显不崩 |
| `test/client-i18n-parity.test.mjs`（新） | zh 与 en 的 key 集合完全相等（缺一即红）；`LEVEL_LABELS` 两语言均覆盖 7 档 |

### 7.2 既有测试不得回归

`node --test` 全量（当前 113/113）、`node scripts/client-smoke.mjs`、`node --check lib/*.js`、`npm run host:doctor` 双树 11/11。

## 8. 验收标准（可机器判定 + 用户主观）

**机器判定**
1. `node --check lib/index.js lib/client.js` exit 0
2. `node --test` 全绿（113 + 新增）
3. `node scripts/client-smoke.mjs` exit 0 且新断言全过
4. `npm run host:doctor` 双树 11/11 PASS
5. `grep` 断言：`lib/client.js` 中 `document.head.appendChild` 只出现一次；`.rl-` 前缀覆盖全部 className；无 `#` 十六进制颜色字面量（令牌集中）
6. `statsSnapshot()` 输出同时含 `efforts` 与 `byLevel`，且旧字段形状不变

**用户主观（M7.7）**
1. 设置页首屏能一眼回答「我在用什么等级、影响多少模型」
2. 等级选择不需要查文档就知道每档含义
3. 加一个模型默认 ≤3 次交互
4. 探测失败能看懂原因
5. 整体观感「像宿主的原生设置页」

## 9. 实现顺序（供 Developer 分批提交，每批一个 commit）

1. **基础层**：`ensureStyles` + STYLESHEET + 令牌 + 基元组件（Card/Button/Chip/Tile/EmptyState/Toolbar/Switch/SegmentedControl/SearchField/Disclosure）+ i18n 双字典扩展（`LEVEL_LABELS` 双语 + 新 key）。
2. **页面骨架**：PageHeader + Overview + 全局卡（含分段控件 + 影响预览）。
3. **模型级卡**：搜索添加 + 行卡片 + 支持矩阵。
4. **观测卡**：工具栏（暂停/异常/排序/过滤）+ 探测归因 + 最近调用。
5. **服务端**：`byLevel` 聚合 + `blockedReasons` + 测试。
6. **等级对比视图** + CSV 增列。
7. **MAINT-039 测试隔离修复**（独立小项）：`test/contract-guard.test.mjs:65` 改为「本次 mount 未新建迁移标记」的快照对比（或该用例强制隔离临时 home），保持「自禁用路径零落盘」原语义。

> 每批必须自跑 `node --check` + `node --test` + `client-smoke`，任一红即停止并修。

## 10. 增量修订（调研回填，2026-10-20）

调研（`docs/research/pain-points-v0.9.md`）完成后追加的三条硬要求，优先级高于本文前述相应条目：

### 10.1 `persisted` 三态语义必须拆开（回应 P6）

现状把三种完全不同的结局混成一句「不在 llm-pi-ai 配置——仅展示，未写入」：

| 真实情况 | 判定依据 | 应显示文案（zh） |
| --- | --- | --- |
| 该模型由宿主**官方适配器**管理（如 `deepseek-official/*` → `llm-deepseek`），等级由 `llm-deepseek.reasoningEffort` 控制 | provider 属于宿主内置官方 provider（不在 `llm-pi-ai.providers` 且属 deepseek 系） | `由 DeepSeek 官方适配器管理——等级已通过官方通道下发，无需写入模型能力声明` |
| 该模型确实**不在** `llm-pi-ai` 配置里（需要先去模型配置添加） | 在 `llm.models` 目录中但 `llm-pi-ai.providers` 无此 provider/model | `该模型不在 llm-pi-ai 配置中——请先在「模型」设置里添加，再探测即可固化` |
| 固化**写盘失败** | `persist-error` | `固化失败：${error}` + 重试 |

实现建议：服务端 `probePersistedOutcome` 增加一个取值 `skipped:official-adapter`（或在客户端按 provider 白名单派生）。**不得**仅靠文案猜测——必须有可判定的数据依据。

### 10.2 「思考量不可观测」必须说清是网关不回报（回应 P7）

- `off` 档的说明补一句：部分网关即使发送 `disabled` 仍会计费思考（外部证据见调研 §4.2）。
- 统计卡「思考」列在 `rt===0 && rc===0` 时，`title` 属性写「该网关未回报 reasoning tokens」（不是「无思考」）。

### 10.3 撤销必须包含「删除模型默认」的对称操作

删除模型级默认走的是 `mutate unset`；撤销必须能把它**写回**（`update` patch），否则用户删错了无法一键恢复。实现时撤销记录需保留被删的 `{key, level}` 原值。

### 10.4 等级对比必须声明「数据自本版起累积」

**事实**：持久化快照（`$DSH_HOME/storages/reasoning-level-stats.json`）在 v0.8.1 及以前**没有** `byLevel` 字段，hydrate 是显式字段拼装（`lib/index.js:884-892`），因此升级后历史聚合（本机 81,926 次调用）**不会**有 per-level 拆分。

**要求**：
- 等级对比卡在无样本时必须显示：`等级对比数据自 v0.9.0 起累积——历史调用没有按等级拆分记录，跑几轮不同等级的调用后这里会出现对照。`
- **禁止**用 `efforts` 计数反推 per-level 耗时/Token（那是编造数据，违反开发原则 1）。
- 升级后首帧不得因为 `byLevel` 缺失而报错或显示空白表头。

