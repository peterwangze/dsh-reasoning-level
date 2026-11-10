# 统一模型管理工作台设计（v0.10 演进）

> 任务：FEAT-007（数据与运行时）+ UX-004（设置页重设计）+ GOV-007（bootstrap 0.99.0）
> 决策：DEC-026（用户 2026-11-10 选定：模型中心工作台 / top_p·top_k 保存并预留扩展）
> 事实基线：宿主 DSH 0.2.2-rc.1（app.asar 解包 + `tmp/pkg-0.2.2-*` 工件）；插件 v0.9.2（HEAD `e099e05`）

## 1. 目标与非目标

### 1.1 目标（用户 2026-11-10 原话拆解）

1. **插件定位演进**：由「统一推理等级」演进为「统一模型管理配置」——一个设置页统一管理 DSH 所有模型的思考强度、多模态能力、采样参数与通用默认。
2. **配置界面重新设计**：模型中心工作台（顶部概览 + 模型 / 默认与预设 / 观测 / 诊断四视图）。
3. **主功能一：思考强度配置**——保留既有全部语义（全局默认、模型级覆盖、7 档词表、探测固化、所有权台账、原生 agent 选择），仅重排入口与呈现。
4. **主功能二：多模态能力配置**——按模型声明输入模态（text / image），写回宿主适配器配置并可从工作台撤销（恢复写入前值）。
5. **通用配置：采样参数**——temperature、top_p、top_k、max_tokens 的模型级覆盖与全局默认；temperature / max_tokens 本版真实生效；top_p / top_k 按用户裁决「保存并预留扩展」。
6. **预设**：内置「精确 / 均衡 / 创意」等常用参数预设，一键套用为全局默认；模型级覆盖优先。
7. **预留配置扩展接口**：参数注册表 + 模态注册表 + 服务端下发注册表；新增参数/模态只改注册表与一个应用适配器，UI 自动渲染。

### 1.2 非目标

- 不改变包名 `dsh-reasoning-level`、设置命名空间 `llm-reasoning`、settings.section id `reasoning-level`（避免安装/导航/数据破坏）。
- 不实现 top_p/top_k 的宿主级透传（宿主 0.2.2 无入口；见 §2.3）。
- 不管理 provider/API Key/baseURL/模型目录增删（宿主设置页职责）。
- 不改变既有探测（/probe、/probe/apply）、统计（/reasoning-level-stats）、所有权台账、原生 agent 选择的语义。

## 2. 事实基线（可复查）

### 2.1 宿主模型能力面

| 事实 | 证据 |
| --- | --- |
| pi-ai 模型可声明 `input: ["text","image"]`、`reasoningEfforts`、`compat`、context/maxTokens | `tmp/pkg-0.2.2-dsh-llm-pi-ai/package/lib/index.js:1036-1047`（modelFields）、`:282-285`（MODALITIES） |
| pi-ai `modelOverrides` 仅在路由无 `models` 列表时可用 | 同上 `:662-673`（beside a models list → invalid） |
| pi-ai 请求只透传 `temperature` / `maxTokens`；`stop` 显式拒绝 | 同上 `:1984`（stop UNSUPPORTED_OPTION）、`:2025-2031`（streamSimple options） |
| DeepSeek 官方适配器模型目录含 `inputModalities`（text/image） | `tmp/pkg-0.2.2-dsh-llm-deepseek/package/lib/index.js:304-318`、`:368-395` |
| DeepSeek 请求透传 `options.temperature` | 同上 `:1720`、`:1736` |
| 宿主 `GenerateOptions` 有 `temperature`/`maxTokens`/`stop`，**没有 topP/topK** | `tmp/pkg-0.2.2-dsh-llm/package/lib/types/types.d.ts:538-580`；`call-config.d.ts:11-16` |
| 循环请求的 controls（temperature/maxTokens/stop）经 `agent/request` 瀑布返回并可被替换；只守卫 provider/model/reasoningEffort | `tmp/pkg-0.2.2-dsh-agent-loop/package/lib/index.js:986-1016`（seedConfig/waterfall/守卫） |
| `llm.listProviders()` / `llm.listModels(provider)` 可枚举路由与模型（含 inputModalities） | `tmp/pkg-0.2.2-dsh-llm/package/lib/index.js:1908-1909`、`:2086-2095` |
| `llm.resolveModelInfo` 返回 inputModalities / reasoning.efforts / context / defaultMaxTokens | 同上 `:2116-2185` |

### 2.2 插件现状（v0.9.2）

- `lib/index.js`：`Config` schema（`enabled/level/models/syncDefaultAgent/purposes/statsPublic/probeBlacklist/probeEfforts/applied/lastProbe`）；`applyPiAi` 写 `llm-pi-ai.providers[*].models[].reasoningEfforts` 与路由 `reasoning`；`applyDeepseekRoute` 写 `llm-deepseek*.reasoningEffort`；`agent/request` 与 `llm/stream` 注入 effort；stats 端点 `/reasoning-level-stats`；probe 端点 `/probe`、`/probe/apply`。
- `lib/client.js`：单文件 2,594 行，`settings.section` 单页；`hostApiFace` 适配 remote.settings / remote.session.modelCatalog；`STYLESHEET` 为 `.rl-*` 设计系统。
- 测试：双树 `node --test`（主树 0.2.1-rc.2 + `tmp/compat-022` 0.2.2-rc.1 镜像）、`client-smoke`、`host:doctor`。

### 2.3 top_p / top_k 的诚实边界

宿主 0.2.2 的 `GenerateOptions` 与 `LlmCallControls` 均无 topP/topK；pi-ai 与 deepseek 适配器只读 `temperature`/`maxTokens`。**结论：本轮无法让 top_p/top_k 到达网关。** 采用 DEC-026 方案：

- 配置可保存、可展示、可随工作台迁移；
- 参数注册表标记 `hostSupport: 'reserved'` + 原因（zh/en），UI 显示「预留」徽章与说明；
- 应用层只把 `active` 参数合并进 call-config；`reserved` 参数原样保留在配置中；
- 宿主未来提供入口时，只需把注册表条目的 `hostSupport` 改为 `active` 并补一个 apply 适配器。

## 3. 数据模型（schema 增量，全部可选，旧数据零迁移）

```js
// 新增字段（不改变既有字段形状）
defaults: z.object({
  preset: z.union(['precise', 'balanced', 'creative', 'custom']).optional(),
  params: parameterBagSchema.default({}),   // temperature/topP/topK/maxTokens
}).volatile(),

modelParams: z.dict(parameterBagSchema, z.string()).default({}).volatile(),
// key = "provider/model"；值只含用户显式设置的参数；缺省 = 继承 defaults.params

modelInput: z.dict(z.array(z.union(['text', 'image'])), z.string()).default({}).volatile(),
// key = "provider/model"；值 = 用户声明的输入模态；缺省 = 沿用宿主目录/适配器

appliedInputs: z.dict(z.object({
  written: z.array(z.string()),
  previous: z.union([z.array(z.string()), z.const(null)]),
}), z.string()).default({}).volatile(),
// 能力写入台账：written = 本插件写入值；previous = 写入前值（null = 原本缺省）；
// 撤销只在 current deepEqual written 时恢复 previous，用户手改不覆盖
```

`parameterBagSchema`（strict-ish）：

| 参数 | 类型 | 范围 | 空值语义 |
| --- | --- | --- | --- |
| `temperature` | number | 0 ≤ x ≤ 2 | 缺省 = 继承 |
| `topP` | number | 0 ≤ x ≤ 1 | 缺省 = 继承（reserved） |
| `topK` | integer | 0 ≤ x ≤ 1,000,000 | 缺省 = 继承（reserved） |
| `maxTokens` | integer | 1 ≤ x ≤ 2,000,000 | 缺省 = 继承 |

预设值（内置、代码常量，不写死进用户配置直到套用）：

| 预设 | temperature | topP | topK | 适用 |
| --- | --- | --- | --- | --- |
| 精确 precise | 0.2 | 0.9 | 20 | 抽取/改错/JSON |
| 均衡 balanced（默认不套用） | 0.7 | 0.95 | 40 | 日常编码/问答 |
| 创意 creative | 1.0 | 1.0 | 0 | 写作/头脑风暴 |

## 4. 应用语义

### 4.1 参数优先级

`模型级 modelParams[key]` > `全局 defaults.params` > 宿主/调用方已给值（不动）。

- 只填充「宿主调用配置中为 undefined」的字段；调用方显式值优先（不覆盖）。
- 探测请求（`options.probe === true`）完全跳过。
- 辅助调用（compaction/session-title）同样套用默认；若用户需要差异化，后续用 purposes 扩展（本轮不做）。

### 4.2 注入点

1. **agent/request 瀑布**（循环请求，0.2.2 原生选择在场时也不得改 reasoningEffort，但 temperature/maxTokens 可改）：
   `return { ...config, ...pickActive(mergeParams(...)) }`，只填 undefined。
2. **llm/stream 瀑布**（未冻结手建调用）：`options.temperature` / `options.maxTokens` 为 undefined 时原地写入；options 冻结或 probe 时跳过。
3. **不改写宿主 settings 的 temperature/maxTokens**（宿主没有逐模型采样配置；本插件是默认注入者）。

### 4.3 多模态能力写回

按路由类型选择写点（读 raw section → clone → 修改 → `settings.replace` 整节）：

- **pi-ai 路由，raw `models` 数组非空**：定位 `models[i].id === model`，`entry.input = ['text']` 或 `['text','image']`（保留其余字段）。
- **pi-ai 路由，raw `models` 缺省/空**：`modelOverrides[model] = { ...(existing ?? {}), input: [...] }`。
- **DeepSeek 路由，raw `models` 数组含该模型**：`models[i].inputModalities = [...]`。
- **DeepSeek 路由，raw `models` 缺省**：不写（内置目录未物化；UI 显示只读原因「适配器内置目录声明，未在宿主设置中展开」）。
- 写入成功后登记 `appliedInputs[key] = { written, previous }`；值未变化则不写。
- **撤销**（关闭插件开关 / 清除某模型输入覆盖）：若当前宿主值与 `written` 深等，恢复 `previous`（null → 删除 `input` / `modelOverrides` 空条目）；否则保留当前值并清除台账条目（尊重用户手改）。
- 校验：非空、仅允许 `text`/`image`、去重；`text` 恒在。

### 4.4 生效面观测

模型信息端点返回每个模型的：route kind、声明输入、有效输入（配置 > 目录 > 默认）、思考档位、context/maxTokens、当前插件覆盖。工作台据此显示「配置值 / 宿主值 / 生效值」三态。

### 4.5 live apply 的 HMR 事务边界（2026-11-10 实证补强）

事实（隔离 0.2.1 web 实测 + debug 日志）：`settings/document-updated` 在 dsh-hmr 的 `runExclusive` 事务内同步派发；handler 同一 tick 启动的 `applyLevel` 继承 HMR 的 `AsyncLocalStorage` 事务，其 `settings.mutate/replace` 再次进入事务 → `Error: HMR transactions cannot be nested`，宿主节与 `applied` 台账不更新（boot 在事务外，故正常）。

实现约束：

1. handler 只做 `invalidateDescribeCache` / `invalidateModelsCache`，相关 ns 经 `scheduleApply` **first-wins 合并**调度；调度器用模块求值期捕获（apply 入口二次捕获）的 `AsyncLocalStorage.bind` 把回调放回「无 HMR 事务」上下文，下一 macrotask 执行。
2. 自写事件抑制按 ns 记账（`selfWriteNs` 栈）：`dsh-settings` 在 write 内同步 emit，只丢弃「当前正在写的 ns」的同步事件；写窗口内其他 ns 的事件照常合并调度，外部 host 变更不被丢弃。合并回调总是重新读取新鲜配置。
3. `mutateSettings` / `replaceSettings` 对明确的 `HMR transactions cannot be nested` 做有限重试：最多 3 次（0/20/20ms 间隔），每次尝试都整体跑在事务外，第 3 次仍失败才抛出；其他错误不吞。覆盖非事件驱动的调用点。
4. 回归：`test/live-apply-event-path.test.mjs` 用 settings 桩的「写后 emit」+ HMR 写守卫驱动真实写 API，断言事务内不同步写、事务外收敛、重试恰一次、apply 次数有界、写窗口内其他 ns 事件不被吞、用户手改最终收敛。

## 5. 参数/模态注册表（扩展接口）

`lib/param-registry.js`（零宿主 import，纯数据 + 纯函数）：

```js
export const PARAM_REGISTRY = Object.freeze([
  { id:'temperature', type:'number', min:0, max:2, step:0.05, decimals:2,
    label:{zh:'温度', en:'Temperature'},
    hint:{zh:'越低越稳定，越高越发散', en:'Lower = steadier, higher = more varied'},
    hostSupport:'active', apply:'call-config', presets:{ precise:0.2, balanced:0.7, creative:1.0 } },
  { id:'topP', ... hostSupport:'reserved', apply:'none',
    reason:{zh:'宿主 0.2.2 的 GenerateOptions 无 topP 字段', en:'DSH 0.2.2 GenerateOptions has no topP field'} },
  { id:'topK', ... },
  { id:'maxTokens', ... hostSupport:'active', apply:'call-config' },
])
export function sanitizeParams(raw)            // 丢弃非法/未知键
export function mergeParams(defaults, override) // 逐字段覆盖
export function activeCallParams(params)        // 仅返回 hostSupport active 且 apply=call-config 的 {temperature,maxTokens}
```

`lib/model-capabilities.js`（原计划名 `modality-registry.js`；实现落位为能力写回规划模块）：

```js
export const MODALITIES = Object.freeze([
  { id:'text', label:{zh:'文本',en:'Text'}, required:true },
  { id:'image', label:{zh:'图像',en:'Image'}, required:false },
])
export function normalizeInput(list) // 去重 + 强制 text + 仅注册模态
```

扩展契约（写入 README/VERIFICATION）：

1. 新增参数：注册表加条目 → `apply:'call-config'`（若宿主有对应字段）或 `'reserved'` → 补 `test/param-registry.test.mjs` → 服务端端点自动下发 → UI 自动渲染（无需改 UI 参数列表）。
2. 新增模态：注册表加条目 → `lib/model-capabilities.js` 的 apply/revert 支持映射 → UI 自动出现开关。
3. 服务端 `/reasoning-level-models` 的 `params`/`modalities` 数组是 UI 的唯一事实源；客户端内置 fallback 仅用于端点不可用的降级。

## 6. 服务端端点

`GET /reasoning-level-models`（只读、回环限制同 stats）：

```json
{
  "version": 1,
  "generatedAt": 0,
  "routes": [{ "provider": "zai-coding-cn", "name": "...", "kind": "pi-ai" }],
  "models": [{
    "provider": "...", "model": "...", "name": "...", "kind": "pi-ai",
    "input": { "declared": ["text"], "effective": ["text","image"], "source": "config" },
    "reasoning": { "efforts": ["off","low",...], "defaultEffort": "high" },
    "contextWindow": 200000, "maxTokens": 128000,
    "configured": { "reasoningEffort": "max", "input": ["text","image"], "params": { "temperature": 0.2 } }
  }],
  "params": [ /* PARAM_REGISTRY 投影（含 status/reason） */ ],
  "modalities": [ /* MODALITIES 投影 */ ],
  "contractHealth": { "ok": true, "missing": [] }
}
```

实现要点：`llm.listProviders()` → 逐路由 `llm.listModels()`（失败降级为空）+ `llm.resolveModelInfo()`（失败降级只给目录值）；60s 内存缓存；并发请求合并；不因单模型失败而整体 500。

`/reasoning-level-stats` 响应**只增不改**：新增 `modelConfig` 计数摘要（可选），旧客户端忽略。

## 7. 设置页信息架构（模型中心工作台）

```text
┌ PageHeader：统一模型管理 · 状态行（X 个模型提供商 / Y 个模型 / Z 自定义）
│  actions：全局开关 · 刷新 · 一键探测思考档位（写回能力声明）
├ 概览条：思考档位分布 · 多模态启用数 · 参数覆盖数 · 契约健康
├ Tabs：模型 | 默认与预设 | 观测 | 诊断
│
├ 模型
│   toolbar：搜索 / 模型提供商筛选 / 仅显示自定义 / 分组
│   provider 分组卡片
│     model row：[名称 + id] [配置来源 select：跟随全局/自定义] [只读摘要：全局 · 最大 · 温度 0.7]
│     点击行 → 详情面板（宽屏右侧抽屉 / 窄屏展开行）：
│       身份 · 上下文/最大输出
│       思考强度：跟随全局（最大）/ 自定义 + 档位（不可用档禁用并注明来源）
│       多模态：跟随宿主目录（文本 + 图像）/ 自定义：仅文本 / 自定义：文本 + 图像
│       采样参数：来源 + 生效值；按钮只表达动作（改为跟随全局默认 / 改为跟随宿主默认）
│       操作：恢复此模型默认
│
├ 默认与预设
│   全局思考默认（原全局卡）
│   采样预设 chips（精确/均衡/创意/自定义）+ 默认参数控件
│   辅助调用等级（原 purposes 卡）
│   优先级说明
│
├ 观测
│   统计概览 / 按模型聚合 / 最近调用 / 探测结果（折叠）/ CSV
│
└ 诊断
    契约健康（contractHealth）/ agentSelection 模式 / 扩展注册表 / 探测与能力声明 / 端点状态
```

交互约束：

- 所有写操作经 `settings.update` / `settings.mutate` / `settings.replace`，沿用 `hostApiFace` 单点适配与三参元数契约。
- 保存为即时（变更即写）+ 失败回滚 UI + Toast；不引入“保存”按钮作为唯一路径。
- 无 document 环境（client-smoke vm）必须完整渲染节点树；样式只经 `ensureStyles`。
- 键盘可达：tab 使用 button + aria-selected；模型行操作控件均可聚焦；toggle 有 aria-pressed；抽屉 Esc 关闭。
- 数字参数输入（R2）：全部改为 **commit-on-blur / Enter**。控件维护本地 draft 字符串，输入期间（含 `0.`、整数的中间态）**绝不写设置**；blur 或 Enter 才提交一次。空串仅在已有 override 时提交 `null`（恢复跟随默认），否则不写；非法数字/越界显示内联错误（`aria-invalid` + 文案 + min/max 插值）且不写；合法且与已提交值相同不写。Escape 取消回退到 committed；输入法 composition 期间不提交。非聚焦时 committed 变化才同步 draft，聚焦期间不被 refresh 覆盖。
- 隐藏 router（R2b，DEC-029）：`-router` 是另一插件的内部产物，界面不显示其 provider/模型/分组/筛选/计数/徽章，详情也不展示路由列表；router-only 也不显示。base 行内部把同 provider/model 的隐藏 router key 并入 `writeKeys`，models / modelInput / modelParams / follow / reset / undo 一次写全部 key；router-only 永不可见也不写。行只暴露 `data-model-write-keys`（内部同步用），不再有路由可见文案或 `data-model-route-keys`。
- 行级统一来源（R2b，DEC-031）：每行只有一个「配置来源」控件——`跟随全局` = 思考强度 + 多模态 + 采样参数全部继承；`自定义` = 任一维度有覆盖。切「跟随全局」一次 mutate 清该行全部 writeKeys 的 models/modelParams/modelInput（可 undo）；切「自定义」0 写，只提示到详情设置。行内不再有思考下拉/图像 toggle/参数编辑，只读摘要显示来源 + 生效值（`全局 · 最大 · 温度 0.7` / `自定义 · 思考 高 · 图像 开 · 温度 0.6`）。
- 详情按维度设置（R2b）：`思考强度：跟随全局（最大）/ 自定义 <选择>`，来源行写「默认档位：最大」；`多模态：跟随宿主目录（文本 + 图像）/ 自定义：仅文本 / 自定义：文本 + 图像`；`采样参数 · 温度：来源与生效值在左侧回显，按钮只表达动作「改为跟随全局默认（0.7）」/「改为跟随宿主默认」`。每项回显 `来源：… · 生效值：…`；「恢复此模型默认」保留。
- 术语（R2b，DEC-032）：可见文案统一「模型提供商」（en: model provider），不再出现「provider / 服务商 / 路由」；筛选为「全部模型提供商 / 模型提供商筛选」；概览摘要写 `15 个模型 · 7 个模型提供商`。
- 文案（R2b，DEC-030/032）：控件名带维度；跟随必须写来源 + 当前生效值；徽章不出现裸「已覆盖/继承」，改为「思考 高」「图像 开」「温度 0.6」等维度摘要；参数行固定 `生效值 0.7（来源：模型覆盖/全局默认/宿主）`；默认视图标题为「全局默认思考强度」「全局默认采样参数（模型未覆盖时生效）」；筛选为「全部模型提供商 / 模型提供商筛选」，页面不再出现「路由」一词（诊断视图的宿主技术细节除外）。
- 计数口径（R2b）：PageHeader / Overview / 列表 toolbar / 「已应用」文案均为**可见 base 模型数**（真实 15）；header 的路由位改为**可见 base 模型提供商数**（真实 7），不再显示 14；provider head 只显示「N 个模型」；filter 7 项；Overview 摘要写 `15 个模型 · 7 个模型提供商`。
- 探测作用域（R3，DEC-033）：按钮主文案「一键探测思考档位（写回模型能力声明）」；只对每个模型发 1-token 请求实测思考档位，结束时只写回 `reasoningEfforts` 能力声明；**不写** temperature/topP/topK/maxTokens、多模态 input、全局默认与预设。完成提示与 `probeNote` 明示「仅思考档位」「采样参数、多模态与全局默认不受影响」；结果状态用「能力声明已固化 / 能力声明待固化」。
- i18n：新增文案 zh/en 成对，`test/client-i18n-parity.test.mjs` 覆盖。
- 写路径红线（RISK-005 同型）：既有 7 个写入口（enabled/level/syncDefaultAgent/models 增删改/purposes×2）全部保留并继续可写；新增入口（模型级思考、多模态、参数、预设）逐项有 client-smoke 结构断言。

## 8. 实现拆分与提交

| 任务 | 范围 | 提交 |
| --- | --- | --- |
| FEAT-007 | `lib/param-registry.js` + `lib/model-capabilities.js` + `lib/index.js`（schema、写回、注入、端点）+ 测试 | 1 commit |
| UX-004 | `lib/client.js` 工作台重构 + `scripts/client-smoke.mjs` + `scripts/ui-preview.mjs` + 测试 | 1 commit |
| UX-004 R2 | `lib/client.js` 数字参数 commit-on-blur/Enter（只改客户端，不动 `lib/index.js`）+ smoke/preview/i18n/设计文档 | 1 commit（随 UX-004 收口） |
| UX-004 R2b | 隐藏 router + base 行内部同步 + 行级「跟随全局/自定义」+ 详情维度设置 + 统一词汇/筛选/计数（只改客户端） | 1 commit（随 UX-004 收口） |
| GOV-007 | bootstrap 0.99.0 + plan-tracker 版本 + snapshot + 健康记录修复 | 1 commit |
| REL-014 | v0.10.0 版本收口（待用户授权） | 发布链 |

## 9. 测试与验收

- **FEAT-007**：
  - `test/param-registry.test.mjs`：注册表形状、sanitize（越界/未知/类型）、merge 优先级、active 过滤；扩展契约（新增条目自动出现在投影）。
  - `test/model-capabilities.test.mjs`：pi-ai models 数组 / modelOverrides / deepseek models 三种写点；输入校验；写-撤-写幂等；用户手改不覆盖；缺 catalog 跳过。
  - `test/model-params-apply.test.mjs`：agent/request 只填 undefined/显式优先/probe 跳过；llm/stream 冻结/probe 跳过；模型级 > 默认。
  - `test/model-info-endpoint.test.mjs`：路由/模型聚合、listModels 失败降级、缓存、回环门控。
  - 既有 338 用例零回归（双树）。
- **UX-004**：
  - `client-smoke`：四 tab 渲染；数字参数 draft → blur/Enter 一次写、Escape/非法值不写；R2b 7 提供商 × 15 模型隐藏 router 后 15 行/7 组、0 路由/服务商文案、页面含「模型提供商」、base 行 `writeKeys` 含隐藏 router key、行级来源 0 写/一次清三处、详情三维度写入（含「默认档位」「跟随宿主目录」「改为跟随宿主默认」动作文案）、undo；R3 探测按钮含「思考档位」且不含「固化配置」、`testingNote` 含「不修改采样参数」、完成提示含「仅思考档位 / 不受影响」；旧 7 入口保留；无 document 环境。
  - `client-i18n-parity`：新 key zh/en 等价。
  - `ui-preview`：工作台静态预览（至少模型视图与默认视图）无横向溢出。
- **真机**：DSH 重启 → 设置 → 统一模型管理；逐项操作并截图；用户观感验收。

## 10. 风险

| 风险 | 等级 | 缓解 |
| --- | --- | --- |
| top_p/top_k 配置不生效被误解 | 中 | UI 显式「预留」+ 原因；文档/README 说明；注册表 hostSupport 单一事实源 |
| 大规模 client.js 重构丢写路径（RISK-005 型） | 高 | 写路径红线清单 + client-smoke 实驱 + 审查方变异实验 |
| 能力写回破坏用户 provider 配置 | 高 | 读 raw → clone → 仅改目标字段 → replace；写前台账 previous；撤销仅当 current==written；缺目录跳过 |
| 宿主升级后列表/端点漂移 | 中 | host-compat 单点；端点降级；host:doctor 探针；contractHealth 页面可见 |
| topP/topK 未来生效时语义差异 | 低 | 预留字段独立注册表；apply 扩展点；不写入宿主 section |

## 11. 扩展接口使用示例（未来）

```js
// 新增 seed 参数（当宿主 GenerateOptions 支持后）
{ id:'seed', type:'integer', min:0, max:2147483647,
  label:{zh:'随机种子',en:'Seed'}, hostSupport:'active',
  apply:'call-config', // index.js 的 planCallParams 会把它放进 options.seed
}
```

UI 无需改动：服务端注册表投影 → 参数控件自动出现；`test/param-registry.test.mjs` 的契约用例自动覆盖。
