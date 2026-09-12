# 宿主依赖边界架构演进设计（v0.7.6）

| 项 | 值 |
| --- | --- |
| 任务 | FEAT-001（设计产出；本文同时作为 FEAT-002 的设计输入） |
| 项目 | dsh-reasoning-level v0.7.5 → 目标 0.7.6 |
| 作者 | Architect Agent（治理工作流 stage-architecture） |
| 日期 | 2026-09-12 |
| 状态 | Proposed（待 Design Reviewer 审查 + Coordinator 呈报用户） |
| 事实基线 | ① 本会话实读：lib/index.js（1780 行）、lib/client.js（1109 行）、test/{host-face-contract, client-host-face-compat, settings-namespace-compat}.test.mjs、test/harness.mjs、test/fixtures/*、scripts/client-smoke.mjs、package.json；② 宿主源码实读：`C:/Users/peter/.dsh/profiles/node_modules/@deepseek-ai/dsh-client-modules`（makeRequire L300-310 / materialize L271-293 / async import L311-320 / resolveMeta+clientExportOf L637-667 / arriveGraphRow inject 静默跳过 L265-268）；③ MAINT-029 实证（Coordinator 2026-09-12 逐项核对，v0.7.5 × dsh 0.1.5-rc.2 静态面全兼容，唯 inject 死声明缺陷） |

> 设计纪律声明：本文所有宿主行为描述均有上述实读出处；无法验证的假设在附录 A 显式标记（编号 A-n）。没有出处标注的宿主断言不存在于本文。

---

## 1. 目标与范围

### 1.1 用户四项要求 → 设计目标映射（DEC-017）

| # | 用户要求 | 设计目标 | 落点 |
| --- | --- | --- | --- |
| 1 | 尽可能减少对 DSH 宿主的依赖 | **依赖面收敛与显式化**：全部宿主触点登记为单一契约注册表（lib/host-compat.js），每条触点携带宿主出处（包名+版本+源码行）；已实证的最小依赖集不扩大（服务端 inject 三服务、客户端五命名空间、2 个 npm 导入） | §3.3 |
| 2 | 必须的接口/字段依赖解耦、单独维护 | **单点边界模块**：事件名/命名空间/方法名/元数契约/信封形状等字符串与数据契约从业务代码（index.js 16 处 settingsNamespace 调用点、4 处 ctx.on 字面量、client.js hostApiFace 内散落方法名）收敛到 host-compat.js 单模块；dsh 升级适配只改一处 + 客户端镜像段（≤30 行） | §3.3 |
| 3 | 对依赖代码严格校验和看护 | **双工件源判别测试**（FEAT-002）：devDeps 锁版基线（CI 恒断言，fail-closed）+ `DSH_HOST_TREE` 指向活宿主树（存在即断言、缺席即 skip）——延续 MAINT-025「真实工件判别，杜绝 mock 假绿（MAINT-014 教训）」 | §4.1-4.2 |
| 4 | 依赖边界增加可调测性设计（第一时间发现、低代价适配） | **host-doctor 诊断脚本**：一条命令输出逐触点 PASS/FAIL/DRIFT + 宿主版本清单 + 漂移定位建议；与判别测试共用同一探针模块（测试绿 ⟺ doctor 绿，判据零分叉）；VERIFICATION.md 收编为「dsh 升级后第一步」 | §4.3-4.4 |

### 1.2 范围内 / 范围外

**范围内**：lib/host-compat.js 新模块的 API 定义与消费关系；client.js 内嵌镜像段的形态与一致性锚定机制；判别测试双工件源机制与逐触点断言清单；scripts/host-doctor.mjs 行为规格；package.json 变更面（files[]/scripts/devDeps）。

**范围外（首版不做）**：
- ~~MAINT-029 的 `@deepseek-ai/dsh-client-runtime` 死声明清理~~ **已完成**（commit 910baed，2026-09-12，MAINT-029 审查闭环）——`dsh.client.inject` 现为三名；该触点转为断言清单条目 10 的回归守护，防死声明再引入；
- 乐观并发写（expectedRevision 实际传值——现状恒 undefined 无条件写入，MAINT-025 测试注释已登记为后续独立任务）；
- 任何构建工具链引入（§3.2 方案 B 排除理由）；
- 宿主行为变更的自动适配（本设计是**发现与收敛**机制，不是自愈机制——适配仍由人执行，但改动面被收敛到单点）。

---

## 2. 宿主依赖面清单（实证盘点）

稳定性分级定义：
- **T1 文档化公开 API**：宿主 package 的公开导出面/文档化语义，最稳；
- **T2 服务面**：经 `ctx.get()`/inject 获得的宿主服务对象方法（settings/llm/webServer/slots/locale/remote.*），形状来自宿主源码观察，无正式文档承诺；
- **T3 内部面**：宿主包内部实现细节（函数体逐字节、源码文本锚点、bundle 布局）——已知最脆，三次事故全部落在 T2/T3。

### 2.1 服务端面（lib/index.js）

| # | 触点 | 宿主包（版本基线） | 分级 | 当前守护 | 失败模式 | 事故关联 |
| --- | --- | --- | --- | --- | --- | --- |
| S1 | `import z from '@deepseek-ai/schemastery'`（L40，默认导出+z.object/union/dict/boolean/const/string/array） | schemastery 3.18.1↔3.18.2 lib 逐字节一致（MAINT-029 核对） | T1 | 无显式守护（依赖公开导出面） | **致命**：默认导出缺席 = 模块加载期 SyntaxError = 整机启动失败（同 MAINT-021 机理） | — |
| S2 | `import * as dshSettings from '@deepseek-ai/dsh-settings'`（L41，命名空间导入） | dsh-settings 0.1.2-rc.1（devDep 锁版）/0.1.5-rc.2 实证 | T1/T3 | test/settings-namespace-compat.test.mjs（存根子进程） | 命名空间导入本身跨代安全（MAINT-021 修复）；包整体缺席 = 致命（peers `*` + 平坦回退树契约，v0.6.0 事故背景） | MAINT-021 |
| S3 | `settingsNamespace` 跨版本接缝（L117-125：包内导出优先 + 本地同源回退校验器复刻 parseSettingsNamespace） | dsh-settings 内部函数（0.1.5-rc.2 逐字节核验仍一致） | T3 | 存根测试守护「可加载」；**回退校验器与宿主内部函数的逐字节一致性无自动守护**（0.1.2/0.1.5 两版人工核验） | 回退路径语义漂移 = 命名空间校验行为分叉（静默——错误文案/正则差异不炸机但语义漂移） | MAINT-021 |
| S4 | `export const inject = ['settings', 'llm', 'timer']`（L65，服务名） | dsh-settings/dsh-llm/cordis(timer) | T2 | 无显式守护 | 服务名漂移 = 启动期注入失败（致命或半致命） | — |
| S5 | settings 服务方法 register/get/describe/replace/mutate（L200/359/302/579/367 等；mutate ops 形状 `{op:'set'|'unset',path,value}`） | dsh-settings SettingsProvider | T2 | test/harness.mjs 桩级（不判别真实工件） | 方法缺席/形状变 = 注册或读写失败；register 失败已有降级（L199-205 只禁用本插件） | — |
| S6 | 4 事件名：`settings/updated`（L711）/`agent/request`（L716）/`agent/request-error`（L742）/`llm/stream`（L910） | dsh-settings L566 / dsh-agent-loop L1143/L1088 / dsh-llm L2307（0.1.5-rc.2 实证存续） | T2 | **无** | **静默**：事件名变更不报错，钩子永不触发——插件整体失效且无日志，最危险类 | 三次事故同型（宿主内部面耦合） |
| S7 | `llm.resolveModelInfo(provider, model)`（L317/544/1333）+ `llm.stream(options)`（L1086） | dsh-llm 服务面（0.1.5-rc.2 实证存续） | T2 | validatingStream 桩（harness，模拟校验语义非真实工件） | 静默（supportedEfforts 返回 undefined → 注入跳过）/ 探测失败显式 | — |
| S8 | `agent/request` payload `reasoningEffort` 字段（L719-728 注入点） | dsh-agent-loop L1136-1140/L1497 schema | T2 | 无（字段级） | **静默**：字段改名 = 注入被宿主忽略，统计照常（假象健康） | — |
| S9 | dsh-llm effort 校验结构（resolveCallWithInfo L2111-2127——临时声明机制的存在前提） | dsh-llm 内部 | T3 | 无 | 校验结构变更 = 临时声明探测机制失效（表现为探测全 blocked，半显式） | MAINT-014/017（校验层曾使 discovery 机制整体失效） |
| S10 | `ctx.get('webServer')` + `webServer.register({kind:'exact',path,handler})`（L1044/1048/1642/1691/1728） | dsh-host-webserver L176-178 | T2 | 无（注册失败已有降级 L1065-1069） | 静默降级（统计/探测端点消失，设置页仍可用——用户感知为功能消失） | — |
| S11 | cordis Context 面：ctx.on/effect/timeout/logger/get（散布全文） | cordis 4.0.1↔4.0.2 lib 逐字节一致（MAINT-029） | T1（框架核心） | 无 | 致命（框架级，等价于插件平台变更——接受为平台基线） | — |

### 2.2 客户端面（lib/client.js + package.json）

| # | 触点 | 宿主包（版本基线） | 分级 | 当前守护 | 失败模式 | 事故关联 |
| --- | --- | --- | --- | --- | --- | --- |
| C1 | bundle 形态契约：`window.__ModuleLoader__.load({id, factory:(require)=>…})` 工厂 CJS、**唯一 require='react'**（L20-25；宿主 makeRequire 仅解析 seed/已物化/已注册包工厂，无文件系统解析——dsh-client-modules L300-310 实读） | dsh-client-modules | T3 | 隐式（client-smoke/判别测试经同一契约加载，形态破裂即测试红） | require 未知名 = materialize 期 throw = 页面死 | — |
| C2 | `const inject = ['slots','locale','remote','remote.settings','remote.session']`（L1080） | dsh-client-ui-settings 先例 + dsh-api-remotes 命名空间 | T2 | test/client-host-face-compat.test.mjs 用例 1（deepEqual 断言） | 命名空间缺席 = runner 激活门控不满足（页面不加载，静默） | MAINT-022 |
| C3 | hostApiFace 适配层（L1021-1078）：`ctx.get('remote.'+name)` 惰性解析 + `envelopeOf` 旧信封 `{result:{ok,value|error}}` 收敛 + 命名空间缺失 fail-loud | dsh-api-remotes typed remote | T2/T3 | client-host-face-compat（fail-loud 用例）+ host-face-contract（信封直面形状） | 直面形状变更 = 读写链断裂（半显式——P8 结构化错误进页面） | MAINT-022 |
| C4 | remote.settings describe(0)/update(3)/mutate(3) 元数与参数表 + session.modelCatalog(0)（含第三参 expectedRevision 显式占位语义） | dsh-api-remotes 描述符（0.1.2-rc.1 与 0.1.5-rc.2 方法集实证一致） | T2 | **test/host-face-contract.test.mjs（真实工件判别，Half A/B 双半）** | 2 参转发 = 网关元数守卫 RPC 前 throw = 「保存失败」 | MAINT-025（本触点事故本体） |
| C5 | `ctx.get('locale').getSnapshot().active`（L1090-1097）+ `ctx.slots.inject/register`（L1099-1102，settings.section list slot + order/label 契约） | dsh-client-locale / dsh-client-ui slots | T2 | client-smoke + compat 测试（桩级） | 静默降级（locale 回退 zh；slots 形状变 = 注册失败） | MAINT-023（F8 locale 重注册遗留） |
| C6 | package.json `dsh.client.inject` **三名**（dsh-client-ui-settings / dsh-client-locale / dsh-api-remotes，与 native dsh-client-ui-settings-models 参照一致——死声明 `@deepseek-ai/dsh-client-runtime` 已于 commit 910baed 清理〔MAINT-029，2026-09-12〕；arriveGraphRow 对未知名静默跳过 L265-268） | dsh-client-modules boot graph | T3 | 条目 10（回归守护——断言声明名单 ⊆ 宿主可用包集，防死声明再引入） | 宿主未来收紧严格校验 = 激活失败（致命） | MAINT-029 |
| C7 | stats 端点直连 `fetch('/reasoning-level-stats…')` + `window.setInterval/clearInterval`（StatsPanel） | dsh-host-webserver 挂载面（自注册路由，非宿主 API） | 自有面 | client-smoke fetch 桩 | 自有路由，不依赖宿主 API 形状（低风险） | — |

**盘点结论**：11 服务端触点 + 7 客户端触点中，仅 4 项有真实工件级守护（C4 强、C2/C3 桩级强、S2/S3 存根级），S6/S8（事件名/字段名——三次事故同根的静默失效类）完全裸奔，C6 死声明亦仅靠人工核对发现（现已清理并转条目 10 守护）。这是 FEAT-002 断言清单的优先级依据。

---

## 3. 模块边界设计（FEAT-001）

### 3.1 双平面问题（约束实证）

本插件的两个宿主接触面运行在**物理隔离的模块系统**里：

- **服务端面** lib/index.js：Node ESM。`import * as dshSettings from '@deepseek-ai/dsh-settings'` 经 peers `*` + DSH 维护的 `profiles/node_modules` 平坦回退树解析。本地相对导入 `./host-compat.js` 自由可用。
- **客户端面** lib/client.js：**工厂形态 CJS**。经 `window.__ModuleLoader__.load({factory})` 注册、由宿主 makeRequire 物化（dsh-client-modules L271-293）。makeRequire 的解析域**只有三样**（L300-310 实读）：平台 seed 词（如 `'react'`）→ 已物化模块 → 已注册包工厂；三者皆_miss_即 throw（`"missed the module table"`）。**不存在文件系统解析**——`require('./host-compat.js')` 必死。异步 `import()`（L311-320）依赖 boot graph 行到达，工厂体是同步 CJS，无法 await。此外宿主侧每个插件只定位**一个** client 工件（resolveMeta → clientExportOf 取 `exports["./client"]` 单路径，L654-655），不存在"附带第二个文件"的通道。

> 结论：**"共享模块"在客户端面没有字面意义的解**。任何单源设计都必须回答"客户端如何获得同一份契约"——这就是双平面问题，方案取舍如下。

### 3.2 双平面共享候选方案与取舍

#### 方案 A（选定）：服务端单模块 + 客户端内嵌镜像段 + 判别测试锚定两处一致

- 形态：`lib/host-compat.js`（ESM）持有**全部**宿主契约（服务端消费的常量/接缝 + 客户端相关子集 HOST_REMOTE_CONTRACT）；lib/client.js 内保留一段**显式圈定的镜像段**（≤30 行数据字面量，带同源标记注释），客户端代码（hostApiFace/inject/apply）只消费镜像段，不再散落字面量；新增单源一致性测试加载两平面真实工件，deep-equal 断言镜像段 === host-compat 的 HOST_REMOTE_CONTRACT 客户端子集（任何一侧漂移即 CI 红）。
- 取舍（选它因为）：
  - 零新工具链/零构建步骤——保住 DEC-004「Node ESM + 运行时零依赖」与现有发布流水线（人工单文件工件 + 字节级可审计）；
  - client.js 仍是单文件自包含工件——C1 形态契约零变更，client-smoke/判别测试继续直读真实工件（MAINT-025 建立的"真实工件判别"前提不被构建产物稀释）；
  - 复制的只是**数据**（方法名/元数/命名空间名单），不是逻辑——复制面极小且被测试锁死；
  - 回滚 = git revert 单 commit。
- 代价（接受）：物理上仍是两份拷贝；守护依赖单源测试必须在 CI 内运行（不能只靠 DSH_HOST_TREE——见 BM-4 缓解）。

#### 方案 B（排除）：引入零依赖构建步骤，预打包共享模块进 client 工件

- 形态：devDep esbuild/rollup，`lib/host-compat.shared.js` 构建期内联进生成的 lib/client.js（源文件挪到 src/，工件提交或安装期生成）。
- 排除理由：① 与"单文件手写工件 + 字节级判别"的现有质量体系冲突——判别测试/smoke 将测试构建产物而非审阅源，恰是 MAINT-014「mock 假绿」的构建版温床（源-工件漂移需要再引入 freshness 校验，复杂度滚雪球）；② 安装期构建违背零安装副作用承诺（v0.6.0 事故教训），提交工件则引入双份真相；③ 当前共享面是几十行常量，收益撑不起工具链成本。**重估触发器**：当共享面增长为真实逻辑（如信封适配算法双平面复用）且镜像段 >100 行时重开评估。

#### 方案 C（部分吸收，不独立成案）：运行时能力探测自适应

- 形态：客户端 hostApiFace 在调用前从宿主 remote face 读描述符元数据自适应元数/方法名；服务端同理探测事件名是否存在。
- 排除为独立方案的理由：宿主消费侧 remote face 是否暴露描述符**未经验证**（假设 A-1）；即便可用，"元数据面"本身又是一个 T3 依赖（漂移时自适应层失效且更难排查）；静默自适应会掩盖契约漂移——与用户要求 3「严格校验看护」的方向相反（我们要漂移**显式红**，不是悄悄绕过）。吸收的部分：fail-loud 结构化错误（MAINT-022 P8 已实现）保留为最后防线，不作为主守护。

#### 方案 D（一票否决，列出以封死）：双平面可加载的单一物理文件（UMD/双形态导出）

- 排除理由：物理上不成立——客户端根本到不了"读本地文件"这一步（makeRequire 证据，§3.1）。任何"把 host-compat 写成两边都能加载"的提案都撞同一堵墙。

### 3.3 选定方案：lib/host-compat.js API 定义

模块职责（≤3 句）：**登记本插件对 DSH 宿主的全部契约性依赖（事件名/服务名/命名空间/方法面/元数/信封形状），每条携带宿主出处；提供 settingsNamespace 跨版本接缝；供服务端代码、判别测试与 host-doctor 三方消费。不包含任何业务逻辑。**

#### 导出面（服务端 ESM，零新增依赖）

```js
// ── 事件名契约（S6）── 消费方：lib/index.js 四处 ctx.on
export const HOST_EVENTS = Object.freeze({
  settingsUpdated: 'settings/updated',       // 出处：dsh-settings lib/index.js L566（0.1.2-rc.1/0.1.5-rc.2 实证存续）
  agentRequest: 'agent/request',             // dsh-agent-loop L1143
  agentRequestError: 'agent/request-error',  // dsh-agent-loop L1088
  llmStream: 'llm/stream',                   // dsh-llm L2307
})

// ── 服务名/注入声明（S4）── 消费方：lib/index.js `export const inject = [...HOST_SERVICES.serverInject]`
export const HOST_SERVICES = Object.freeze({
  serverInject: Object.freeze(['settings', 'llm', 'timer']),  // cordis 服务名；timer=boot 重试
  webServer: 'webServer',                                      // 可选服务：ctx.get(HOST_SERVICES.webServer)
})

// ── 设置命名空间字符串（S5 配套）── 消费方：lib/index.js 16 处 settingsNamespace(...) 调用点收敛为
//    settingsNamespace(HOST_NAMESPACES.piAi) 等；字符串不再散落业务代码
export const HOST_NAMESPACES = Object.freeze({
  self: 'llm-reasoning', deepseek: 'llm-deepseek', piAi: 'llm-pi-ai', agentDefaultModel: 'agent-default-model',
})

// ── 服务方法名登记（S5/S7；登记+测试锚定用，不做逐调用点机械解引用——见 3.5 决策 D2）──
export const HOST_SETTINGS_METHODS = Object.freeze({
  register: 'register', get: 'get', describe: 'describe', replace: 'replace', mutate: 'mutate',
  mutateOps: Object.freeze(['set', 'unset']),  // ops 元素形状 {op:'set',path,value}|{op:'unset',path}
})
export const HOST_LLM_METHODS = Object.freeze({ resolveModelInfo: 'resolveModelInfo', stream: 'stream' })

// ── 跨版本接缝（S3；自 lib/index.js L117-125 原样迁入，行为零变更）──
// 签名：(value: string) => string；非法值 throw TypeError（与 0.1.1-rc.2 品牌
// 校验器同源语义：正则、报错文案、返回原值；0.1.5-rc.2 逐字节核验仍一致）
export function settingsNamespace(value) { /* 包内 dshSettings.settingsNamespace 优先（typeof 探测），
  缺席回退本地校验器；迁移后 lib/index.js 不再 import dshSettings —— 全插件唯一 import 点收敛于此 */ }
export const settingsNamespaceOrigin  // 'package-export' | 'local-fallback' —— 诊断面：当前生效路径（doctor/测试输出用）

// ── DSH home 解析（F-3 单源裁决：自 index.js L51-60 迁入并导出）──
//    消费方：lib/index.js（boot 重试路径）+ scripts/host-doctor.mjs + 判别测试——同源单点，
//    消除 doctor 复制解析规则的第三份拷贝风险（REVIEW-FEAT-001-R0 F-3）
export function resolveDshHomeSafe() { /* explicit $DSH_HOME > ~/.dsh；空串视为未设置；~ 展开 */ }

// ── 客户端面契约注册（C2/C3/C4；客户端代码不 import 本模块——镜像段见下）──
//    消费方：单源一致性测试、host-face-contract 判别测试、host-doctor
export const HOST_REMOTE_CONTRACT = Object.freeze({
  faces: Object.freeze({ settings: 'remote.settings', session: 'remote.session' }),  // ctx.get('remote.'+name)
  clientInject: Object.freeze(['slots', 'locale', 'remote', 'remote.settings', 'remote.session']),
  methods: Object.freeze({
    'settings.describe':    { arity: 0, params: [] },
    'settings.update':      { arity: 3, params: ['ns', 'patch', 'expectedRevision'], thirdParamAcceptsUndefined: true },
    'settings.mutate':      { arity: 3, params: ['ns', 'ops', 'expectedRevision'], thirdParamAcceptsUndefined: true, opShapes: ['set', 'unset'] },
    'session.modelCatalog': { arity: 0, params: [] },
  }),
  responseEnvelope: 'direct:{ok,value|error}',   // 宿主 typed remote 直面；适配层收敛为旧信封 {result:{ok,value|error}}
  legacyEnvelope: '{result:{ok,value|error}}',   // 页面消费面（保持不变——MAINT-022「页面零改动」语义）
})

// ── 出处台账（doctor 与断言输出的数据源；人机共读）──
export const HOST_PROVENANCE = Object.freeze([
  // { touchpoint: 'S6 settings/updated', package: '@deepseek-ai/dsh-settings',
  //   verified: ['0.1.2-rc.1', '0.1.5-rc.2'], anchor: 'lib/index.js L566' }, ...
])
```

#### lib/client.js 内嵌镜像段（形态约束）

```js
// ── host-compat 客户端镜像段（SINGLE-SOURCE-MIRROR）────────────────────────
// 与 lib/host-compat.js 的 HOST_REMOTE_CONTRACT 同源；由
// test/host-compat-single-source.test.mjs 加载两平面真实工件 deep-equal 锚定，
// 任何一侧漂移即 CI 红。本段只允许数据字面量，禁止逻辑。dsh 升级时与
// host-compat.js 同一变更单元内同步修改。
const HOST_REMOTE_CONTRACT = { faces: {...}, clientInject: [...], methods: {...}, responseEnvelope: '...', legacyEnvelope: '...' }
```

hostApiFace 与 apply/inject 声明改为消费镜像段（`HOST_REMOTE_CONTRACT.faces.settings` 等）；`exports.inject = [...HOST_REMOTE_CONTRACT.clientInject]`（镜像段本身即 C2 触点的单一事实位）。**注意**：cordis/宿主入口契约要求 inject 从入口导出——镜像段必须留在 client.js 工厂内（不可挪出），这正是"镜像"而非"引用"的原因。

#### 依赖图（无循环证明）

```
@deepseek-ai/dsh-settings（外部 peer）
        ▲
lib/host-compat.js ──(无插件内部依赖；只 import dshSettings 命名空间)
        ▲                                    ▲
lib/index.js（import host-compat）           test/** 与 scripts/host-doctor.mjs
                                            （import host-compat + 读 lib/client.js 真实工件）
lib/client.js ──(零 import；内嵌镜像段数据)──┘ 仅被测试/smoke 经 vm 双面加载器读取
```

host-compat.js **不反向依赖** index.js/client.js/test/scripts——图中唯一方向是向内收敛，无环。（角色硬门槛：模块无循环依赖 = 0，满足。）

### 3.4 关键决策记录（取舍摘要）

| ID | 决策 | 上下文/取舍 | 回滚路径 |
| --- | --- | --- | --- |
| D1 | 双平面采用方案 A（镜像段+锚定测试） | 客户端 makeRequire 无文件系统解析（实证），构建方案成本>收益；详见 §3.2 | revert FEAT-001 commit，恢复 index.js/client.js 原状（无数据迁移） |
| D2 | 服务方法名（HOST_SETTINGS_METHODS/HOST_LLM_METHODS）登记但不做逐调用点机械解引用 | JS 属性访问 `settings.register(...)` 无法被"导入收敛"，机械解引用（`settings[HOST_SETTINGS_METHODS.register]`）增加噪声却不改变漂移风险；真正的看护在判别测试断言方法存在性 | 无需回滚（登记是叠加的） |
| D3 | schemastery 导入（S1）保留在 index.js 直连，不进 host-compat | z 是深度消费的库（30+ 调用点）而非"接缝"；包一层纯转发是伪解耦。守护改由断言清单覆盖其使用面导出（§4.2 条目 7） | — |
| D4 | `settingsNamespace` 接缝整体迁入 host-compat，index.js 卸掉 dshSettings 导入 | 全插件对 dsh-settings 的唯一 import 点收敛到单模块；存根测试的模块重定向钩子按 specifier 拦截，import 点迁移不影响其工作（fixtures/redirect-no-brand.mjs 机制实证） | 同 D1 |
| D5 | cordis Context 面（S11）不纳入契约表 | 框架核心等价于插件平台本身；为平台 API 做兼容层超出插件职责（过度工程化）。标记为接受的平台基线 | — |
| D6 | **C5（locale/slots）与 S8（reasoningEffort 字段名）显式豁免出契约注册表**（REVIEW-FEAT-001-R0 F-2 裁定：显式豁免优于沉默缺席） | C5 为 fail-soft 单点消费面（locale 回退 zh、slots 失败仅禁用本 section）且已有 client-smoke 桩级守护（§2.2 C5 行）——入册收益低于注册表膨胀成本；S8 沿用 D2 同理（JS 属性访问无法导入收敛，机械解引用噪声>收益），真正看护在断言条目 6（T 级锚串）。两触点在 §2.2 清单在册 + 失败模式已知，未来若升级为事故根因可按 BM-5 准入标准补登记 | 补登记为增量演进（注册表新增导出），无需回滚本豁免 |

### 3.5 实施注意（给 Developer 的约束，非本文档越权实现）

1. package.json `files[]` **必须**追加 `lib/host-compat.js`（否则安装产物缺模块 = 致命——正是本设计要消灭的事故类）；
2. `export const inject = [...HOST_SERVICES.serverInject]`（拷贝而非引用 frozen 数组，防宿主/框架对导出数组做变更）；
3. test/settings-namespace-compat.test.mjs 存根重定向继续有效（按 specifier 拦截），但断言面可加一条：宿主行加载后 `settingsNamespaceOrigin` 报告路径正确（旧宿主形状存根下应走 local-fallback）；
4. index.js 16 处 settingsNamespace 调用点、4 处 ctx.on、webServer 获取点全部改读 host-compat 常量——此为纯机械重构，行为零变更（判别测试+全量回归守护）。

---

## 4. 判别守护设计（FEAT-002）

### 4.1 双工件源机制

```
工件源①（基线，CI 恒断言，fail-closed）：devDeps 精确锁版 @deepseek-ai/*
  现锁：dsh-settings@0.1.2-rc.1、dsh-api-remotes@0.1.2-rc.1、cordis@4.0.1、schemastery@3.18.1
  建议增锁（假设 A-2 待实现期验证可安装性）：dsh-agent-loop、dsh-llm、dsh-host-webserver
  各 @0.1.2-rc.1 —— 使 S6 四事件名/S7/S9/S10 全部落入 CI 基线断言域
工件源②（活树，opt-in）：环境变量 DSH_HOST_TREE 指向宿主树（profiles 目录或其 node_modules，两者皆可）
  存在即对活树执行同一套探针断言；缺席即整套 skip（显式 skip 输出，不静默）
  兼容：现 test/host-face-contract.test.mjs 的 DSH_HOST_PACKAGES（L43-50）语义并入
  DSH_HOST_TREE（旧名保留为别名，一个 commit 内完成迁移+更新注释）
```

判别原则（继承 MAINT-025）：**断言锚定真实工件（vm 加载/驱动），桩仅用于驱动被测物，禁止桩对桩自证**。断言方法分级：
- **B 级（行为判别，最强）**：vm 加载真实 bundle → apply() → 捕获描述符/驱动调用——既有 host-face-contract Half A/B 模式；
- **T 级（文本锚点）**：读真实工件源码文本断言锚串存在——用于无法独立驱动的服务端服务面（S6/S8/S9/S10）。T 级 FAIL 输出降级为 **DRIFT**（见 BM-2），doctor 提示人工复核，CI 中 T 级断言失败视基线源而定：devDeps 基线（锁版不变则不该漂）= FAIL，活树源 = DRIFT。

### 4.2 逐触点断言清单

| 条目 | 触点 | 工件源①基线 | 工件源②活树 | 方法 | 断言内容 |
| --- | --- | --- | --- | --- | --- |
| 1 | S2/S3 dsh-settings 导出面+接缝 | ✅ | ✅ | B+T | 导出面 ⊇ {SettingsConflictError, SettingsProvider, default, redactSecrets}；**双路容忍**：settingsNamespace 重新导出（→须为 function）**或**源码可提取 parseSettingsNamespace 且与 host-compat 本地回退实现归一化后一致（提取失败且无导出 = FAIL） |
| 2 | S6 事件名 ×4 | ✅（需增锁 dsh-agent-loop/dsh-llm；未锁则该 2 条降活树专属） | ✅ | T | 'settings/updated' 存在于 dsh-settings lib；'agent/request'/'agent/request-error' 存在于 dsh-agent-loop lib；'llm/stream' 存在于 dsh-llm lib |
| 3 | S10 webServer.register | ✅（需增锁 dsh-host-webserver） | ✅ | T | `kind` 路由种类含 'exact' + path/handler 字段形状锚串 |
| 4 | C4 api-remotes RPC 集 | ✅（已锁） | ✅ | **B** | vm-load 真实 bundle → 12 contributions → settings 域方法集 ⊇ {describe,update,mutate,replace,openSettingsDocument,openAgentPresetDirectory,canOpenAgentPresetDirectory} + session.modelCatalog 存在 + 逐方法元数表 === HOST_REMOTE_CONTRACT.methods（既有测试泛化：锚版本参数化到工件源） |
| 5 | S9 dsh-llm 校验结构 | ✅（需增锁 dsh-llm） | ✅ | T | resolveCallWithInfo effort 校验段锚串（ReasoningEffortId/efforts 声明查找结构）存在 |
| 6 | S8 agent/request reasoningEffort 字段 | ✅（需增锁 dsh-agent-loop） | ✅ | T | payload schema 含 reasoningEffort 键（锚串） |
| 7 | S1 schemastery 使用面 | ✅（已锁） | ✅ | B | 锁版工件 default export 提供 object/union/dict/boolean/const/string/array（import 后 typeof 探测） |
| 8 | C1 客户端 bundle 形态自检 | 自有工件（无需宿主） | — | T | lib/client.js 源码 require 调用集合 === {'react'}（无本地相对 require）；含 SINGLE-SOURCE-MIRROR 标记段 |
| 9 | C2/C4 镜像单源一致性 | 自有工件 ×2 | — | **B** | vm 加载 client.js 真实工件提取镜像段 === import host-compat.js 的 HOST_REMOTE_CONTRACT（deep-equal） |
| 10 | C6 dsh.client.inject 存在性 | ✅（devDeps 树按最小集断言：声明名单 ⊆ 已锁可解析集 {dsh-client-ui-settings†, dsh-client-locale†, dsh-api-remotes}） | ✅ | T | 逐声明名在目标树 `@deepseek-ai/<name>` 存在（†见假设 A-2：ui-settings/locale 若不可锁为 devDep，则基线断言退化为"声明名单等于 HOST_REMOTE_CONTRACT.clientInject 对应包集"白名单比对） |
| 11 | C3 fail-loud 语义回归 | 自有工件 | — | B | 既有 client-host-face-compat 用例集保持（命名空间剥离 → 结构化错误） |

### 4.3 scripts/host-doctor.mjs 行为规格

- **输入**：`node scripts/host-doctor.mjs [--tree <path>]`；缺省解析顺序 = `--tree` > `DSH_HOST_TREE` > `resolveDshHomeSafe()||~/.dsh` 下的 `profiles/node_modules`（resolveDshHomeSafe 由 lib/host-compat.js 导出单源——自 index.js L51-60 迁入，doctor/index.js/判别测试同源消费，杜绝第三份拷贝；目录不存在 → 报错并列出已扫描路径，exit 2）。
- **行为**：对 §4.2 全部触点执行探针（**与判别测试共用同一探针模块** `test/host-probes.mjs`——测试与 doctor 判据零分叉；探针函数返回结构化 `{touchpoint, status: PASS|FAIL|DRIFT|SKIP, evidence, hint}`，测试侧包 node:test+assert，doctor 侧包控制台报告器）；全程只读，零写入零网络。
- **输出**：
  1. 逐触点表：`PASS / FAIL / DRIFT / SKIP` + 一行证据（找到的文件+行号/描述符元数比对结果）；SKIP 注明原因（如"活树未指定"）；
  2. 宿主版本清单：目标树内全部 `@deepseek-ai/*` 的 name@version；
  3. 每个 FAIL/DRIFT 附**漂移定位建议**：先查本触点 HOST_PROVENANCE.anchor 的宿主源码位置 → 锚串全文搜索目标树对应包 → 给出"若宿主已改名/移位，下一步查宿主 changelog/相邻版本 diff"的操作序列。
- **退出码**：0 = 无 FAIL（DRIFT 允许 exit 0 但醒目输出，等待人工语义复核）；1 = 存在 FAIL；2 = 输入树不可解析。
- **入口**：package.json `"scripts": { "host:doctor": "node scripts/host-doctor.mjs" }`；VERIFICATION.md 增补「dsh 升级后第一步：npm run host:doctor [--tree …]」标准流程段。

### 4.4 守护闭环（四要求如何被机制满足）

```
dsh 发布新版 → 用户/维护者跑 npm run host:doctor --tree <新树>
  → 逐触点 PASS/FAIL/DRIFT + 定位建议（要求 4：第一时间发现，分钟级）
  → 维护者按 FAIL 修改 lib/host-compat.js + client.js 镜像段（同一变更单元）+ devDeps 锁版 bump
  → 判别测试红→绿（要求 3：真实工件判别，杜绝假绿）
  → lib/index.js / lib/client.js 业务代码零改动或极小改动（要求 1/2：适配面收敛到单点+镜像段）
```

---

## 5. 替代方案评估（整体架构层，≥2 含"为什么不选"）

| 方案 | 概述 | 为什么不选 |
| --- | --- | --- |
| Alt-1 现状维持 + 仅扩测试（不建边界模块） | 保持触点散落，把 §4.2 断言清单直接对着散落实现写 | 测试能发现漂移但不收敛改动面——每次升级仍需在 index.js/client.js 多点手术，且断言与实现之间没有共享契约对象，断言本身会复制字面量（第三份拷贝，无锚定）；用户要求 2（解耦单独维护）未被满足。**FEAT-002 依赖 FEAT-001 的注册表作为断言数据源，顺序不可倒置** |
| Alt-2 全运行时适配层（启动期能力探测 + 动态派发） | 插件启动时探测宿主能力（事件名/方法集），按探测结果动态选择调用路径 | ① 探测面本身成为新的 T3 依赖（假设 A-1 未验证）；② 静默自适应掩盖漂移，与"严格看护"方向相反；③ 复杂度大增而三次事故的根因（宿主内部面耦合）并未被运行时探测消除——MAINT-021 的加载期 SyntaxError 发生在任何探测代码运行之前；④ 事故史证明有效的药方是"编译期/测试期契约锚定"（MAINT-025 判别测试），不是运行时柔性 |
| Alt-3 构建期共享（= §3.2 方案 B） | 见 §3.2 | 见 §3.2 排除理由；保留重估触发器 |

---

## 6. 非功能需求覆盖

| 需求 | 设计措施 | 验证方式 |
| --- | --- | --- |
| 零运行时依赖哲学（DEC-004） | host-compat.js 零新增依赖（唯一外部 import 是既有 dsh-settings 命名空间导入迁移）；无构建工具；peers `*` 不变；files[] 仅 +1 文件 | package.json diff 审查；npm ci 正反实证（既有验收命令） |
| 性能无回归 | 契约消费是模块初始化期一次 Object.freeze 常量绑定 + 属性访问，与现字面量等价（数量级：≤20 次属性读取/启动）；settingsNamespace 接缝行为零变更（运行时探测本已存在） | 全量回归 node --test；无新异步路径 |
| 可维护性 | 触点出处集中在 HOST_PROVENANCE（人机共读台账）；"改一处+镜像段+跑 doctor"的升级 SOP 写入 VERIFICATION.md；镜像段禁止逻辑的形态约束 | Design/Code Review；doctor 输出可读性 |
| 升级成本量化 | 现状（0.7.5 证据）：dsh 升级适配 = 30+ 服务端触点 + 10+ 客户端触点逐点人工排查宿主源码，三次升级事故（MAINT-021/022/025）均为**用户报障驱动**（升级→故障→报障→RCA→修复→发版，每轮 ≥1 个版本周期 + 用户停机）；目标态：适配改动面 = host-compat.js（单文件）+ client.js 镜像段（≤30 行数据）+ devDeps 锁版行 + EXPECTED 锚版本常量；发现路径从"用户报障"提前到"doctor 一跑（分钟级）+ CI 判别测试当日红" | REL-007 发布时对照复盘：以 0.1.5-rc.2 为首例执行 doctor 全流程并记录耗时/改动行数作为基线证据 |
| 安全性（开发原则 7） | 设计纯叠加：不改任何运行时行为（D4 迁移为零行为变更的机械重构）；doctor 全程只读；无用户数据迁移 | 判别测试+全量回归；doctor 代码审查 |

---

## 7. 蓝军挑战（BM-1 ~ BM-5，每条独立 ID + 缓解）

| ID | 挑战（"如果…会怎样"） | 缓解措施 | 残余风险 |
| --- | --- | --- | --- |
| BM-1 | **宿主改打包方式使客户端面更封闭**：如果 dsh-client-modules 收紧 makeRequire（如撤销 react seed 词）、改变 `window.__ModuleLoader__.load` 注册契约、或开始严格校验 `dsh.client.inject` 名单（当前 arriveGraphRow L265-268 对未知名静默跳过）——C1/C6 触点从静默缺陷转致命，且镜像段机制可能整体失效 | 断言条目 8（require 集合 === {'react'} + 标记段存在）+ 条目 10（inject 名单存在性）+ 条目 9（镜像单源）构成三面网：任一收紧在 devDeps 基线 bump 时即 CI 红，doctor 对活树给出定位；若 load 注册契约本身变更，client-smoke/全部客户端测试经同一契约加载（C1 隐式守护显性化——在断言条目 8 注释中声明该传递依赖）；host-compat HOST_PROVENANCE 登记 makeRequire/loader 出处行号，漂移即 DRIFT 提示 | load 注册契约本身变更时守护依赖 client-smoke/客户端测试经同一契约加载的传递链——若该传递链同时失效（如 smoke 改桩），存在漏检窗口 |
| BM-2 | **契约测试对"漂移但兼容"的误报边界**：如果宿主重构内部函数（parseSettingsNamespace 改名/移位）、lib 改为压缩产物、或方法重载导致源码文本锚点（T 级断言）全部断裂——但公开行为未变——测试/doctor 将制造大量假 FAIL，维护者养成"忽略红灯"习惯，判别体系信誉破产 | 三层防误报：① 断言方法分级（B 级行为判别优先，T 级仅用于无法驱动的面）；② T 级失败在活树源输出为 **DRIFT**（exit 0 + 醒目人工复核提示），只有 devDeps 锁版基线的 T 级失败才是 FAIL（锁版不变则源不该变——FAIL 有明确语义：要么宿主 artifact 异常要么锁版被动过）；③ 条目 1 的双路容忍设计（settingsNamespace 导出路 **或** 逐字节一致路，任一成立即 PASS）；DRIFT 处置 SOP 写入 VERIFICATION.md（复核→更新锚点/锚串→一个 commit） | DRIFT 人工复核若长期搁置，T 级锚点腐烂仍可能在下次 FAIL 时一次性爆发——复核纪律依赖维护者执行 SOP |
| BM-3 | **doctor 对宿主树布局变化的鲁棒性**：如果 DSH 改变 profiles 布局（node_modules 深移/符号链接/pnpm 式结构/DSH_HOME 语义变化），doctor 扫不到包——把"布局漂移"误报成"契约 FAIL"（错误归因），或更糟：静默 SKIP 全部断言假装健康 | 探针区分**包不可解析**（该触点 SKIP-UNRESOLVED + 顶部醒目汇总"以下包在目标树未找到——先确认布局，不做契约判断"）与**包可解析但断言失败**（真正的 FAIL/DRIFT）；版本清单在能解析的包上照常输出（部分可用）；默认解析失败列出全部已扫描候选路径（既有 resolveRealPackage 的 fail-closed 报错模式复用）；doctor 输出永远不出现"全绿但零断言执行"——零断言执行本身就是 exit 2 级异常 | 布局变化若同时伴随包重命名，版本清单与锚串双双失配——定位建议可能指向错误方向，需人工判断 |
| BM-4 | **单源锚定测试自身失明**：如果 host-compat-single-source 测试被跳过/偷懒（CI 环境变量缺失、skip 条件写错、或有人直接改测试放过漂移）——两份拷贝静默分叉，方案 A 的唯一支柱失效 | 单源测试**零环境依赖**（两工件都是仓库内文件，CI 恒跑恒断言，不允许 DSH_HOST_TREE 条件 skip）；镜像段带机器可检标记（SINGLE-SOURCE-MIRROR 注释锚）——条目 8 断言标记存在，删除标记段=测试红；Review 检查单增加"镜像段改动必须与 host-compat.js 同 commit"（编程要求 4：一个变更单元） | 恶意/疏忽的"顺手改测试放行"只能靠 Review 检查单与代码审查发现——机器防线止步于标记锚 |
| BM-5 | **host-compat 退化为上帝模块**：如果边界模块逐渐吸入业务逻辑（"顺手把 generatedEffortsFor 也放这儿"）、或成为一切常量的垃圾抽屉——单点边界变成单点瓶颈，违背职责单一 | 模块职责硬约束写入文件头注释（"只登记宿主契约+接缝，零业务逻辑"）；形态约束：导出面全部为 frozen 数据 + settingsNamespace 单一函数；Code Review 检查单固化（新增导出必须能回答"宿主出处 anchor 是什么"——答不出=不属此模块）；HOST_PROVENANCE 是强制配套（无出处的登记不许合入） | 职责约束为文档+审查级约束，无机器强制（无 lint 规则禁业务逻辑入内）——依赖 Review 把关 |

---

## 8. proposed decision-log ADR 条目（文本返回 Coordinator，不写 .governance/）

```
### DEC-0XX：dsh 宿主依赖边界单点化（lib/host-compat.js + 镜像段 + 双工件源判别守护）

- **标题**：dsh-reasoning-level 宿主依赖边界架构演进——host-compat 单点契约模块、客户端镜像段与双工件源判别守护（FEAT-001+FEAT-002，v0.7.6）
- **日期**：2026-09-12
- **背景**：三次 dsh 升级事故同根——插件散落耦合宿主内部面：MAINT-021（dsh-settings 移除 settingsNamespace 公开导出→静态具名 import→加载期 SyntaxError→整机启动失败）、MAINT-022（dsh-client-connection 移除 handle.api→设置页空白）、MAINT-025（写路径第三参缺失→全部设置按钮失效）；三次均为用户报障驱动发现。2026-09-12 dsh 0.1.5-rc.2 升级实证（MAINT-029）：静态面全兼容但 18 个宿主触点中仅 4 个有真实工件级守护，事件名/字段名（静默失效类）与 inject 死声明（漂移类）完全裸奔。用户四项要求（DEC-017）：最小化宿主依赖/必须依赖解耦单独维护/严格校验看护/边界可调测性。
- **决策**：①新增 lib/host-compat.js 单点边界模块——登记全部宿主契约（4 事件名/服务注入/4 命名空间/settings+llm 方法面/remote 元数契约/信封形状），每条携带宿主出处（包+版本+源码行），并承载 settingsNamespace 跨版本接缝（自 index.js 迁入，行为零变更）与 resolveDshHomeSafe 单源导出（F-3 裁决：index.js/doctor/判别测试同源消费）；C5/S8 按 D6 显式豁免出注册表（fail-soft 面桩级守护 + 条目 6 锚串看护）；服务端业务代码只消费边界模块。②客户端面因宿主 makeRequire 无文件系统解析（dsh-client-modules L300-310 实证，本地 require 不可达），采用"内嵌镜像段"（≤30 行数据字面量+机器可检标记）而非共享导入，新增零环境依赖的单源一致性判别测试锚定两平面一致。③判别测试升级双工件源：devDeps 精确锁版基线（CI 恒断言 fail-closed；建议增锁 dsh-agent-loop/dsh-llm/dsh-host-webserver 使事件名/校验结构/webServer 面入基线）+ DSH_HOST_TREE 活树源（存在即断言/缺席即显式 skip）；断言锚定真实工件（vm 加载/驱动，B 级优先，T 级文本锚点失败分级为 DRIFT 防误报）。④新增 scripts/host-doctor.mjs：与判别测试共用探针模块，逐触点 PASS/FAIL/DRIFT/SKIP + 版本清单 + 漂移定位建议，全程只读；npm run host:doctor 入口，VERIFICATION.md 收编为 dsh 升级后第一步。
- **备选方案**：(a) 构建期预打包共享模块（esbuild 内联进 client 工件）——被排除：稀释"单文件手写工件+字节级判别"质量体系、引入源-工件双份真相、安装期构建违背零副作用承诺；保留重估触发器（镜像段>100 行或共享面成逻辑）。(b) 运行时能力探测自适应——被排除：探测面自身成新 T3 依赖、静默自适应掩盖漂移且无法覆盖加载期失败（MAINT-021 机理）、与"严格看护"方向相反。(c) 现状维持仅扩测试——被排除：不收敛改动面，断言复制字面量成第三份无锚拷贝，不满足"解耦单独维护"。(d) 双平面可加载单文件（UMD）——物理不成立（makeRequire 证据一票否决）。
- **排除理由**：见上（逐条对应 §3.2/§5 论证与实证出处）。
- **影响范围**：lib/index.js（imports 收敛+16 处 settingsNamespace 调用点+4 事件常量+webServer 获取改读边界模块，纯机械零行为变更）；lib/client.js（新增镜像段+hostApiFace/inject 消费镜像段）；lib/host-compat.js 新增；test/（既有 3 个兼容测试锚版本参数化+新增 host-compat-single-source.test.mjs+探针模块 test/host-probes.mjs）；scripts/host-doctor.mjs 新增；package.json（files[]+host:doctor+devDeps 增锁）；VERIFICATION.md/README.md。
- **后续动作**：FEAT-001（Developer 实现+Code Reviewer+Design Reviewer 架构面审查）→ FEAT-002（Developer+Code Reviewer+Test Reviewer）→ REL-007（v0.7.6 发布，含以 0.1.5-rc.2 为首例的 doctor 全流程基线取证）。
- **可逆性**：**可逆（架构叠加式）**——无数据/设置迁移、无运行时行为变更、无宿主侧配合要求；回滚 = git revert FEAT-001/002 对应 commits，恢复 index.js/client.js 原状（既有判别测试与全量回归保障回滚后健康）。镜像段方案如未来升级为构建期共享（方案 a 触发器命中），迁移路径为镜像段 → 构建输入，单向演进无返工。
```

---

## 9. 硬门槛自检

| 门槛 | 要求 | 自检结果 |
| --- | --- | --- |
| 候选方案数 | ≥2（含双平面共享专项） | ✅ 双平面专项 4 案（A 选定/B/C/D 排除，§3.2）+ 整体架构 3 案（§5） |
| ADR 关键字段完整 | =100%（标题/日期/背景/决策/备选/排除理由/影响范围/后续动作+可逆性） | ✅ §8 逐字段核对齐全 |
| 蓝军挑战 | ≥3 条，独立 ID+缓解 | ✅ 5 条（BM-1~BM-5），覆盖任务指定三方向（宿主打包收紧/误报边界/doctor 布局鲁棒性）+2 条延伸 |
| 模块无循环依赖 | =0 | ✅ §3.3 依赖图：host-compat 零插件内部依赖，单向收敛无环 |
| 结论五要素 | 上下文/候选/取舍/风险/回滚 | ✅ 每个决策（D1~D5）+ 方案表均含；回滚路径显式 |
| 假设显式标记 | 无法验证的假设不写成事实 | ✅ 附录 A |

---

## 附录 A：无法验证的假设清单（显式标记，禁止当作事实引用）

| ID | 假设 | 状态 | 影响与验证计划 |
| --- | --- | --- | --- |
| A-1 | 宿主消费侧 remote face 可能暴露描述符元数据（方案 C 的前提） | **未验证** | 方案 C 已排除为独立方案，本设计不依赖此假设；若 FEAT-002 实现期顺带实证，仅作 doctor 附加诊断输出 |
| A-2 | dsh-agent-loop/dsh-llm/dsh-host-webserver/dsh-client-ui-settings/dsh-client-locale 可作为 devDeps 精确锁版安装（同 registry 同版本族） | **未验证**（dsh-api-remotes/dsh-settings 已证可锁） | FEAT-002 实现期首步验证；不可锁则条目 2/3/5/6 降级为活树专属断言（基线覆盖面收窄，机制不变），条目 10 基线退化为白名单比对（§4.2 已注明降级路径） |
| A-3 | 宿主树布局保持 `<root>/node_modules/@deepseek-ai/*`（profiles 平坦树，2026-09-12 实证） | 未 来 有 效 性 未 验 证 | doctor 已按 BM-3 设计 SKIP-UNRESOLVED 分级，布局变更不产生误归因 |
| A-4 | 未来宿主 lib 产物保持可提取源码文本（非压缩/非打包合并）——T 级断言与条目 1 逐字节路径的前提 | 未 来 有 效 性 未 验 证 | 条目 1 双路容忍（导出路或字节路任一成立）；T 级断言失败分级 DRIFT（BM-2），不阻断发布流 |

（完）
