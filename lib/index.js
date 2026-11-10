/**
 * dsh-reasoning-level 宿主行（composition：`- id: llm-reasoning; name: dsh-reasoning-level`，v0.8.0 起——entry id 即设置命名空间，MAINT-035）。
 *
 * v0.6.0 事故加固（背景：v0.3-v0.5 的 junction 安装 + dependencies 声明曾整机制造
 * 「DSH 拉不起 / 消息 fetch 失败」级故障，见 VERIFICATION.md）：
 * - 依赖契约：`dependencies` 恒为空；全部宿主包为 peerDependencies（`*`），
 *   由 DSH 维护的 `profiles/node_modules` 平坦回退树解析（dsh-app-boot
 *   healProfilesModuleFallback 的 out-of-tree 契约）。插件自身零安装副作用。
 * - 最小接缝：不再 import `@deepseek-ai/dsh-home-paths`（本次事故的直接引信）；
 *   storages 路径按 DSH 同源规则本地解析（$DSH_HOME || ~/.dsh），失败仅降级
 *   统计持久化，绝不影响宿主。
 * - 读设置不再经过 `redactSecrets` 脱敏视图（宿主侧调用，往返无损，即使
 *   目标 schema 未来出现 role('secret') 字段也不会被误清）。
 * - 注册全部容错：webServer.register（重复路由）失败降级为日志，任何单点失败
 *   不允许升级为 profile 挂载失败（boot 级爆炸半径）。
 * - 钩子全隔离：agent/request / llm/stream 的任何异常都被吸收，请求路径
 *   永远按"无本插件"语义继续。
 *
 * MAINT-035（dsh 0.2.0-rc.2 适配，2026-10-16）——设置系统架构反转：
 * - 自有设置声明不再走 settings.register(NS, Config)（该 API 连同 get 彻底
 *   移除）：改为插件入口 `export const Config`（全部字段 .volatile()，
 *   schemastery 3.18.5 L235），由 cordis loader 接线（lib/index.js:1631
 *   `Config: plugin.Config`）；设置 ns = profile entry id（cordis.patch.yml
 *   entry id = llm-reasoning）；配置持久化到 profile 的 cordis.patch.yml
 *   config 覆盖层。`settings.configure({auto:false}, ctx.fiber)` 关闭宿主
 *   表单自动生成（自有设置页先例：dsh-llm-pi-ai 0.2.0 L2532-2534）。
 * - 读路径统一走 describe().find(d => d.ns === ns)：自有读取 .value（有效值
 *   投影 = defaults ∪ user），跨插件原始节读写保持 .user 语义（rawSection）。
 * - 事件 settings/updated → settings/document-updated（payload (ns, revision)，
 *   handler 只消费首参 ns——形状兼容；两个候选名都注册，主名是 0.2.0 契约）。
 * - 旧数据一次性迁移：boot 检测 settings.yaml.imported 滞留段（宿主升级导入
 *   时本插件无 entry 承接）→ 动态 import('yaml') 解析 → 字段白名单过滤 →
 *   settings.replace(NS, 旧段) 导入 + 标记文件防重复（DEC-019）。
 *
 * v0.3.0-v0.5.0 演进：
 * - P0-1 模型级默认全路径注入：`agent/request`（loop 请求）+ `llm/stream` 对未冻结
 *   请求（router 子代理 / session-title / compaction 等手建调用）直接写入
 *   `options.reasoningEffort`——覆盖此前"模型级默认只对 loop 生效"的缺口；
 * - P0-2 自愈降级：监听 `agent/request-error` 与流内 `error/aborted` finish，
 *   识别 `UNSUPPORTED_REASONING_EFFORT`（网关实测拒绝）→ 记入"实测黑名单"，
 *   后续注入自动跳过该档，统计/设置页明示；
 *   （0.7.1 MAINT-013）黑名单仅当前会话内存态：不再持久化 `probeBlacklist`、
 *   boot 不再装载持久化黑名单（`probeBlacklist` 字段兼容保留、零数据破坏）；
 *   探测（/probe 与 /test）是"测量"而非用户调用——探测被拒等级只进该次探测
 *   结果的 rejected 列表，不入黑名单、不跨次生效；每次探测全量重测全部候选
 *   等级，历史误判不会卡死等级。
 * - P1-1 统计增强：每次调用耗时、流内 reasoning-delta 思考字符近似（网关不回报
 *   reasoning_tokens 时仍可观测思考量）；
 * - P1-2 同步默认 agent 模型：`syncDefaultAgent: true` 时全局等级变化同步写
 *   `agent-default-model.reasoningEffort`（校验支持）；
 * - P1-3 统计持久化：聚合数据低频落盘 `$DSH_HOME/storages/reasoning-level-stats.json`，
 *   重启后恢复（recent 缓冲不落盘）。
 *
 * @module dsh-reasoning-level
 */
import z from '@deepseek-ai/schemastery'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { AsyncLocalStorage } from 'node:async_hooks'
import { join } from 'node:path'
// 宿主契约单点边界（FEAT-001）：事件名/服务名/命名空间常量 + settingsNamespace
// 接缝 + resolveDshHomeSafe 全部来自 ./host-compat.js——本文件不再直接 import
// dsh-settings（全插件唯一 import 点已收敛至 host-compat，设计 §3.4 D4）。
import { HOST_AGENT_METHODS, HOST_EVENTS, HOST_LLM_METHODS, HOST_NAMESPACES, HOST_SERVICES, resolveDshHomeSafe, settingsNamespace } from './host-compat.js'
import { createAgentEffortEnforcer } from './agent-selection.js'
// FEAT-007（设计 docs/design/unified-model-workbench-v0.10.md §3/§5）：参数注册表与
// 多模态能力写回规划——两个模块均为零宿主 import 的纯数据/纯函数单点，本文件只
// 负责读 raw section、调用规划、落 settings 与台账（职责单一，防上帝模块）。
import { PARAM_PRESETS, PARAM_REGISTRY, activeCallParams, mergeParams, projectRegistry } from './param-registry.js'
import { MODALITIES, normalizeInput, parseModelKey, planInputRevert, planInputWrite } from './model-capabilities.js'

export const name = 'dsh-reasoning-level'

/**
 * HMR 事务逃逸调度器（FEAT-007 live-apply 修复）。
 *
 * 实证根因（隔离实例 0.2.1-rc.2）：`settings/document-updated` 在宿主 HMR 配置
 * 重载事务内同步派发（dsh-hmr `runExclusive` = `AsyncLocalStorage.run(true, op)`，
 * `dsh-hmr/lib/index.js` —— 事务内再次 `runExclusive` 抛
 * `HMR transactions cannot be nested`）。handler 同一 tick 启动的 apply 会继承
 * 该 AsyncLocalStorage 存储，其 `settings.mutate/replace`（dsh-settings
 * `write` → configEditor.edit → HMR runExclusive）被拒 → live 写入不生效；
 * boot 在事务外执行所以成功。普通 `setTimeout`/`setImmediate`/`queueMicrotask`
 * 都在当前异步上下文创建、同样继承事务（已实测），故用 `AsyncLocalStorage.bind`
 * 在模块求值期（boot、事务外）捕获「无事务」上下文：之后从任意事务上下文调用
 * 都回到该上下文执行，定时器回调因此不携带 HMR 事务。
 */
const scheduleOutsideTransactionFactory = (callback, delayMs) => {
  // 0 延迟用 setImmediate：与既有测试/宿主 settle（setImmediate）同相位，
  // 且同样经 bind 跨出 HMR 事务；需要显式延时的重试/收敛用定时器。
  if (delayMs === undefined || delayMs <= 0) return { immediate: setImmediate(callback) }
  return { timer: setTimeout(callback, delayMs) }
}
const runOutsideTransactionFactory = (callback) => callback()

let scheduleOutsideTransaction = typeof AsyncLocalStorage.bind === 'function'
  ? AsyncLocalStorage.bind(scheduleOutsideTransactionFactory)
  : scheduleOutsideTransactionFactory
/**
 * 在捕获的「无事务」上下文里执行回调（HMR 写重试用——仅延时不改变 async
 * 函数的执行上下文，重试本体必须整体跑在事务外，否则仍会被 runExclusive 拒绝）。
 */
let runOutsideTransaction = typeof AsyncLocalStorage.bind === 'function'
  ? AsyncLocalStorage.bind(runOutsideTransactionFactory)
  : runOutsideTransactionFactory

/**
 * P2-3：apply 入口重新捕获「无事务」上下文——模块求值期捕获可能被插件热重载
 * 的外层 HMR 事务污染。残余风险：模块求值与 apply 都在同一 HMR 事务内时无解
 * （本次加载的写仍可能被拒，重启进程恢复）；此处只降低污染概率，不改变语义。
 */
function rebindOutsideTransactionSchedulers() {
  if (typeof AsyncLocalStorage.bind !== 'function') return
  scheduleOutsideTransaction = AsyncLocalStorage.bind(scheduleOutsideTransactionFactory)
  runOutsideTransaction = AsyncLocalStorage.bind(runOutsideTransactionFactory)
}

/**
 * 静态硬依赖：llm 注册表、timer（boot 重试）。webServer 可选（无则统计端点
 * 不可用），经运行时注入等待就绪（HOST_SERVICES.webServerInject，RCA
 * 2026-10-20——0.2.x 代序服务常晚于本插件 apply 到货）；settings 走运行时
 * 可选注入（HOST_SERVICES.optionalInject，MAINT-036——缺席时数据面自禁用，
 * 插件行仍可加载，绝不阻塞宿主）。
 */
export const inject = [...HOST_SERVICES.serverInject]

/**
 * 通用思考等级词汇表。
 * 来源（调查结论——DEC-012/MAINT-017）：pi-ai 官方 EXTENDED_THINKING_LEVELS
 * （dist/models.js:391——来自 @earendil-works/pi-ai）；GitHub 插件
 * dsh-better-reasoning-effort 知识库全量 49 个 efforts 条目的等级键并集
 * （已逐条核验，无 extra 等级名）；竞品官方文档佐证（DashScope：
 * low/medium/high + xhigh→max 映射，设其他值报错）。
 */
const THINKING_LEVEL_VOCABULARY = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
/** LEVELS 为 THINKING_LEVEL_VOCABULARY 的兼容别名（旧语义引用与 schema 定义）。 */
const LEVELS = THINKING_LEVEL_VOCABULARY
/** 调用入口无显式等级时的聚合键（efforts 与 byLevel 共用同一字面量，兼容旧快照）。 */
const DEFAULT_LEVEL_KEY = '(默认)'
/**
 * FEAT-005（设计 §6.1）：per-level 聚合的受控键集合 = 7 档 + 「(默认)」。
 * stats wire 的 byLevel 只透出这些键（探测候选可含词表外自定义档，脏键不外溢）。
 */
const LEVEL_KEYS_CONTROLLED = [...LEVELS, DEFAULT_LEVEL_KEY]
const DEEPSEEK_LEVELS = ['off', 'low', 'high', 'max']
// 手写模型（无目录能力）自动声明的能力表（openai 系 reasoning_effort 线值）。
// max 原样发送（智谱 bigmodel/z.ai 与聚合网关实测接受）；xhigh 无标准线值故不声明。
// off 线值按协议细化：zai / deepseek 的 thinking 格式下 off 必须显式发送 disabled
// （默认开启思考的模型省略参数≠关闭），否则 null（缺省即不思考）。
function generatedEffortsFor(thinkingFormat) {
  const off = thinkingFormat === 'zai' || thinkingFormat === 'deepseek' ? 'disabled' : null
  return { off, minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', max: 'max' }
}
// 兼容旧版台账识别：5 键/6 键形状的键集合
const GENERATED_KEYS = ['off', 'minimal', 'low', 'medium', 'high', 'max']
const GENERATED_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'max']
/**
 * 计算某个等级的 wire 值（写入 reasoningEfforts 字段的实际线值）。
 * off 按 thinkingFormat 分为 null（openai 系省略即不思考）或 'disabled'
 * （zai/deepseek 必须显式发送 disabled）；xhigh 和 max 保持自身；
 * 其余标准档（minimal/low/medium/high）以等级名为线值。
 *
 * MAINT-019（P2-1）：本函数与 buildFullVocabDeclaration 由 webServer 注册块内
 * 上移为模块级——「标准 wire」是声明识别（isGeneratedEfforts）与收敛写回共用的
 * 单一来源，两处作用域都必须可达。纯函数搬迁，行为零变更。
 */
function wireForLevel(level, thinkingFormat) {
  if (level === 'off') {
    return thinkingFormat === 'zai' || thinkingFormat === 'deepseek' ? 'disabled' : null
  }
  if (level === 'xhigh') return 'xhigh'
  if (level === 'max') return 'max'
  return level // minimal, low, medium, high → 自身
}

/**
 * 构建全量词汇表的 reasoningEfforts 声明（wire 按 thinkingFormat 派生）。
 * 用于临时声明写入、收敛时的替换语义，以及 MAINT-019 起的生成/手写判定
 * （逐键 wire === 本表对应值才算「本插件生成」）。
 */
function buildFullVocabDeclaration(thinkingFormat) {
  const decl = {}
  for (const level of THINKING_LEVEL_VOCABULARY) {
    decl[level] = wireForLevel(level, thinkingFormat)
  }
  return decl
}
/** 统计环形缓冲上限与统计端点路径。 */
const STATS_LIMIT = 300
const STATS_PATH = '/reasoning-level-stats'
/** 模型信息端点路径（FEAT-007，设计 §6：只读、回环门控、60s 缓存、并发合并）。 */
const MODELS_PATH = '/reasoning-level-models'
/** 模型信息端点快照 TTL（宿主 listProviders/listModels/resolveModelInfo 枚举开销大）。 */
const MODELS_CACHE_TTL_MS = 60000
/** 统计聚合持久化文件（$DSH_HOME/storages/）。 */
const STATS_FILE = 'reasoning-level-stats.json'
const STATS_PERSIST_INTERVAL_MS = 5000
/** 单次实测请求超时（网关卡死不拖垮整轮探测）。 */
const PROBE_TIMEOUT_MS = 30000
/** 单模型多等级探测的并发数。 */
const PROBE_CONCURRENCY = 3

// settingsNamespace 接缝（MAINT-021 跨版本兼容）已迁入 ./host-compat.js 单点
// 边界模块（FEAT-001）——包内导出 typeof 探测优先 + 本地同源回退校验器，
// 行为零变更；诊断面 settingsNamespaceOrigin 亦由该模块导出。

/**
 * 统一设置项：llm-reasoning { enabled, level, models, syncDefaultAgent, purposes, statsPublic, probeBlacklist, probeEfforts, defaults, modelParams, modelInput, appliedInputs, applied, lastProbe }。
 *
 * MAINT-035（0.2.0-rc.2）：自有设置声明 = 插件入口导出的 Config schema——
 * 全部字段 .volatile()（schemastery 3.18.5），cordis loader 接线后设置 ns =
 * profile entry id（cordis.patch.yml entry id = llm-reasoning = NS）；配置持久
 * 化到 profile 的 cordis.patch.yml config 覆盖层（宿主先例：dsh-llm-deepseek
 * 顶层 reasoningEffort union volatile、dsh-agent-default-model z.string().volatile()）。
 * schema 形状与字段集相对 0.1.x 零变更（probeBlacklist 兼容字段保留）——仅追加
 * volatile 标记（0.2.0 SettingsForms 只投影 volatile 字段为可编辑表单）。
 */
const NS = settingsNamespace(HOST_NAMESPACES.self)

/**
 * FEAT-007：采样参数包 schema——字段集与类型由 PARAM_REGISTRY 单一事实源派生
 * （注册表加参数 → schema 自动获得字段，扩展契约 §11 无需改此处）。范围校验
 * **有意不放在 schema**：宿主配置解析抛错会阻断整条插件行加载，语义边界改由
 * `sanitizeParams` 在运行时丢弃（非法值回到「继承」，绝不升级为请求失败）；
 * 旧数据/手改脏值因此零迁移。
 */
const PARAMETER_BAG = z.object(Object.fromEntries(
  PARAM_REGISTRY.map((def) => [def.id, def.type === 'integer' ? z.number().step(1) : z.number()]),
))

export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  level: z.union(LEVELS).default('high').volatile(),
  /** 模型级默认推理等级，键为 "provider/model"。 */
  models: z.dict(z.union(LEVELS), z.string()).default({}).volatile(),
  /** 全局等级变化时同步默认 agent 模型的 reasoningEffort。 */
  syncDefaultAgent: z.boolean().default(false).volatile(),
  /** 辅助调用（compaction / session-title）的独立默认等级，键为 purpose。 */
  purposes: z.dict(z.union(LEVELS), z.string()).default({}).volatile(),
  /** 统计端点是否允许非回环 Host（LAN 部署显式开启；默认仅回环）。 */
  statsPublic: z.boolean().default(false).volatile(),
  /**
   * 兼容保留字段（v0.7.1 MAINT-013 起不再写入、不再作为过滤依据）：历史版本
   * 一键探测固化的实测黑名单（provider/model -> 网关实测拒绝的等级）。既有
   * settings.yaml 数据不清理不迁移（零数据破坏）；黑名单现仅当前会话内存态，
   * 由真实调用失败自愈建立，重启即清零。
   */
  probeBlacklist: z.dict(z.array(z.string()), z.string()).default({}).volatile(),
  /**
   * 一键探测固化的实测能力声明：provider/model -> {等级: 线值}（持久化，重启后不再被生成表覆盖/升级）。
   * 线值词汇表来源：generatedEffortsFor —— zai/deepseek thinking 格式的 off 为 'disabled'、
   * openai 系为 null、其余为 'minimal'/'low'/'medium'/'high'/'max'。
   * 值 schema 显式 z.union([z.string(), z.const(null)])：两个成员均为 Schema 对象，
   * 避免 Schema.from(null)→any() 退化；在本版本与严格 union 语义下均等价
   * "string | null"（本版本中顶层 Schema.resolve 的非 required nullable 分支
   * 直接放行 null——union 的 string 分支因此接受 null；严格引擎由 const(null)
   * 分支兜住），且明确拒绝非字符串值。旧写法
   * z.union([...LEVELS, null]) 中的 null 成员经 Schema.from(null) 编译为 any()，
   * 任意值通过——线值完全未校验（且严格引擎下 'disabled' 将校验失败）。
   */
  probeEfforts: z.dict(z.dict(z.union([z.string(), z.const(null)]), z.string()), z.string()).default({}).volatile(),
  /**
   * FEAT-007（设计 §3）：通用采样配置——全局默认与预设。`preset` 只记住用户
   * 最后套用的内置预设（自定义时不写死任何值）；`params` 是真实生效的全局
   * 默认参数包（空 = 继承宿主/调用方），topP/topK 在此保存但不下发宿主。
   */
  defaults: z.object({
    preset: z.union(Object.keys(PARAM_PRESETS)),
    params: PARAMETER_BAG.default({}),
  }).default({}).volatile(),
  /**
   * FEAT-007（设计 §3/§4.1）：模型级采样参数覆盖，key = "provider/model"。
   * 值只含用户显式设置的参数；缺省 = 继承 defaults.params。优先级：
   * 模型级 > 全局默认 > 宿主/调用方已给值（不覆盖 undefined 以外的值）。
   */
  modelParams: z.dict(PARAMETER_BAG, z.string()).default({}).volatile(),
  /**
   * FEAT-007（设计 §3/§4.3）：用户声明的输入模态，key = "provider/model"；
   * 值仅 ['text'] 或 ['text','image']（text 恒在）。缺省 = 沿用宿主目录/适配器。
   */
  modelInput: z.dict(z.array(z.union(MODALITIES.map((entry) => entry.id))), z.string()).default({}).volatile(),
  /**
   * FEAT-007（设计 §3/§4.3）：多模态能力写回台账。written = 本插件写入值；
   * previous = 写入前值（null = 原本缺省）。撤销只在宿主当前值与 written 深等
   * 时恢复 previous——用户手改不覆盖（与 reasoning 所有权台账同一门控语义）。
   */
  appliedInputs: z.dict(z.object({
    written: z.array(z.string()),
    previous: z.union([z.array(z.string()), z.const(null)]),
  }), z.string()).default({}).volatile(),
  /**
   * 所有权台账（028-F1，持久化，DEC-016 D-1a）：本插件对宿主命名空间写入的
   * 「我写的」凭据。routes: 路由 -> 本插件写入的 reasoning 等级（重启后 boot
   * hydrate 认领；用户手改值仍不覆盖——所有权门控语义不变）；deepseek:
   * { level, original } —— level = 本插件写入的 llm-deepseek.reasoningEffort，
   * original = 覆盖前的用户先验值（string；null = 原本缺省），禁用还原时不丢
   * 用户数据。字段整体缺席 = 不持有任何所有权（历史用户配置零迁移）。
   */
  applied: z.object({
    routes: z.dict(z.union(LEVELS), z.string()).default({}),
    deepseek: z.object({
      level: z.string(),
      original: z.union([z.string(), z.const(null)]),
    }),
    /**
     * MAINT-041（2026-10-22）：账号版 DeepSeek 适配器（路由 id `deepseek-account`，
     * 设置命名空间 `llm-deepseek-account`）的同一台账。形状与 `deepseek` 完全一致，
     * 两者各自独立持有所有权——用户可能只启用其中一个账号。
     */
    deepseekAccount: z.object({
      level: z.string(),
      original: z.union([z.string(), z.const(null)]),
    }),
  }).volatile(),
  /**
   * 最近一次一键探测的持久化回显（027-F3）：{ t: 毫秒时间戳, models:
   * { "provider/model": { working, rejected, blocked, persisted, blockedReasons? } } }。
   * /probe 与 /probe/apply 收口时更新；客户端挂载时从 /reasoning-level-stats
   * 读取并重建结果表（「从未探测」的判定以 models 为空对象为准——schema 的
   * dict 隐式默认 {} 使 lastProbe/models 字段实际恒在场，见下方 R0-P3-1 实测说明）。
   * persisted 枚举见 probePersistedOutcome。
   *
   * FEAT-004 ⑦（设计 §6.2）：blockedReasons（仅 blocked 档位的错误码）为 v0.9.0
   * 新增可选项——旧 lastProbe 无该字段时客户端按「未知原因」渲染。
   *
   * R0-P3-1（已实测，schemastery 3.18.5，2026-10-20）：本 schema 里的 z.dict(...) 带
   * **隐式默认 {}**（不是「字段缺席」）——`Config({})` 解析得到 `lastProbe = { models: {} }`
   * （未显式设 default 的 lastProbe 对象同样被解析为对象、其 models 子字段落隐式默认）；
   * 用旧数据（模型条目无 blockedReasons）解析，该条目会得到 `blockedReasons = {}`
   * （字段在场、空对象）。显式 `.default(undefined)` 在本版本可用，但会为「从未探测 /
   * 旧数据」再引入一种空值形状，故不采用——读取侧把 `{}` 与字段缺席视为等价：
   * hydrate/stats 消费均先判 undefined 再判空对象，客户端 lastProbeEmpty 用
   * `Object.keys(lastProbe.models ?? {}).length === 0`，blockedReasons 空对象 →
   * probeReasonText 走「未知原因」降级。→ 功能降级路径不受影响。
   */
  lastProbe: z.object({
    t: z.number(),
    models: z.dict(z.object({
      working: z.array(z.string()),
      rejected: z.array(z.string()),
      blocked: z.array(z.string()),
      persisted: z.string(),
      blockedReasons: z.dict(z.object({
        code: z.string(),
        message: z.string(),
        kind: z.string(),
      }), z.string()),
    }), z.string()),
  }).volatile(),
})

export function apply(ctx) {
  // P2-3：在 apply 入口（boot/插件重载的真实起点）重新捕获无事务上下文，
  // 降低模块求值期被外层 HMR 事务污染的概率；残余风险见函数注释。
  rebindOutsideTransactionSchedulers()
  const llm = ctx.llm

  // MAINT-035/036：settings 服务引用经运行时可选注入回调获取（宿主先例
  // dsh-llm-pi-ai 0.2.0 L2532 ctx.inject(["settings"], child => ...)）。静态
  // inject 自 MAINT-036 起不再含 'settings'——无 dsh-settings 的极简 profile
  // 插件行仍可加载；settings 相关初始化（configure / 事件监听 / 一次性迁移 /
  // boot 应用）全部收敛在回调内。回调未触发（服务缺席）或契约自检失败时
  // describeEntry/configOf 恒 undefined，数据面按「无本插件」语义自禁用，
  // contractHealth 如实上报（stats 端点仍活）。
  let settings

  // ── MAINT-036：宿主契约自检 fail-loud ──────────────────────────────────────
  // 静默失效（事件改名类漂移 = 钩子永不触发、服务面漂移 = 调用恒 throw/恒
  // undefined）是三次升级事故的共同形态。boot 时校验全部消费面方法存在，
  // 缺失即 log error + contractHealth 降级 + 数据面自禁用——把「升级即失效」
  // 降级为「升级即页内可见告警」，宿主进程永不受伤。
  const contractHealth = {
    ok: true,
    missing: [],
    checkedAt: 0,
    // MAINT-042：原生选择面健康（native=0.2.2 select 生效 / legacy=0.2.1
    // agent/request 瀑布 / unknown=尚未观察到 agent）。lastError 只存最近一次
    // select 失败文本，供 stats/诊断面第一时间发现升级断接。
    agentSelection: { mode: 'unknown', lastTarget: null, lastError: null },
  }

  // ---- 本插件写入位置的台账（区分“我写的”与“用户手改的”） ----
  // 028-F1：内存台账 = boot hydrate(llm-reasoning.applied) ∪ 运行期写入——
  // 写入成功后同步落盘持久台账，重启后凭台账认领自己的写入（跨重启持续管理）。
  let myRouteReasoning = new Map() // route -> level
  let myModelEfforts = new Map() // route + '\u0000' + modelId -> generated map
  /**
   * MAINT-041：DeepSeek 系「独立适配器路由」的默认等级同步表。两者形状相同、互不相干：
   *  · `deepseek`        → 路由 `deepseek-official`，设置 ns `llm-deepseek`（API Key 版）
   *  · `deepseekAccount` → 路由 `deepseek-account`，设置 ns `llm-deepseek-account`（账号版）
   * 它们都不在 `llm-pi-ai.providers` 里，等级由各自 config.reasoningEffort 决定；
   * 只同步其中一个 = 另一个的「全局默认等级」完全不生效（用户 2026-10-22 报障）。
   */
  const DEEPSEEK_ROUTES = Object.freeze([
    { key: 'deepseek', provider: 'deepseek-official', ns: HOST_NAMESPACES.deepseek },
    { key: 'deepseekAccount', provider: 'deepseek-account', ns: HOST_NAMESPACES.deepseekAccount },
  ])
  const myDeepseekEffort = { deepseek: undefined, deepseekAccount: undefined } // 本插件写入的等级
  const originalDeepseek = { deepseek: null, deepseekAccount: null }          // 覆盖前原节（会话内）
  let running = false
  let queued = false
  // FEAT-007 live-apply 修复（隔离实例实证：HMR transactions cannot be nested）：
  // 事件 handler 不在当前 tick 直接 apply，先合并调度到下一 macrotask 且经
  // scheduleOutsideTransaction 跨出宿主 HMR 的 AsyncLocalStorage 事务。
  // `selfWriteNs` 是「本插件正在写的 ns 栈」：dsh-settings 在 write 内同步
  // emit settings/document-updated（lib/index.js L435/L461），与栈内 ns 相同的
  // 自写事件由当前 apply 自身负责、不再排一轮；其他 ns（用户手改/异步 HMR
  // 重载/写窗口内的外部事件）照常合并调度，不静默、不延迟。
  const APPLY_SCHEDULE_DELAY_MS = 0
  let pendingApplyHandle = null
  const selfWriteNs = []
  /** provider/model -> 支持等级缓存（apply 时失效，注入前校验用）。 */
  let effortsCache = new Map()
  /**
   * 实测黑名单（仅当前会话内存态，MAINT-013 起不持久化）：真实调用被网关拒绝
   * （agent/request-error / 流内 finish error）→ 后续注入跳过；探测路径不写入
   * （探测是"测量"）；/probe 探测开始时重置该 provider/model 的条目。
   */
  const blacklist = new Map()
  /** 一键探测固化的能力声明台账（route\0model -> map），与 llm-reasoning.probeEfforts 持久化同步。 */
  const verifiedEfforts = new Map()
  /**
   * FEAT-007：多模态能力写回台账（key = "provider/model" → { written, previous }）。
   * boot 从 llm-reasoning.appliedInputs hydrate；写入成功后落盘、撤销成功后清除。
   * 撤销门控 = 宿主当前值与 written 深等（用户手改不覆盖）。
   */
  const inputLedger = new Map()

  // ── 并发写串行化（MAINT-017 R1 —— R0 F2/F5）─────────────────────────────────
  // llm-pi-ai 整节写入（settings.replace）是多步 read-modify-write：并发写者
  // 交错会以陈旧读覆盖彼此的异步结果（applyPiAi/revertPiAi 与探测临时声明、
  // 收敛、固化互相覆盖）。withPiAiWriteLock 把整节写串行化，恢复"单写者、
  // fresh 读 → 变更 → 写"的原子性；探测的实测阶段（llm.stream，单模型最长
  // 约 70s）不持锁，不阻塞用户设置。
  let piAiWriteTail = Promise.resolve()
  function withPiAiWriteLock(fn) {
    const run = piAiWriteTail.then(() => fn())
    piAiWriteTail = run.then(() => undefined, () => undefined)
    return run
  }
  // 同模型探测互斥队列：并发 /probe 同一 provider/model（重复点击/双窗口）时
  // 串行化整个探测流程（临时声明→实测→收敛→回滚），避免两个探测以各自
  // 不同的 raw 快照互相覆盖临时声明与收敛结果。
  const probeQueues = new Map()
  function withProbeQueue(key, fn) {
    const prev = probeQueues.get(key) ?? Promise.resolve()
    const run = prev.then(() => fn())
    const tail = run.then(() => undefined, () => undefined)
    probeQueues.set(key, tail)
    tail.then(() => {
      if (probeQueues.get(key) === tail) probeQueues.delete(key)
    })
    return run
  }

  const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  const clone = (v) => JSON.parse(JSON.stringify(v))

  function supportedLevels(map) {
    if (map === null || map === undefined || typeof map !== 'object') return []
    return LEVELS.filter((level) => {
      const wire = map[level]
      if (wire === undefined) return false
      if (wire === null) return level === 'off'
      return true
    })
  }

  // 识别“本插件生成的”能力声明（当前版 6 键 / 旧版 5 键 / 全量词汇表 7 键标准 wire 形状），
  // 以便自动升级而不是当作手写值。
  // MAINT-017 R1（F3）：探测临时声明与全档固化（working 集含 xhigh 时的 7 键全量）
  // 都是本插件写入的形状——若仅识别 6/5 键，pin（probeEfforts）丢失时 7 键声明
  // 会被误判手写，后续 apply/收敛走“并入”而非“替换”语义（过时档位永不收缩）。
  // MAINT-019（P2-1）：7 键分支加叠 wire 标准性校验（见 isStandardFullVocabWire）——
  // 形状相同但 wire 是用户自定义的声明判为手写，避免替换语义覆盖用户 wire（DEC-012 红线）。
  // 第二参 thinkingFormat 是判定输入（off 线值分叉）；调用点均持有路由的 thinkingFormat。
  function isGeneratedEfforts(map, thinkingFormat) {
    if (map === null || typeof map !== 'object' || Array.isArray(map)) return false
    const keys = Object.keys(map).sort().join(',')
    const current = GENERATED_KEYS.slice().sort().join(',')
    const legacy = ['high', 'low', 'medium', 'minimal', 'off'].join(',')
    // 6 键（当前生成表）/ 5 键（旧版生成表）仍按 key 形状判定：同键集的手写声明与旧生成
    // 声明在形状上不可区分（6/5 键均非完整词表，无 wire 标准性校验面），故此处按形状判定
    // 系 F3-R1「6 键旧 wire 必须 boot 升级」既有承诺的取舍——wire 过期（如 off:'off'）正是
    // 「旧生成声明待升级」的信号，不得当手写而放弃升级（同形手写声明的覆盖暴露面已记录）。
    if (keys === current || keys === legacy) return true
    // MAINT-019（P2-1）：7 键全量形状还必须逐键 wire 等于本插件的标准声明（见
    // isStandardFullVocabWire）——用户恰好手写 7 键 + 自定义 wire（如 openai 路由
    // off:'disabled'）时只看 key 形状会被误判生成，替换语义会覆盖其 wire（DEC-012 红线）。
    return isStandardFullVocabWire(map, thinkingFormat)
  }

  /** 全量词汇表形状（探测临时声明 / 全档固化的 7 键 key 集合，wire 任意）。 */
  function isFullVocabShape(map) {
    if (map === null || typeof map !== 'object' || Array.isArray(map)) return false
    return Object.keys(map).sort().join(',') === THINKING_LEVEL_VOCABULARY.slice().sort().join(',')
  }

  /**
   * MAINT-019（P2-1）：7 键全量形状 + 逐键 wire === 本插件标准声明
   * （buildFullVocabDeclaration(thinkingFormat)）——「本插件生成」的完整判定。
   * 判定基准是路由的 thinkingFormat（off 线值在 zai/deepseek 与 openai 系之间有分叉）；
   * 任一键 wire 非标准 → 手写声明 → 走并入语义保住用户 wire（DEC-012）。
   */
  function isStandardFullVocabWire(map, thinkingFormat) {
    if (!isFullVocabShape(map)) return false
    const standard = buildFullVocabDeclaration(thinkingFormat)
    return THINKING_LEVEL_VOCABULARY.every((level) => deepEq(map[level], standard[level]))
  }

  /** 推导路由的 thinking 格式（决定 off 线值）：zai-coding-cn 路由为 zai，openai 缺省检测。 */
  function thinkingFormatOf(route, api, profile) {
    if (profile?.compat && typeof profile.compat.thinkingFormat === 'string') return profile.compat.thinkingFormat
    if (api !== 'openai-completions') return undefined
    if (route === 'zai' || route === 'zai-coding-cn') return 'zai'
    if (route === 'deepseek' || route === 'deepseek-official') return 'deepseek'
    return undefined
  }

  // ── MAINT-035 读路径统一（0.2.0 取代 settings.get(ns)）─────────────────────
  // describe() 返回描述符数组 [{ns, schema, revision, value, base, user,
  // autoGenerate, applies}]：value = 有效值投影（volatile 字段全量 = defaults ∪
  // user），user = 用户覆盖层。设置面缺席 / describe 异常 → undefined（各调用点
  // 既有 undefined 分支接管，绝不抛出）。
  //
  // ── R0-P1-1（REVIEW-MAINT-035+036-R0）：describe 结果缓存 ──────────────────
  // 宿主 describe() 无缓存——每次全量 profile 目录磁盘读 + YAML 解析 + 全 entry
  // schema toJSON（Reviewer 实测仅文件子集即 ~8.5ms/次）；agent/request 与
  // llm/stream 热路径逐调用触发会给每个请求加 10-40ms，违反「请求路径零影响」。
  // 缓存 + 双重失效：settings 变更事件（宿主对任何写者——含本插件自身写——
  // 都会 emit settings/document-updated，事件面失效即覆盖自有写路径）+
  // TTL 兜底（跨进程旁路写的上限时窗）。返回的描述符对象按不可变约定消费
  //（消费面只读字段；rawSection 对 .user clone 后再改——缓存无污染路径）。
  const DESCRIBE_CACHE_TTL_MS = 5000
  let describeCache = undefined // { entries, at }
  function invalidateDescribeCache() { describeCache = undefined }
  function describeEntries() {
    if (settings === undefined) return undefined
    if (describeCache !== undefined && Date.now() - describeCache.at < DESCRIBE_CACHE_TTL_MS) {
      return describeCache.entries
    }
    const entries = settings.describe()
    describeCache = { entries, at: Date.now() }
    return entries
  }
  function describeEntry(ns) {
    try {
      const entry = describeEntries()?.find((d) => d.ns === ns)
      return entry !== undefined && entry !== null ? entry : undefined
    } catch (error) {
      // describe 抛出（configEditor/profile 面异常）→ 缓存清空，下次再试；
      // 调用点 undefined 分支接管。
      invalidateDescribeCache()
      ctx.logger?.warn('dsh-reasoning-level: describe failed for ' + ns)
      ctx.logger?.warn(error)
      return undefined
    }
  }
  /**
   * 写路径包装（R0-P1-1 三重失效之二）：真实宿主对所有写者 emit
   * settings/document-updated（事件面失效覆盖自有写），但防御性不依赖宿主
   * 事件实现细节——自有写落定后主动失效。探测/收敛路径的 rawSection 读改写
   * （read-modify-write）依赖写后新鲜面；写失败不失效（宿主未变更）。
   */
  function mutateSettings(ns, ops) {
    // 写发起即失效（写内/写后都可能有读）：宿主 write 是异步的，等 resolve 再
    // 失效会让同 tick 的读拿到写前 describe 快照（probe 收口 lastProbe 统计
    // 回显、写后 rawSection 读改写都依赖新鲜面）。
    invalidateDescribeCache()
    const pending = withSelfWriteMarker(ns, () => withHmrRetry(() => settings.mutate(ns, ops)))
    pending.then(() => invalidateDescribeCache(), () => undefined)
    return pending
  }
  function replaceSettings(ns, value) {
    invalidateDescribeCache()
    const pending = withSelfWriteMarker(ns, () => withHmrRetry(() => settings.replace(ns, value)))
    pending.then(() => invalidateDescribeCache(), () => undefined)
    return pending
  }
  /**
   * 标记本插件写某 ns 期间的宿主事件为「自写事件」（按 ns 栈式记录）：真实
   * 宿主在 write 内同步 emit settings/document-updated，handler 在同一同步栈
   * 上看到栈顶/栈内含该 ns。本次写的结果由调用方（apply/revert/probe）负责，
   * handler 不再为它排 apply；写窗口内其他 ns 的事件照常调度（不被吞）。
   */
  async function withSelfWriteMarker(ns, operation) {
    selfWriteNs.push(ns)
    try {
      return await operation()
    } finally {
      selfWriteNs.pop()
    }
  }
  /**
   * HMR 事务安全写（FEAT-007 live-apply 修复的兜底，隔离实例实证根因）：
   * settings/document-updated 在宿主 HMR 配置重载的 `runExclusive` 事务内同步
   * 派发（dsh-hmr `AsyncLocalStorage.run(true, op)`）；此 tick 启动的写被 HMR 以
   * `HMR transactions cannot be nested` 拒绝。事件驱动路径已改为事务外调度
   * （见 scheduleOutsideTransaction），本包装兜住其余可能落在事务内的调用点：
   * 只对这条明确文本重试（其他错误照旧抛出），最多 3 次（0/20/20ms 间隔）；
   * 每次尝试都整体在事务外执行（仅延时/仅重试一次都不够——async 上下文会继续
   * 继承事务），普通 setTimeout 创建的重试仍会被 runExclusive 拒绝。
   */
  async function withHmrRetry(operation) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => { scheduleOutsideTransaction(resolve, 20) })
      try {
        return await runOutsideTransaction(operation)
      } catch (error) {
        const nested = /HMR transactions cannot be nested/.test(String(error?.message ?? ''))
        if (!nested || attempt === 2) throw error
        ctx.logger?.warn(`dsh-reasoning-level: settings write hit HMR transaction, retrying outside it (attempt ${attempt + 1})`)
      }
    }
    // 不可达：3 次尝试要么 return 要么 throw。
    throw new Error('dsh-reasoning-level: HMR retry exhausted')
  }
  /** 命名空间有效值投影（等价旧 settings.get(ns) 的 resolved 语义）。 */
  function configOf(ns) {
    const entry = describeEntry(ns)
    return entry !== undefined ? entry.value : undefined
  }

  // 读取 llm-pi-ai 命名空间的原始 user 节（结构等同设置文件）。
  // v0.6.0：不再请求 redactSecrets 脱敏视图——本插件运行在宿主侧而非 wire 面，
  // 原值往返才能保证 replace 写回无损；脱敏视图曾意味着任何 role('secret')
  // 字段都会在整节 replace 时被静默清空（该 schema 今天没有 secret 字段，
  // 但不能把安全性押在别人的 schema 演进上）。
  // MAINT-035：.user 语义延续（0.2.0 描述符同样携带 user 覆盖层投影）。
  function rawSection(ns) {
    const entry = describeEntry(ns)
    return entry !== undefined && entry.user !== undefined ? clone(entry.user) : undefined
  }

  // ── FEAT-007：采样参数生效面（设计 §4.1/§4.2）──────────────────────────────
  /** 读取配置对象里的某个 plain 子对象（脏形状 → {}）。 */
  function plainObjectOf(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
  }

  /**
   * 某模型的插件生效采样参数 = defaults.params ← modelParams["provider/model"]
   * （模型级优先，逐字段）。查表 O(1)，sanitize 在注册表层完成；任何异常只
   * 降级为「无参数」，绝不打断请求。
   */
  function effectiveParamsFor(cfg, provider, model) {
    try {
      if (cfg === undefined || cfg === null || typeof cfg !== 'object') return {}
      const defaults = plainObjectOf(cfg.defaults) !== undefined ? plainObjectOf(cfg.defaults).params : undefined
      const modelParams = plainObjectOf(cfg.modelParams)
      const override = modelParams !== undefined ? modelParams[provider + '/' + model] : undefined
      return mergeParams(defaults, override)
    } catch (error) {
      return {}
    }
  }

  /**
   * call-config 参数注入（agent/request 瀑布，设计 §4.2 注入点 1）：只填
   * undefined 的 temperature/maxTokens；调用方显式值优先；topP/topK 属
   * reserved，永不注入。无变化时返回原对象引用（请求路径零副作用）。
   */
  function withCallParams(config, cfg) {
    if (config === null || typeof config !== 'object') return config
    const params = activeCallParams(effectiveParamsFor(cfg, config.provider, config.model))
    let next = config
    for (const key of ['temperature', 'maxTokens']) {
      if (params[key] === undefined || next[key] !== undefined) continue
      if (next === config) next = { ...config }
      next[key] = params[key]
    }
    return next
  }

  /**
   * options 参数注入（llm/stream 未冻结手建调用，设计 §4.2 注入点 2）：只写
   * undefined 的 temperature/maxTokens；probe/冻结判定由调用点负责。
   */
  function writeCallParamsInto(options, cfg) {
    if (options === null || typeof options !== 'object') return
    const params = activeCallParams(effectiveParamsFor(cfg, options.provider, options.model))
    for (const key of ['temperature', 'maxTokens']) {
      if (params[key] === undefined || options[key] !== undefined) continue
      options[key] = params[key]
    }
  }

  /**
   * 查询并缓存一个模型支持的推理等级（adapter 不识别时返回 undefined）。
   *
   * MAINT-041：DeepSeek 系两条适配器路由有**文档化**的固定档位集合
   * （official lib/index.js `OFF/LOW/HIGH/MAX_REASONING_EFFORT` 常量；account
   * README.zh.md「每个模型都提供 off、low、high、max」）。当 resolveModelInfo
   * 对它们返回空/抛错时，按该契约兜底——否则「模型级默认」对这两条路由完全
   * 不生效（`agent/request` 注入要求 efforts 非空），这是与全局默认同一族的缺口。
   * 兜底只在**该适配器的设置节已注册**时成立（未安装的 provider 不臆造能力）。
   */
  async function supportedEfforts(provider, model) {
    const key = provider + '/' + model
    if (effortsCache.has(key)) return effortsCache.get(key)
    let efforts
    try {
      const info = await llm.resolveModelInfo(provider, model)
      efforts = info.reasoning !== undefined && Array.isArray(info.reasoning.efforts)
        ? info.reasoning.efforts.map((entry) => entry.id)
        : []
    } catch (error) {
      efforts = undefined
    }
    if (efforts === undefined || efforts.length === 0) {
      const route = deepseekRouteOf(provider)
      if (route !== undefined) efforts = DEEPSEEK_LEVELS.slice()
    }
    effortsCache.set(key, efforts)
    return efforts
  }

  /** provider → DEEPSEEK_ROUTES 条目（仅当该适配器的设置节已注册；MAINT-041）。 */
  function deepseekRouteOf(provider) {
    const route = DEEPSEEK_ROUTES.find((item) => item.provider === provider)
    if (route === undefined) return undefined
    try {
      return configOf(settingsNamespace(route.ns)) !== undefined ? route : undefined
    } catch (error) { return undefined }
  }

  /** 从失败信息提取“实测拒绝”的等级（pi-ai 与 llm-deepseek 的错误文案/码）。 */
  function rejectionLevelOf(failure) {
    if (failure === undefined || failure === null) return undefined
    const text = (typeof failure.message === 'string' ? failure.message : '') + ' ' + (typeof failure.code === 'string' ? failure.code : '')
    const match = text.match(/reasoning effort "([^"]+)"/)
    if (match !== null) return match[1]
    return undefined
  }

  /**
   * 「等级不被该网关接受」的结构化判定——**枚举证据**（真实环境 2026-10-21）：
   * 聚合网关对 `minimal` 返回 `INVALID_REQUEST 400: {"message":"Invalid option:
   * expected one of \"off\"|\"low\"|\"medium\"|\"high\"|\"xhigh\"|\"max\""}`。
   *
   * 判据（三条同时成立，缺一不算）：
   *  1. 错误文本是「枚举校验」语义（expected one of / must be one of / invalid option）；
   *  2. 文本里能解析出 **≥3 个** 已知 effort 词（词表 = LEVELS ∪ {none, auto, default}）——
   *     少于 3 个说明这更像是别的字段的枚举，不做断言（宁可不归类，也不误判）；
   *  3. 被请求的 `level` **不在**该枚举里 —— 即该档位确实被排除。
   *
   * 与 `rejectionLevelOf` 的区别：后者只认「reasoning effort "X"」这种指名字样，
   * 网关换一种措辞（枚举式）就漏判，导致探测把它当「其他错误」而不是「不支持」。
   * 返回 level 表示「这一档被枚举证据排除」，undefined 表示无证据。
   */
  const EFFORT_ENUM_VOCABULARY = new Set([...THINKING_LEVEL_VOCABULARY, 'none', 'auto', 'default'])
  function rejectionLevelFromEnumeration(failure, level) {
    if (failure === undefined || failure === null || typeof level !== 'string') return undefined
    const message = typeof failure.message === 'string' ? failure.message : ''
    if (!/expected one of|must be one of|invalid option|one of the following/i.test(message)) return undefined
    // 按词边界扫词表，而不是按「引号包裹」解析：网关的错误体常是**原始 JSON 文本**，
    // 引号前面带反斜杠（`\"off\"|\"low\"`，用户截图实证），按引号配对会一个都取不到。
    // 枚举语义已在上一行把关，这里只统计出现了几个 effort 词。
    const found = new Set()
    const wordRe = /\b([a-z][a-z-]{1,15})\b/gi
    let match
    while ((match = wordRe.exec(message)) !== null) {
      const token = match[1].toLowerCase()
      if (EFFORT_ENUM_VOCABULARY.has(token)) found.add(token)
    }
    if (found.size < 3) return undefined
    return found.has(level) ? undefined : level
  }

  /**
   * 记入实测黑名单（仅当前会话内存态，不持久化）：真实调用被网关拒绝该等级 →
   * 后续注入跳过。探测路径（probeModelLevels / /test）不调用本函数——探测是
   * "测量"，其拒绝结果只进该次探测的 rejected 列表。
   */
  function markRejected(provider, model, level) {
    if (provider === undefined || model === undefined || level === undefined) return
    const key = provider + '/' + model
    let set = blacklist.get(key)
    if (set === undefined) {
      set = new Set()
      blacklist.set(key, set)
    }
    if (!set.has(level)) {
      set.add(level)
      ctx.logger?.warn(`dsh-reasoning-level: ${key} 实测拒绝 ${level}，已加入本会话黑名单（注入将跳过）`)
    }
  }

  /** 持久化实测固化的能力声明（merge 后整键 replace probeEfforts）。 */
  function persistProbeEfforts(providerModelMap) {
    try {
      const current = configOf(NS)
      const prev = current !== undefined && typeof current.probeEfforts === 'object' && current.probeEfforts !== null ? clone(current.probeEfforts) : {}
      let changed = false
      for (const [providerModel, map] of Object.entries(providerModelMap)) {
        if (!deepEq(prev[providerModel], map)) changed = true
        prev[providerModel] = map
      }
      if (!changed) return
      mutateSettings(NS, [{ op: 'set', path: ['probeEfforts'], value: prev }]).catch((error) => {
        ctx.logger?.warn('dsh-reasoning-level: probeEfforts persist failed')
        ctx.logger?.warn(error)
      })
    } catch (error) {
      ctx.logger?.warn('dsh-reasoning-level: probeEfforts persist failed')
      ctx.logger?.warn(error)
    }
  }

  /** 启动时恢复持久化的实测能力声明（probeEfforts，并集合并幂等）。
   *  持久化黑名单（probeBlacklist）自 v0.7.1（MAINT-013）起不再装载——黑名单
   *  仅当前会话内存态，由真实调用失败自愈建立，重启即清零。 */
  function hydrateVerifiedEfforts() {
    try {
      const cfg = configOf(NS)
      if (cfg !== undefined && cfg.probeEfforts !== undefined) {
        for (const [providerModel, map] of Object.entries(cfg.probeEfforts)) {
          if (typeof map !== 'object' || map === null) continue
          const sep = providerModel.indexOf('/')
          if (sep <= 0) continue
          verifiedEfforts.set(providerModel.slice(0, sep) + '\u0000' + providerModel.slice(sep + 1), clone(map))
        }
      }
    } catch (error) { /* 能力声明恢复失败不影响其余功能 */ }
  }

  /**
   * 读取持久化 deepseek 所有权台账（{ level, original } | undefined；028-F1）。
   * `key` = DEEPSEEK_ROUTES 的 key（deepseek / deepseekAccount），两条路由各自独立。
   *
   * REVIEW-REL-012-R0 P1（2026-10-22，真机实测）：schemastery 会把**缺席的嵌套
   * object 字段物化成 `{}`**（`Config['~standard'].validate(旧配置)` 得到
   * `applied.deepseekAccount === {}`）。旧实现只看「entry 是不是对象」→ 永远判成
   * 「台账已存在」→ `ledger.original` 恒 undefined → 写入时被 dsh-settings 的
   * cloneJsonShaped 剥掉 → **original 从来没落过盘**（本机 profile 实证：
   * `applied.deepseek` / `deepseekAccount` 都只有 `level`，没有 `original`）。
   * 因此「有 level 才算持有所有权」是唯一可靠判据；空对象视同缺席。
   */
  function readAppliedDeepseek(key = 'deepseek') {
    try {
      const cfg = configOf(NS)
      const applied = cfg !== undefined && cfg.applied !== undefined && typeof cfg.applied === 'object' && cfg.applied !== null ? cfg.applied : undefined
      if (applied === undefined) return undefined
      const entry = applied[key]
      if (entry === undefined || typeof entry !== 'object' || entry === null) return undefined
      if (typeof entry.level !== 'string') return undefined
      return entry
    } catch (error) { return undefined }
  }

  /**
   * 028-F1：持久化所有权台账（llm-reasoning.applied）——整字段 read-modify-write
   * 合并（与 persistProbeEfforts 同模式），失败仅 warn（不阻塞主流程）。
   * patch: { routes?: {route: level|null}, deepseek?: ..., deepseekAccount?: ...,
   *         任一为 null = 清除该所有权；undefined = 不改动该子字段 }
   *
   * MAINT-041：RMW 必须**串行**。旧实现每次写都不等待上一次落定，而 describe 缓存
   * 在写落定后才失效——于是「official 写台账 → account 写台账」两次紧邻调用都读到
   * 同一份旧值，后写覆盖先写（真机表现：只剩 deepseekAccount，deepseek 的 original
   * 丢失，关闭插件时无法还原 official 路由）。用一条 promise 链把写串起来。
   */
  let appliedLedgerChain = Promise.resolve()
  function persistAppliedLedger(patch) {
    appliedLedgerChain = appliedLedgerChain
      .then(() => persistAppliedLedgerCore(patch))
      .catch(() => undefined)
    return appliedLedgerChain
  }

  async function persistAppliedLedgerCore(patch) {
    try {
      const current = configOf(NS)
      const prev = current !== undefined && current.applied !== undefined && typeof current.applied === 'object' && current.applied !== null ? clone(current.applied) : {}
      if (prev.routes === undefined || typeof prev.routes !== 'object' || prev.routes === null) prev.routes = {}
      let changed = false
      if (patch.routes !== undefined) {
        for (const [route, level] of Object.entries(patch.routes)) {
          if (level === null) {
            if (prev.routes[route] !== undefined) { delete prev.routes[route]; changed = true }
          } else if (prev.routes[route] !== level) { prev.routes[route] = level; changed = true }
        }
      }
      // MAINT-041：deepseek / deepseekAccount 形状相同，按 DEEPSEEK_ROUTES 逐项合并
      for (const { key } of DEEPSEEK_ROUTES) {
        if (patch[key] === undefined) continue
        if (patch[key] === null) {
          if (prev[key] !== undefined) { delete prev[key]; changed = true }
        } else if (!deepEq(prev[key], patch[key])) { prev[key] = patch[key]; changed = true }
      }
      if (!changed) return
      await mutateSettings(NS, [{ op: 'set', path: ['applied'], value: prev }])
    } catch (error) {
      ctx.logger?.warn('dsh-reasoning-level: applied ledger persist failed')
      ctx.logger?.warn(error)
    }
  }

  /**
   * 启动时恢复持久化所有权台账（028-F1）：hydrate 进 myRouteReasoning /
   * myDeepseekEffort——此后所有权判定（applyPiAi :468 门控 / revert / deepseek
   * 还原）自动基于「持久台账 ∪ 内存台账」，重启不再失忆。恢复失败仅降级为
   * 会话态（与修复前行为一致），不影响其余功能。
   */
  function hydrateAppliedLedger() {
    try {
      const cfg = configOf(NS)
      const applied = cfg !== undefined && cfg.applied !== undefined && typeof cfg.applied === 'object' && cfg.applied !== null ? cfg.applied : undefined
      if (applied === undefined) return
      if (applied.routes !== undefined && typeof applied.routes === 'object' && applied.routes !== null) {
        for (const [route, level] of Object.entries(applied.routes)) {
          if (typeof level === 'string') myRouteReasoning.set(route, level)
        }
      }
      if (applied.deepseek !== undefined && typeof applied.deepseek === 'object' && applied.deepseek !== null && typeof applied.deepseek.level === 'string') {
        myDeepseekEffort.deepseek = applied.deepseek.level
      }
      // MAINT-041：账号版适配器同一台账形状（缺失 = 未持有所有权，零迁移）
      if (applied.deepseekAccount !== undefined && typeof applied.deepseekAccount === 'object' && applied.deepseekAccount !== null && typeof applied.deepseekAccount.level === 'string') {
        myDeepseekEffort.deepseekAccount = applied.deepseekAccount.level
      }
    } catch (error) { /* 台账恢复失败不影响其余功能 */ }
  }

  async function applyLevel() {
    if (running) { queued = true; return }
    running = true
    try {
      effortsCache = new Map()
      const cfg = configOf(NS)
      if (cfg === undefined) return
      if (cfg.enabled) {
        await applyPiAi(cfg.level)
        // FEAT-007：多模态写回在 reasoning 写之后（同一 llm-pi-ai 整节 RMW，
        // 串行化锁内各取 fresh raw，互不覆盖）。
        await applyModelInputs()
        await applyDeepseekRoutes(cfg.level)
        if (cfg.syncDefaultAgent === true) await applyDefaultAgent(cfg.level)
      } else {
        await revertPiAi()
        // FEAT-007：关闭插件时撤销输入模态声明（仅 current===written 时恢复）。
        await revertModelInputs()
        await revertDeepseekRoutes()
      }
      ctx.logger?.info(`dsh-reasoning-level: applied, level=${cfg.level}, models-configured=${Object.keys(cfg.models ?? {}).length}, routes=${myRouteReasoning.size}, models=${myModelEfforts.size}, deepseek=${DEEPSEEK_ROUTES.filter((r) => myDeepseekEffort[r.key] !== undefined).map((r) => r.key).join('+') || 'none'}`)
    } catch (error) {
      ctx.logger?.warn('dsh-reasoning-level: apply failed')
      ctx.logger?.warn(error)
    } finally {
      running = false
      if (queued) { queued = false; scheduleApply(0) }
    }
  }

  /** 会改变写入结果的设置命名空间（含 MAINT-041 账号版适配器）。 */
  function isRelevantSettingsNs(ns) {
    return ns === NS
      || ns === settingsNamespace(HOST_NAMESPACES.piAi)
      || ns === settingsNamespace(HOST_NAMESPACES.deepseek)
      || ns === settingsNamespace(HOST_NAMESPACES.deepseekAccount)
      || ns === settingsNamespace(HOST_NAMESPACES.agentDefaultModel)
  }

  /**
   * 合并调度一次 apply（FEAT-007 live-apply 修复）：
   *  · 经 scheduleOutsideTransaction 在宿主 HMR 事务外、下一 macrotask 执行——
   *    handler 若在 HMR 事务内同步启动 apply，其 settings 写会被 runExclusive 以
   *    「HMR transactions cannot be nested」拒绝（隔离实例实证）；
   *  · first-wins 合并：同一 tick/短窗口内的多个 ns 事件只跑一次（与当前写同
   *    ns 的自写同步事件已由 selfWriteNs 在源头剔除，异步重载事件合并成一次
   *    无写收敛）；
   *  · 回调里重新失效缓存（调度到执行之间可能又收到写），再执行 apply。
   */
  function scheduleApply(delayMs = APPLY_SCHEDULE_DELAY_MS) {
    if (pendingApplyHandle !== null) return
    pendingApplyHandle = scheduleOutsideTransaction(() => {
      pendingApplyHandle = null
      invalidateDescribeCache()
      invalidateModelsCache()
      applyLevel().then(() => effortEnforcer.sweep()).catch((error) => {
        ctx.logger?.warn('dsh-reasoning-level: settings-triggered apply/sweep failed')
        ctx.logger?.warn(error)
      })
    }, Math.max(0, delayMs))
  }

  /** 取消挂起的合并调度（child/fiber 卸载时）。 */
  function cancelScheduledApply() {
    const handle = pendingApplyHandle
    pendingApplyHandle = null
    if (handle === null) return
    if (handle.immediate !== undefined) clearImmediate(handle.immediate)
    else if (handle.timer !== undefined) clearTimeout(handle.timer)
  }

  // llm-pi-ai：从原始 user 节构建目标节，整体 replace
  // （settings.mutate 的路径 op 不支持数组索引，models[i] 必须整节替换）
  async function applyPiAi(level) {
    await withPiAiWriteLock(() => applyPiAiCore(level))
  }

  async function applyPiAiCore(level) {
    const resolved = configOf(settingsNamespace(HOST_NAMESPACES.piAi))
    if (resolved === undefined) return
    const raw = rawSection(HOST_NAMESPACES.piAi)
    if (raw === undefined) return
    const target = clone(raw)
    const targetProviders = target.providers ?? {}
    const pendingModels = []
    const pendingRoutes = new Map()
    for (const [route, rawProfile] of Object.entries(targetProviders)) {
      if (!Array.isArray(rawProfile.models) || rawProfile.models.length === 0) continue
      // 路由未显式声明 api 时按共享目录协议的惯例（当前各路由均为 openai 系）
      const api = typeof rawProfile.api === 'string' ? rawProfile.api : 'openai-completions'
      const thinkingFormat = thinkingFormatOf(route, api, rawProfile)
      const effortsForRoute = generatedEffortsFor(thinkingFormat)
      const supportedByModel = []
      for (let i = 0; i < rawProfile.models.length; i++) {
        const model = rawProfile.models[i]
        const key = route + '\u0000' + model.id
        const mine = myModelEfforts.get(key)
        const rawEfforts = model.reasoningEfforts
        if (mine !== undefined && deepEq(rawEfforts, effortsForRoute)) {
          supportedByModel.push(GENERATED_LEVELS)
          continue
        }
        // v0.7.0：一键探测固化的实测能力声明（与生成表可能不同，如网关实测拒绝的档
        // 已被剪掉）。钉在台账里：不再按"生成形状"升级/覆盖，实测结果即真值。
        const pinned = verifiedEfforts.get(key)
        if (pinned !== undefined && rawEfforts !== undefined && deepEq(rawEfforts, pinned)) {
          supportedByModel.push(supportedLevels(rawEfforts))
          continue
        }
        if (isGeneratedEfforts(rawEfforts, thinkingFormat)) {
          // 本插件生成的声明（含旧版形状）：必要时升级为当前能力表（off 线值按协议）。
          // MAINT-017 R1（F3 配套）：全量 7 键形状（探测临时声明/固化 working 集）
          // 已是能力表上界——不得“升级”为 6 键生成表（会把探测窗口内的声明改小、
          // 丢弃 xhigh）。
          if (!deepEq(rawEfforts, effortsForRoute) && !isFullVocabShape(rawEfforts)) {
            rawProfile.models[i] = { ...model, reasoningEfforts: clone(effortsForRoute) }
            pendingModels.push({ key, efforts: clone(effortsForRoute) })
          }
          supportedByModel.push(isFullVocabShape(rawEfforts) ? supportedLevels(rawEfforts) : GENERATED_LEVELS)
          continue
        }
        if (rawEfforts !== undefined) {
          supportedByModel.push(supportedLevels(rawEfforts))
          continue
        }
        let info
        try {
          info = await llm.resolveModelInfo(route, model.id)
        } catch (error) {
          info = undefined
        }
        if (info !== undefined && info.reasoning !== undefined && Array.isArray(info.reasoning.efforts)) {
          const list = info.reasoning.efforts.map((entry) => entry.id)
          effortsCache.set(route + '/' + model.id, list)
          supportedByModel.push(list)
          continue
        }
        // 手写声明且无推理能力：自动声明（使模型选择器出现推理等级，并支持默认等级）
        if (api === 'openai-completions' || api === 'openai-responses') {
          rawProfile.models[i] = { ...model, reasoningEfforts: clone(effortsForRoute) }
          pendingModels.push({ key, efforts: clone(effortsForRoute) })
          supportedByModel.push(GENERATED_LEVELS)
        } else {
          supportedByModel.push([])
        }
      }
      // 路由级默认等级：仅当该路由每个模型都支持时才写，避免 UNSUPPORTED_REASONING_EFFORT
      const allSupport = supportedByModel.every((list) => list.includes(level))
      const mineLevel = myRouteReasoning.get(route)
      const current = rawProfile.reasoning
      if (allSupport) {
        if (current !== level && (current === undefined || (mineLevel !== undefined && current === mineLevel))) {
          rawProfile.reasoning = level
          pendingRoutes.set(route, level)
        }
      } else if (mineLevel !== undefined && current === mineLevel && current !== undefined) {
        delete rawProfile.reasoning
        pendingRoutes.set(route, null)
      }
    }
    if (!deepEq(target, raw)) {
      try {
        await replaceSettings(settingsNamespace(HOST_NAMESPACES.piAi),target)
        for (const entry of pendingModels) myModelEfforts.set(entry.key, entry.efforts)
        if (pendingRoutes.size > 0) {
          const routesPatch = {}
          for (const [route, value] of pendingRoutes) {
            if (value === null) { myRouteReasoning.delete(route); routesPatch[route] = null }
            else { myRouteReasoning.set(route, value); routesPatch[route] = value }
          }
          // 028-F1：路由所有权同步落盘（重启后凭台账认领；门控语义不变——用户手改不覆盖）
          persistAppliedLedger({ routes: routesPatch })
        }
      } catch (error) {
        ctx.logger?.warn('dsh-reasoning-level: llm-pi-ai replace failed')
        ctx.logger?.warn(error)
      }
    } else {
    }
  }

  /**
   * DeepSeek 系独立适配器路由的等级同步（MAINT-041）：逐条 DEEPSEEK_ROUTES 处理。
   * 关键事实（用户 2026-10-22 报障根因）：`deepseek-account` 路由**不在**
   * `llm-pi-ai.providers` 里，它的默认等级只由 `llm-deepseek-account.reasoningEffort`
   * 决定（适配器默认 high）。修复前只同步 `llm-deepseek`，于是账号管理的模型
   * 无论全局设成什么都停在 High。
   *
   * 每条路由独立判定：命名空间未注册（该适配器未安装）→ 跳过，不写、不落台账。
   */
  async function applyDeepseekRoutes(level) {
    for (const route of DEEPSEEK_ROUTES) {
      await applyDeepseekRoute(route, level)
    }
  }

  async function applyDeepseekRoute(route, level) {
    let section
    try {
      section = configOf(settingsNamespace(route.ns))
    } catch (error) { return }
    if (section === undefined) return
    // 宿主该适配器若显式关掉了 thinking（thinking: 'disabled'），思考等级整体无效
    if (section.thinking === 'disabled') return
    // 首写前捕获覆盖前原节（会话内兜底；持久台账优先，见 restoreDeepseekDefault）。
    // REVIEW-REL-012-R0 P1：**必须在写之前**取；且只在这个窗口里有效——
    // 重启后 section 已经是插件上次写的值，不是用户原值。
    if (originalDeepseek[route.key] === null) originalDeepseek[route.key] = clone(section)
    try {
      if (DEEPSEEK_LEVELS.includes(level)) {
        if (section.reasoningEffort !== level) {
          // 原值必须在写之前落定（写后 section 就变成新值了）
          const capturedOriginal = originalDeepseek[route.key]
          const capturedEffort = capturedOriginal !== null && capturedOriginal.reasoningEffort !== undefined
            ? capturedOriginal.reasoningEffort
            : null
          await mutateSettings(settingsNamespace(route.ns), [{ op: 'set', path: ['reasoningEffort'], value: level }])
          // 028-F1：所有权落盘——首写取覆盖前原值，续写保留台账既有 original
          // （用户先验值不因等级调整丢失）；null = 覆盖前缺省。
          // 台账存在但缺 original（升级用户的历史写入）→ 保持 null，绝不再写
          // undefined（否则被 cloneJsonShaped 剥掉，等于没记）。
          const ledger = readAppliedDeepseek(route.key)
          const original = ledger !== undefined
            ? (ledger.original !== undefined ? ledger.original : null)
            : capturedEffort
          persistAppliedLedger({ [route.key]: { level, original } })
          myDeepseekEffort[route.key] = level
        }
      } else if (myDeepseekEffort[route.key] !== undefined && section.reasoningEffort === myDeepseekEffort[route.key]) {
        await restoreDeepseekDefault(route)
      }
    } catch (error) {
      ctx.logger?.warn(`dsh-reasoning-level: ${route.ns} mutate failed`)
      ctx.logger?.warn(error)
    }
  }

  /**
   * 还原某 DeepSeek 适配器的 reasoningEffort 至插件介入前状态（028-F1）：优先持久
   * 台账的 original（跨重启正确——会话内存 originalDeepseek 在重启后会误捕插件
   * 自己写的值）；台账缺席时回退本会话快照；均无 → unset。还原后清除所有权。
   */
  async function restoreDeepseekDefault(route) {
    const ledger = readAppliedDeepseek(route.key)
    const sessionOriginal = originalDeepseek[route.key]
    // REVIEW-REL-012-R0 P1：台账存在但**没有 original**（升级用户：历史写入被
    // schemastery 物化 + cloneJsonShaped 剥掉了 original）→ 视为「原本缺省」，
    // 走 unset。**不得**回退会话快照：重启后该快照捕获的是插件自己上次写的值，
    // 用它还原等于原地不动（用户看到的仍是 max，还以为还原了）。
    const original = ledger !== undefined
      ? (ledger.original !== undefined ? ledger.original : null)
      : (sessionOriginal !== null && sessionOriginal.reasoningEffort !== undefined ? sessionOriginal.reasoningEffort : null)
    const op = original !== null ? { op: 'set', path: ['reasoningEffort'], value: original } : { op: 'unset', path: ['reasoningEffort'] }
    await mutateSettings(settingsNamespace(route.ns), [op])
    myDeepseekEffort[route.key] = undefined
    persistAppliedLedger({ [route.key]: null })
  }

  /** P1-2：syncDefaultAgent 开启时，把全局等级同步到默认 agent 模型的 reasoningEffort（校验支持）。 */
  async function applyDefaultAgent(level) {
    try {
      const adm = configOf(settingsNamespace(HOST_NAMESPACES.agentDefaultModel))
      if (adm === undefined || typeof adm.provider !== 'string' || typeof adm.model !== 'string') return
      if (adm.provider === '' || adm.model === '') return
      const efforts = await supportedEfforts(adm.provider, adm.model)
      if (efforts === undefined || efforts.length === 0) return
      if (!efforts.includes(level)) {
        ctx.logger?.warn(`dsh-reasoning-level: syncDefaultAgent skip — ${adm.provider}/${adm.model} does not support ${level}`)
        return
      }
      if (adm.reasoningEffort === level) return
      await mutateSettings(settingsNamespace(HOST_NAMESPACES.agentDefaultModel), [{ op: 'set', path: ['reasoningEffort'], value: level }])
      ctx.logger?.info(`dsh-reasoning-level: synced default agent model to ${level}`)
    } catch (error) {
      ctx.logger?.warn('dsh-reasoning-level: syncDefaultAgent failed')
      ctx.logger?.warn(error)
    }
  }

  async function revertPiAi() {
    await withPiAiWriteLock(() => revertPiAiCore())
  }

  async function revertPiAiCore() {
    const raw = rawSection(HOST_NAMESPACES.piAi)
    if (raw === undefined) return
    const target = clone(raw)
    const providers = target.providers ?? {}
    const revertedRoutes = []
    for (const [route, profile] of Object.entries(providers)) {
      const mineLevel = myRouteReasoning.get(route)
      if (mineLevel !== undefined && profile.reasoning === mineLevel) {
        delete profile.reasoning
        revertedRoutes.push(route)
      }
      if (Array.isArray(profile.models)) {
        for (let i = 0; i < profile.models.length; i++) {
          const mine = myModelEfforts.get(route + '\u0000' + profile.models[i].id)
          if (mine !== undefined && deepEq(profile.models[i].reasoningEfforts, mine)) {
            delete profile.models[i].reasoningEfforts
          }
        }
      }
    }
    if (!deepEq(target, raw)) {
      try {
        await replaceSettings(settingsNamespace(HOST_NAMESPACES.piAi),target)
        // 028-F1：还原成功后同步清除路由所有权（内存 + 持久台账）——重启后禁用也可还原
        if (revertedRoutes.length > 0) {
          const routesPatch = {}
          for (const route of revertedRoutes) { myRouteReasoning.delete(route); routesPatch[route] = null }
          persistAppliedLedger({ routes: routesPatch })
        }
      } catch (error) {
        ctx.logger?.warn('dsh-reasoning-level: revert llm-pi-ai failed')
        ctx.logger?.warn(error)
      }
    }
  }

  // ── FEAT-007：多模态能力写回（设计 §4.3；写点策略在 lib/model-capabilities.js）──
  /**
   * 输入模态写点的路由描述：deepseek 系两代适配器走各自设置节（且只有该适配器
   * 已安装/设置节可见时才归它管）；其余路由按 pi-ai 处理。
   */
  function inputRouteOf(provider) {
    const route = DEEPSEEK_ROUTES.find((item) => item.provider === provider)
    if (route !== undefined) {
      try {
        if (configOf(settingsNamespace(route.ns)) === undefined) return undefined
      } catch (error) { return undefined }
      return { kind: 'deepseek', ns: settingsNamespace(route.ns) }
    }
    return { kind: 'pi-ai', ns: settingsNamespace(HOST_NAMESPACES.piAi) }
  }

  /** 启动时恢复能力写回台账（appliedInputs；缺席 = 未持有所有权，历史数据零迁移）。 */
  function hydrateAppliedInputs() {
    try {
      const cfg = configOf(NS)
      const applied = cfg !== undefined ? plainObjectOf(cfg.appliedInputs) : undefined
      if (applied === undefined) return
      for (const [key, entry] of Object.entries(applied)) {
        if (entry === null || typeof entry !== 'object') continue
        if (!Array.isArray(entry.written)) continue
        const previous = entry.previous === null || entry.previous === undefined
          ? null
          : (Array.isArray(entry.previous) ? clone(entry.previous) : null)
        inputLedger.set(key, { written: clone(entry.written), previous })
      }
    } catch (error) { /* 台账恢复失败不影响其余功能 */ }
  }

  /** 持久化能力写回台账（整字段 set；失败仅 warn，不影响已落定的宿主节）。 */
  async function persistAppliedInputs() {
    try {
      const value = {}
      for (const [key, entry] of inputLedger) {
        value[key] = {
          written: clone(entry.written),
          previous: entry.previous === null ? null : clone(entry.previous),
        }
      }
      await mutateSettings(NS, [{ op: 'set', path: ['appliedInputs'], value }])
    } catch (error) {
      ctx.logger?.warn('dsh-reasoning-level: appliedInputs persist failed')
      ctx.logger?.warn(error)
    }
  }

  /**
   * 写入成功后更新台账——**保留原始 previous**（REVIEW 集成提醒的能力台账缺陷）：
   * 用户把「我方写的值」再改回另一档时（写 image → 关 image），plan.previous
   * 是「我方上一次写入值」而非宿主原始值；若直接覆盖，撤销会恢复成上一次的
   * 我方值（图像被错误重新打开）。判据：plan.previous 深等于既有 ledger.written
   * ⇒ 说明当前宿主值是我方写的，previous 沿用既有原始基线；否则用户手改过
   * 宿主值（plan.previous = 用户新基线），才替换 previous。
   */
  function rememberInputWrite(key, plan) {
    const existing = inputLedger.get(key)
    const keepOriginalPrevious = existing !== undefined && deepEq(plan.previous, existing.written)
    const previous = keepOriginalPrevious ? existing.previous : plan.previous
    inputLedger.set(key, {
      written: clone(plan.written),
      previous: previous === null ? null : clone(previous),
    })
  }

  /**
   * 对某命名空间批量规划并写入输入模态：read raw → clone → 逐模型 plan →
   * 一次 settings.replace 整节。只有 changed 的模型进 updated；写成功后才
   * 登记台账（写失败不得留「内存已记、磁盘未写」的分叉）。
   */
  async function applyInputsToSection(ns, kind, items) {
    let raw
    try { raw = rawSection(ns) } catch (error) { raw = undefined }
    if (raw === undefined) return
    const modelInput = plainObjectOf(configOf(NS)?.modelInput) ?? {}
    let target = raw
    const updated = []
    for (const item of items) {
      const plan = planInputWrite({ section: target, kind, provider: item.provider, model: item.model, input: modelInput[item.key] })
      if (plan.changed !== true) continue
      target = plan.section
      updated.push({ key: item.key, plan })
    }
    if (updated.length === 0) return
    try {
      await replaceSettings(ns, target)
      for (const entry of updated) rememberInputWrite(entry.key, entry.plan)
      await persistAppliedInputs()
    } catch (error) {
      ctx.logger?.warn(`dsh-reasoning-level: ${ns} input replace failed`)
      ctx.logger?.warn(error)
    }
  }

  /**
   * 撤销单个模型的输入模态写回。三种结局：
   *  · current === written → 恢复 previous（并落 replace）；
   *  · current ≠ written（用户手改）→ 不动宿主值，只清台账（尊重用户）；
   *  · 结构/路由已不存在 → 无可恢复，只清台账。
   * replace 失败时保留台账（下次 apply 重试），绝不假装已撤销。
   */
  async function revertModelInput(key) {
    const entry = inputLedger.get(key)
    if (entry === undefined) return
    const parsed = parseModelKey(key)
    let route
    try { route = parsed !== undefined ? inputRouteOf(parsed.provider) : undefined } catch (error) { route = undefined }
    if (route !== undefined && parsed !== undefined) {
      const run = async () => {
        let raw
        try { raw = rawSection(route.ns) } catch (error) { raw = undefined }
        if (raw !== undefined) {
          const plan = planInputRevert({
            section: raw,
            kind: route.kind,
            provider: parsed.provider,
            model: parsed.model,
            written: entry.written,
            previous: entry.previous,
          })
          if (plan.changed === true) {
            try {
              await replaceSettings(route.ns, plan.section)
            } catch (error) {
              ctx.logger?.warn(`dsh-reasoning-level: ${route.ns} input revert failed`)
              ctx.logger?.warn(error)
              return
            }
          }
        }
        inputLedger.delete(key)
        await persistAppliedInputs()
      }
      if (route.kind === 'pi-ai') await withPiAiWriteLock(run)
      else await run()
      return
    }
    // 路由/适配器已不在场：无可恢复结构，清台账避免永久悬挂。
    inputLedger.delete(key)
    await persistAppliedInputs()
  }

  /**
   * enabled 分支：先撤销已从 modelInput 移除的台账条目（清除某模型覆盖 =
   * 关闭开关的同一门控），再按 section 分组写入声明模态。pi-ai 写与 reasoning
   * 整节写共用 withPiAiWriteLock，deepseek 各自整节 replace。
   */
  async function applyModelInputs() {
    const cfg = configOf(NS)
    if (cfg === undefined || cfg.enabled !== true) return
    const modelInput = plainObjectOf(cfg.modelInput) ?? {}
    for (const key of [...inputLedger.keys()]) {
      if (Object.prototype.hasOwnProperty.call(modelInput, key)) continue
      await revertModelInput(key)
    }
    const piAiItems = []
    const deepseekGroups = new Map()
    for (const key of Object.keys(modelInput)) {
      const parsed = parseModelKey(key)
      if (parsed === undefined) continue
      const route = inputRouteOf(parsed.provider)
      if (route === undefined) continue
      const item = { key, provider: parsed.provider, model: parsed.model }
      if (route.kind === 'pi-ai') {
        piAiItems.push(item)
      } else {
        const list = deepseekGroups.get(route.ns) ?? []
        list.push(item)
        deepseekGroups.set(route.ns, list)
      }
    }
    if (piAiItems.length > 0) {
      await withPiAiWriteLock(() => applyInputsToSection(settingsNamespace(HOST_NAMESPACES.piAi), 'pi-ai', piAiItems))
    }
    for (const [ns, items] of deepseekGroups) await applyInputsToSection(ns, 'deepseek', items)
  }

  /** disabled 分支：撤销全部输入模态写回（逐模型过所有权门控）。 */
  async function revertModelInputs() {
    for (const key of [...inputLedger.keys()]) await revertModelInput(key)
  }

  /**
   * 关闭插件时还原全部 DeepSeek 系适配器（MAINT-041）：只还原「当前值仍是我们写的
   * 那个等级」的路由——用户手改过的值保持不动（所有权门控语义与路由默认一致）。
   */
  async function revertDeepseekRoutes() {
    for (const route of DEEPSEEK_ROUTES) {
      if (myDeepseekEffort[route.key] === undefined) continue
      let section
      try {
        section = configOf(settingsNamespace(route.ns))
      } catch (error) { continue }
      if (section === undefined || section.reasoningEffort !== myDeepseekEffort[route.key]) continue
      try {
        await restoreDeepseekDefault(route)
      } catch (error) {
        ctx.logger?.warn(`dsh-reasoning-level: revert ${route.ns} failed`)
        ctx.logger?.warn(error)
      }
    }
  }

  // MAINT-035：settingsUpdated 事件监听（candidates 全量注册）已随 settings
  // 注入回调迁移至文件尾——见 ctx.inject([...HOST_SERVICES.optionalInject]) 回调。

  // ── MAINT-042：0.2.2 原生 effort 选择面（步骤准备前）─────────────────────
  // 0.2.2 agent-loop 在 preStep() 读取 model.current() 之后才发 agent/request；
  // 瀑布里再改 effort 会被 L1000-1001 守卫拒绝并让整步失败（P0 兼容性缺陷）。
  // 正确窗口是 agent/status('running') 的同步监听（早于 preStep）+ 可选更早的
  // agent/created；能力判据只看真实方法存在，不解析版本号/payload 形状。
  let nativeSelectionSeen = false
  function nativeSelectionOf(agent) {
    try {
      const model = agent?.model
      if (model === null || typeof model !== 'object') return false
      return typeof model[HOST_AGENT_METHODS.current] === 'function'
        && typeof model[HOST_AGENT_METHODS.select] === 'function'
    } catch {
      return false
    }
  }
  function noteNativeSelection(agent) {
    if (nativeSelectionOf(agent)) nativeSelectionSeen = true
    return nativeSelectionSeen
  }
  function hostHasNativeAgentSelection() {
    if (nativeSelectionSeen) return true
    try {
      const agents = ctx.get(HOST_SERVICES.agentRegistry)?.list?.()
      if (Array.isArray(agents)) {
        for (const agent of agents) if (noteNativeSelection(agent)) return true
      }
    } catch {}
    return false
  }
  function isRootAgent(agent) {
    try {
      const registry = ctx.get(HOST_SERVICES.agentRegistry)
      const roots = registry?.roots?.()
      if (Array.isArray(roots)) return roots.includes(agent)
      const list = registry?.list?.()
      if (Array.isArray(list)) return list.includes(agent)
    } catch {}
    // 服务缺席（极简 profile / 单测桩）按 root 处理：root 只做首见对齐，
    // 不会每回合覆盖用户手选；比误判为子 agent 更安全。
    return true
  }
  function syncEffortsFor(provider, model) {
    const cached = effortsCache.get(provider + '/' + model)
    if (Array.isArray(cached) && cached.length > 0) return cached
    // DeepSeek 两代适配器的档位集合是固定契约（off/low/high/max）；不依赖
    // 设置节是否已可见，保证首个回合就能对齐。注意：这里**有意**不做
    // deepseekRouteOf 的「设置节已注册」门控——agent 能持有某 provider 的
    // 选择即说明该适配器已安装（能力来源是 agent 本身），与 supportedEfforts
    // 的「未安装不臆造能力」语义是两回事，勿相互"修复"。其他 provider 等
    // async resolve。
    if (DEEPSEEK_ROUTES.some((route) => route.provider === provider)) return DEEPSEEK_LEVELS.slice()
    return undefined
  }
  const effortEnforcer = createAgentEffortEnforcer({
    getConfig: () => configOf(NS),
    syncEfforts: syncEffortsFor,
    resolveEfforts: (provider, model) => supportedEfforts(provider, model),
    isRoot: isRootAgent,
    // REVIEW-MAINT-042-R0 F1：经验黑名单同样约束原生 select——声明档被网关
    // 拒绝过的 (provider, model, effort) 不再写进 agent 选择（拒绝即跳过，
    // 与 legacy 注入路径同一自愈语义）。
    isExcluded: (provider, model, effort) => isBlacklisted(provider, model, effort),
    listAgents: () => {
      try {
        const agents = ctx.get(HOST_SERVICES.agentRegistry)?.list?.()
        return Array.isArray(agents) ? agents : []
      } catch {
        return []
      }
    },
    logger: ctx.logger,
    onHealth: (patch) => {
      try { Object.assign(contractHealth.agentSelection, patch) } catch {}
    },
  })
  ctx.on(HOST_EVENTS.agentCreated, (payload) => {
    noteNativeSelection(payload?.agent)
    effortEnforcer.created(payload)
  })
  ctx.on(HOST_EVENTS.agentStatus, (payload) => {
    if (payload?.status !== 'running') return
    noteNativeSelection(payload?.agent)
    effortEnforcer.status(payload)
  })

  // ── P0-1 模型级默认注入（agent/request：loop 请求；llm/stream：未冻结手建调用）────
  ctx.on(HOST_EVENTS.agentRequest, async (payload, next) => {
    const config = await next()
    let current = config
    // FEAT-007（设计 §4.2 注入点 1）：采样参数注入独立于 reasoning 通道——
    // 0.2.2 原生选择在场只禁止改 reasoningEffort，temperature/maxTokens 仍可按
    // 「模型级 > 全局默认」填充；只填 undefined，调用方显式值优先。
    try {
      if (config !== null && typeof config === 'object' && config.probe !== true) {
        const cfg = configOf(NS)
        if (cfg !== undefined && cfg.enabled === true) current = withCallParams(config, cfg)
      }
    } catch (error) { /* 参数注入失败不影响请求 */ }
    try {
      // 0.2.2：effort 已在 agent/status/created 用 model.select() 固化，瀑布里
      // 再改会被 preStep 守卫拒绝。原生面在场时本条注入必须完全让路；0.2.1
      // （无 AgentModel）继续走下面的 legacy 模型级注入。
      if (hostHasNativeAgentSelection()) return current
      if (current.reasoningEffort !== undefined) return current
      const cfg = configOf(NS)
      if (cfg === undefined || cfg.enabled !== true) return current
      const perModel = (cfg.models ?? {})[current.provider + '/' + current.model]
      if (perModel === undefined) return current
      const efforts = await supportedEfforts(current.provider, current.model)
      if (efforts === undefined || efforts.length === 0) return current
      if (!efforts.includes(perModel)) return current
      if (isBlacklisted(current.provider, current.model, perModel)) return current
      return { ...current, reasoningEffort: perModel }
    } catch (error) {
      ctx.logger?.warn('dsh-reasoning-level: agent/request injection failed')
      ctx.logger?.warn(error)
      return current
    }
  })

  function isBlacklisted(provider, model, level) {
    const set = blacklist.get(provider + '/' + model)
    return set !== undefined && set.has(level)
  }

  // ── P0-2 自愈降级（agent/request-error 瀑布）──────────────────────────────
  ctx.on(HOST_EVENTS.agentRequestError, async (payload, next) => {
    try {
      const level = rejectionLevelOf(payload.failure)
      const model = payload.agent?.options?.model ?? ''
      if (level !== undefined && model !== '') markRejected(payload.provider, model, level)
    } catch (error) {
      ctx.logger?.warn('dsh-reasoning-level: request-error hook failed')
      ctx.logger?.warn(error)
    }
    return next()
  })

  // ── P1-1/P1-3 实时调用统计 + 持久化 + 未冻结注入（llm/stream waterfall）────
  const recent = [] // 新在前
  const perModelAgg = new Map() // 'provider/model' -> {calls, efforts, reasoningTokens, outputTokens, reasoningChars, durationMs, errors}
  let totalCalls = 0
  const statsSince = Date.now()
  let persistTimer = null
  let persistDirty = false
  // v0.6.0：零接缝解析 DSH 主目录；失败（或路径不可用）时 statsPath 为
  // undefined，持久化整体降级为内存态——统计照常收集，宿主零影响。
  const statsHome = resolveDshHomeSafe()
  const statsDir = statsHome !== undefined ? join(statsHome, 'storages') : undefined
  const statsPath = statsDir !== undefined ? join(statsDir, STATS_FILE) : undefined

  /**
   * FEAT-005（设计 §6.1/§10.4）：持久化快照的 per-level 桶规范化。
   * - 旧快照（v0.8.1 及以前）没有 byLevel 字段 → {}（升级首帧不得因缺字段报错）；
   * - 非对象/数组/坏值 → 同样降级为 {}（统计文件是自愈面，损坏不得影响 boot）；
   * - 只接受 calls 为正数的桶（与模型级 `calls > 0` 跳过语义一致），保证
   *   「Σ byLevel.calls === Σ efforts === calls」不变量不被脏数据破坏；
   * - 等级键原样保留（含非标准档）：快照出口再按受控键集合过滤。
   */
  function hydrateLevelBuckets(raw) {
    const byLevel = {}
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return byLevel
    for (const [levelKey, bucket] of Object.entries(raw)) {
      if (levelKey === '' || bucket === null || typeof bucket !== 'object' || Array.isArray(bucket)) continue
      if (typeof bucket.calls !== 'number' || !Number.isFinite(bucket.calls) || bucket.calls <= 0) continue
      const numberOrZero = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
      byLevel[levelKey] = {
        calls: bucket.calls,
        reasoningTokens: numberOrZero(bucket.reasoningTokens),
        outputTokens: numberOrZero(bucket.outputTokens),
        reasoningChars: numberOrZero(bucket.reasoningChars),
        durationMs: numberOrZero(bucket.durationMs),
        errors: numberOrZero(bucket.errors),
      }
    }
    return byLevel
  }

  // 启动时恢复持久化的聚合（无持久化能力时静默跳过）
  try {
    if (statsPath !== undefined && existsSync(statsPath)) {
      const saved = JSON.parse(readFileSync(statsPath, 'utf8'))
      if (saved && typeof saved === 'object' && saved.models !== undefined) {
        for (const [key, agg] of Object.entries(saved.models)) {
          if (typeof agg.calls !== 'number' || agg.calls <= 0) continue
          perModelAgg.set(key, {
            calls: agg.calls,
            efforts: { ...(agg.efforts ?? {}) },
            // FEAT-005：v0.9.0 前的快照无 byLevel → {}（历史调用没有 per-level 拆分）
            byLevel: hydrateLevelBuckets(agg.byLevel),
            reasoningTokens: agg.reasoningTokens ?? 0,
            outputTokens: agg.outputTokens ?? 0,
            reasoningChars: agg.reasoningChars ?? 0,
            durationMs: agg.durationMs ?? 0,
            errors: agg.errors ?? 0,
          })
        }
        if (typeof saved.totalCalls === 'number') totalCalls = saved.totalCalls
      }
    }
  } catch (error) {
    ctx.logger?.warn('dsh-reasoning-level: stats persistence load failed')
    ctx.logger?.warn(error)
  }

  function persistStats() {
    persistDirty = false
    if (statsDir === undefined) return
    try {
      const models = {}
      for (const [key, agg] of perModelAgg) {
        models[key] = {
          calls: agg.calls,
          efforts: agg.efforts,
          // FEAT-005（设计 §6.1）：per-level 聚合随快照落盘——升级后长跑数据不丢
          // per-level 拆分；byLevel 恒为对象（无样本时 {}），读取侧无需再判空。
          byLevel: agg.byLevel !== undefined && agg.byLevel !== null && typeof agg.byLevel === 'object' && !Array.isArray(agg.byLevel) ? agg.byLevel : {},
          reasoningTokens: agg.reasoningTokens,
          outputTokens: agg.outputTokens,
          reasoningChars: agg.reasoningChars,
          durationMs: agg.durationMs,
          errors: agg.errors,
        }
      }
      mkdirSync(statsDir, { recursive: true })
      writeFileSync(statsPath, JSON.stringify({ totalCalls, models }), 'utf8')
    } catch (error) {
      ctx.logger?.warn('dsh-reasoning-level: stats persistence write failed')
      ctx.logger?.warn(error)
    }
  }

  ctx.effect(() => () => {
    if (persistTimer !== null) clearTimeout(persistTimer)
    if (persistDirty) persistStats()
  }, 'dsh-reasoning-level: stats persistence cleanup')

  /**
   * 028-F3：为「(默认)」记账推导将物化的路由默认（RCA §2.2 假设 B / §4 F3(028)）。
   * llm/stream hook 入口捕获的 effort=null 只说明「调用未显式指定等级」——实际
   * wire 会由宿主 adapter 在插件 hook **之后**物化路由默认
   * （options.reasoningEffort ?? profile.reasoning，dsh-llm-pi-ai:1756）。
   * 本函数尽力推导该值供统计页复合标注「(默认→等级)」：
   * - provider 必须是 llm-pi-ai 路由且带 reasoning 默认；
   * - 模型支持面（effortsCache 运行期实测/目录解析，缺席时按能力声明推导）明确
   *   不含该默认时不标注——宿主会按模型能力调整/拒绝，不 over-claim 物化结果；
   * - 纯只读、全兜底：任何失败返回 undefined，绝不影响记账主路径。
   */
  function deriveDefaultedEffort(provider, model) {
    try {
      if (typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '') return undefined
      const piAi = configOf(settingsNamespace(HOST_NAMESPACES.piAi))
      const providers = piAi !== undefined && piAi !== null && typeof piAi.providers === 'object' && piAi.providers !== null
        ? piAi.providers
        : undefined
      const profile = providers !== undefined ? providers[provider] : undefined
      if (profile === undefined || profile === null || typeof profile !== 'object') return undefined
      if (typeof profile.reasoning !== 'string' || profile.reasoning === '') return undefined
      const routeDefault = profile.reasoning
      let supported = effortsCache.get(provider + '/' + model)
      if (!Array.isArray(supported)) {
        const entry = Array.isArray(profile.models)
          ? profile.models.find((m) => m !== null && typeof m === 'object' && m.id === model)
          : undefined
        const decl = entry !== undefined ? entry.reasoningEfforts : undefined
        supported = decl !== undefined ? supportedLevels(decl) : undefined
      }
      if (Array.isArray(supported) && supported.length > 0 && !supported.includes(routeDefault)) return undefined
      return routeDefault
    } catch (error) {
      return undefined
    }
  }

  function beginRecord(options) {
    totalCalls += 1
    const record = {
      t: Date.now(),
      provider: typeof options.provider === 'string' ? options.provider : '',
      model: typeof options.model === 'string' ? options.model : '',
      effort: typeof options.reasoningEffort === 'string' ? options.reasoningEffort : null,
      sessionId: typeof options.sessionId === 'string' ? options.sessionId : undefined,
      purpose: typeof options.purpose === 'string' ? options.purpose : undefined,
      rt: null, // reasoningTokens（网关回报时）
      rc: null, // 流内 reasoning-delta 字符数近似
      ot: null, // outputTokens
      it: null, // inputTokens
      duration: null,
      finish: null,
    }
    // 028-F3：(默认) 记账语义——入口无显式等级时「另记」推导出的将物化路由默认
    // （effort 仍为 null，聚合「(默认)」桶与持久化统计兼容性不变；defaulted 仅作
    // 展示层复合标注数据源，推导失败静默缺省）。
    if (record.effort === null) {
      const defaulted = deriveDefaultedEffort(record.provider, record.model)
      if (defaulted !== undefined) record.defaulted = defaulted
    }
    recent.unshift(record)
    if (recent.length > STATS_LIMIT) recent.length = STATS_LIMIT
    return record
  }

  function settleRecord(record) {
    const key = record.provider + '/' + record.model
    let agg = perModelAgg.get(key)
    if (agg === undefined) {
      agg = { calls: 0, efforts: {}, byLevel: {}, reasoningTokens: 0, outputTokens: 0, reasoningChars: 0, durationMs: 0, errors: 0 }
      perModelAgg.set(key, agg)
    }
    agg.calls += 1
    const effortKey = record.effort ?? '(默认)'
    agg.efforts[effortKey] = (agg.efforts[effortKey] ?? 0) + 1
    // FEAT-005（设计 §6.1）：与 efforts 同键的 per-level 桶——两处 add 点必须同一
    // effortKey，保证「Σ byLevel.calls === Σ efforts === agg.calls」不变量。
    if (agg.byLevel === undefined || agg.byLevel === null || typeof agg.byLevel !== 'object' || Array.isArray(agg.byLevel)) agg.byLevel = {}
    const bucket = agg.byLevel[effortKey] ?? (agg.byLevel[effortKey] = { calls: 0, reasoningTokens: 0, outputTokens: 0, reasoningChars: 0, durationMs: 0, errors: 0 })
    bucket.calls += 1
    if (record.rt !== null) bucket.reasoningTokens += record.rt
    if (record.rc !== null) bucket.reasoningChars += record.rc
    if (record.ot !== null) bucket.outputTokens += record.ot
    if (record.duration !== null) bucket.durationMs += record.duration
    if (record.finish === 'error' || record.finish === 'aborted') bucket.errors += 1
    if (record.rt !== null) agg.reasoningTokens += record.rt
    if (record.rc !== null) agg.reasoningChars += record.rc
    if (record.ot !== null) agg.outputTokens += record.ot
    if (record.duration !== null) agg.durationMs += record.duration
    if (record.finish === 'error' || record.finish === 'aborted') agg.errors += 1
    persistDirty = true
    if (persistTimer === null) {
      persistTimer = setTimeout(() => {
        persistTimer = null
        if (persistDirty) persistStats()
      }, STATS_PERSIST_INTERVAL_MS)
    }
  }

  ctx.on(HOST_EVENTS.llmStream, (options, next) => {
    // 探测请求（一键探测 / 实测按钮发的 1-token ping）：不注入、不统计，
    // 完全不进入观测数据（probe 标记由本插件的探测路径设置）。
    if (options !== undefined && options.probe === true) return next()
    // P0-1：未冻结请求（router 子代理 / session-title / compaction 等手建调用）
    // 直接注入模型级默认；冻结的 loop 请求由 agent/request 注入，此处只读。
    // FEAT-007（设计 §4.2 注入点 2）：未冻结 options 同样只填 undefined 的
    // temperature/maxTokens（probe/冻结/显式值均跳过；topP/topK 永不注入）。
    try {
      if (!Object.isFrozen(options) && options !== null && typeof options === 'object') {
        const cfg = configOf(NS)
        if (cfg !== undefined && cfg.enabled === true) {
          if (options.probe !== true) writeCallParamsInto(options, cfg)
          if (typeof options.reasoningEffort !== 'string') {
            // purpose 级默认优先（compaction / session-title 可独立设置，如 off 省 token）
            const purposeLevel = typeof options.purpose === 'string' ? (cfg.purposes ?? {})[options.purpose] : undefined
            let target = purposeLevel
            if (target === undefined) target = (cfg.models ?? {})[options.provider + '/' + options.model]
            if (target !== undefined) {
              const efforts = effortsCache.get(options.provider + '/' + options.model)
              if (efforts !== undefined && efforts.length > 0 && efforts.includes(target) && !isBlacklisted(options.provider, options.model, target)) {
                options.reasoningEffort = target
              }
            }
          }
        }
      }
    } catch (error) { /* 注入失败不影响请求 */ }

    // v0.6.0：统计记录可空——创建失败时旁路完全静默，请求路径语义不变。
    let record = null
    try {
      record = beginRecord(options)
    } catch (error) { record = null }
    const stream = next()
    return (async function* () {
      try {
        for await (const chunk of stream) {
          try {
            if (record !== null && chunk.type === 'usage' && chunk.usage !== undefined) {
              if (typeof chunk.usage.reasoningTokens === 'number') record.rt = chunk.usage.reasoningTokens
              if (typeof chunk.usage.outputTokens === 'number') record.ot = chunk.usage.outputTokens
              if (typeof chunk.usage.inputTokens === 'number') record.it = chunk.usage.inputTokens
            } else if (record !== null && chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
              record.rc = (record.rc ?? 0) + chunk.text.length
            } else if (record !== null && chunk.type === 'finish' && chunk.reason !== undefined) {
              record.finish = typeof chunk.reason.kind === 'string' ? chunk.reason.kind : null
              record.duration = Date.now() - record.t
              // P0-2：流内错误也记黑名单（覆盖 router 等手建调用）
              if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
                const failure = chunk.reason.failure
                if (failure !== undefined) {
                  const level = rejectionLevelOf(failure)
                  if (level !== undefined) markRejected(record.provider, record.model, level)
                }
              }
              settleRecord(record)
            }
          } catch (error) { /* 统计解析失败不影响转发 */ }
          yield chunk
        }
      } finally {
        if (record !== null && record.finish === null) {
          record.finish = 'aborted'
          record.duration = Date.now() - record.t
          settleRecord(record)
        }
      }
    })()
  })

  /**
   * FEAT-005（设计 §6.1）：stats wire 的 per-level 出口——只透出受控等级键
   * （LEVELS + '(默认)'），未知键丢弃。等级键来自 record.effort，而探测候选
   * 可含词表外自定义档（MAINT-014 的 qwen custom/ultra 类）——那些桶保留在
   * 内部聚合/落盘里，但不得随 wire 外溢成客户端无法解释的脏键。字段逐个重建
   * （数值兜底 0），调用方拿到的是与内部状态解耦的快照。
   */
  function snapshotLevelBuckets(raw) {
    const byLevel = {}
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return byLevel
    const numberOrZero = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
    for (const levelKey of LEVEL_KEYS_CONTROLLED) {
      const bucket = raw[levelKey]
      if (bucket === null || typeof bucket !== 'object' || Array.isArray(bucket)) continue
      byLevel[levelKey] = {
        calls: numberOrZero(bucket.calls),
        reasoningTokens: numberOrZero(bucket.reasoningTokens),
        outputTokens: numberOrZero(bucket.outputTokens),
        reasoningChars: numberOrZero(bucket.reasoningChars),
        durationMs: numberOrZero(bucket.durationMs),
        errors: numberOrZero(bucket.errors),
      }
    }
    return byLevel
  }

  function statsSnapshot() {
    const models = {}
    for (const [key, agg] of perModelAgg) {
      const [provider, model] = key.split('/')
      // 推荐建议：错误率高时降档；实测黑名单中的最高可用档
      const black = blacklist.get(key)
      const rejected = black !== undefined ? [...black] : []
      const rejectedSet = new Set(rejected)
      const usedEfforts = Object.keys(agg.efforts ?? {})
      const highestUsed = usedEfforts.filter((e) => e !== '(默认)').sort((a, b) => rank(b) - rank(a))[0]
      const errRate = agg.calls > 0 ? Math.round((agg.errors / agg.calls) * 100) : 0
      // R0-P2-4（UX-002/FEAT-004「en 全量」）：建议文案改由服务端只下发结构化字段
      // （suggestionKind + suggestionParams），客户端按语言渲染；旧字段 suggestion
      // 保留（旧客户端继续可用，红线：只加不删）。枚举与优先级和旧文案完全同源：
      // 错误率 ≥20% → high-error-rate；否则实测黑名单非空 → rejected-levels。
      const suggestionKind = errRate >= 20 ? 'high-error-rate' : (rejected.length > 0 ? 'rejected-levels' : undefined)
      let suggestion
      let suggestionParams
      if (suggestionKind === 'high-error-rate') {
        suggestionParams = { errorRate: errRate }
        suggestion = `错误率 ${errRate}% 偏高，建议降低等级`
      } else if (suggestionKind === 'rejected-levels') {
        // highest = 实测使用过的最高档；null 表示没有显式等级（客户端渲染「(默认)」）。
        suggestionParams = { rejected: rejected.slice(), highest: highestUsed ?? null }
        suggestion = `实测拒绝 ${rejected.join('/')}，建议用最高档 ${highestUsed ?? '（默认）'}`
      }
      models[key] = {
        calls: agg.calls,
        efforts: agg.efforts,
        // FEAT-005：per-level 聚合（受控键集合；旧聚合无该字段时输出 {}）
        byLevel: snapshotLevelBuckets(agg.byLevel),
        reasoningTokens: agg.reasoningTokens,
        outputTokens: agg.outputTokens,
        reasoningChars: agg.reasoningChars,
        durationMs: agg.durationMs,
        errors: agg.errors,
        errRate,
        rejected,
        highestUsed,
        suggestion,
        suggestionKind,
        suggestionParams,
        _provider: provider,
        _model: model,
      }
    }
    const black = {}
    for (const [key, set] of blacklist) black[key] = [...set]
    // 027-F3：带回最近一次探测的持久化结果（客户端挂载回显数据源；缺席 = 从未探测）
    let lastProbe
    try {
      const cfg = configOf(NS)
      lastProbe = cfg !== undefined && cfg.lastProbe !== undefined ? clone(cfg.lastProbe) : undefined
    } catch (error) { lastProbe = undefined }
    // MAINT-036：契约自检结果随 stats 下发（向后兼容新增字段）——settings 服务
    // 缺席（可选注入未触发）时如实降级，客户端页顶告警条消费。
    // MAINT-042（REVIEW R0 F4）：agentSelection 能力态一并投影——升级断接
    // （mode 停在 unknown/legacy 或 lastError 非空）在 stats 面第一时间可见。
    const health = settings === undefined
      ? { ok: false, missing: ['settings service（可选注入未就绪）'], checkedAt: contractHealth.checkedAt, agentSelection: { ...contractHealth.agentSelection } }
      : { ok: contractHealth.ok, missing: [...contractHealth.missing], checkedAt: contractHealth.checkedAt, agentSelection: { ...contractHealth.agentSelection } }
    return { since: statsSince, totalCalls, models, recent: recent.slice(0, 100), blacklist: black, lastProbe, contractHealth: health }
  }

  function rank(level) {
    const i = LEVELS.indexOf(level)
    return i < 0 ? -1 : i
  }

  /**
   * 统计端点访问控制：默认仅回环 Host；statsPublic 时放行。
   * DEF-001：旧实现 host.split(':')[0] 无法识别 IPv6（'[::1]' 得 '['、裸 '::1' 得 '')。
   * 现按 WHATWG URL 归一化（'http://' + host）后解析 hostname：跨端口与 IPv6
   * 括号均正确剥离；未加括号的裸 IPv6（URL 解析抛错）回退为剥括号后比较。
   * D1：URL 解析会吞没 userinfo/path/fragment（'x@127.0.0.1'、'127.0.0.1/x'、
   * '127.0.0.1#y' 归一化后均为 127.0.0.1）——解析前先做合法 Host 字符集预检
   * （已 toLowerCase 的字母数字与 '.' ':' '[' ']' '-' 之外一律拒绝），保证
   * statsPublic=false 的"LAN 不可见"边界不被纯字符形态绕过。
   */
  function isLoopbackHost(req) {
    const host = (req.headers?.host ?? '').toLowerCase()
    if (host === '' || host === 'localhost') return true
    if (/[^a-z0-9.:[\]-]/.test(host)) return false
    let hostname
    try {
      hostname = new URL('http://' + host).hostname.replace(/^\[|\]$/g, '')
    } catch (error) {
      hostname = host.replace(/^\[([^\]]*)\]$/, '$1')
    }
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
  }

  // ── FEAT-007：模型信息端点快照（设计 §6，只读）──────────────────────────────
  // 60s 内存缓存 + 并发合并：listProviders/listModels/resolveModelInfo 是宿主侧
  // 目录查询（逐路由/逐模型），工作台每次挂载/切页都会读，不缓存会把翻页变成
  // 宿主枚举风暴；并发请求共享同一在途快照（否则同一帧内多个读各自枚举）。
  let modelsCache      // { at, payload }
  let modelsInFlight   // Promise<payload>（并发合并；落定后清空）
  let modelsCacheGeneration = 0 // 失效代数：在途构建落定时据此拒绝写回过期快照
  /** 设置面任何变更都失效模型快照（用户改配置后工作台立即看到新值）。 */
  function invalidateModelsCache() {
    modelsCache = undefined
    modelsCacheGeneration += 1
  }

  /** 路由类型：deepseek 系按设置节可见性判定（适配器管辖），pi-ai 按原始节 providers，其余 unknown。 */
  function routeKindOf(provider) {
    try {
      const deepseekRoute = DEEPSEEK_ROUTES.find((item) => item.provider === provider)
      if (deepseekRoute !== undefined) {
        return configOf(settingsNamespace(deepseekRoute.ns)) !== undefined ? 'deepseek' : 'unknown'
      }
      const raw = rawSection(HOST_NAMESPACES.piAi)
      const providers = raw !== undefined ? plainObjectOf(raw.providers) : undefined
      if (providers !== undefined && providers[provider] !== undefined) return 'pi-ai'
      return 'unknown'
    } catch (error) {
      return 'unknown'
    }
  }

  /** 模态注册表投影（与参数投影同一服务端事实源语义）。 */
  function modalityProjection() {
    return MODALITIES.map((entry) => ({
      id: entry.id,
      label: { zh: entry.label?.zh ?? '', en: entry.label?.en ?? '' },
      required: entry.required === true,
    }))
  }

  /**
   * 单个模型的响应行（设计 §6 models[]）：能力三态 declared/effective/source、
   * 思考面、上下文、当前插件覆盖。解析失败只降级为「目录值 + 空思考面」，
   * 绝不伪造能力。
   */
  function projectModelRow({ cfg, provider, kind, entry, info }) {
    const key = provider + '/' + entry.id
    const infoDeclared = info !== undefined && info !== null && Array.isArray(info.inputModalities)
      ? clone(info.inputModalities)
      : undefined
    const catalogDeclared = Array.isArray(entry.inputModalities) ? clone(entry.inputModalities) : undefined
    const declared = infoDeclared ?? catalogDeclared ?? []
    const modelInput = cfg !== undefined ? plainObjectOf(cfg.modelInput) : undefined
    const configuredRaw = modelInput !== undefined ? modelInput[key] : undefined
    const configuredInput = configuredRaw !== undefined ? normalizeInput(configuredRaw) : undefined
    const effective = configuredInput !== undefined ? configuredInput : (declared.length > 0 ? declared : ['text'])
    const source = configuredInput !== undefined ? 'config' : (declared.length > 0 ? 'catalog' : 'default')
    const reasoning = info !== undefined && info !== null && info.reasoning !== undefined && info.reasoning !== null && Array.isArray(info.reasoning.efforts)
      ? {
        efforts: info.reasoning.efforts
          .map((effort) => (effort !== null && typeof effort === 'object' && typeof effort.id === 'string' ? effort.id : undefined))
          .filter((id) => id !== undefined),
        defaultEffort: typeof info.reasoning.defaultEffort === 'string' ? info.reasoning.defaultEffort : null,
      }
      : { efforts: [], defaultEffort: null }
    const configuredModels = cfg !== undefined ? plainObjectOf(cfg.models) : undefined
    const reasoningEffort = configuredModels !== undefined && typeof configuredModels[key] === 'string' ? configuredModels[key] : null
    return {
      provider,
      model: entry.id,
      name: typeof entry.name === 'string' && entry.name !== ''
        ? entry.name
        : (info !== undefined && info !== null && typeof info.name === 'string' ? info.name : entry.id),
      kind,
      input: { declared, effective, source },
      reasoning,
      contextWindow: info !== undefined && info !== null && info.context !== undefined && info.context !== null && typeof info.context.contextWindow === 'number'
        ? info.context.contextWindow
        : null,
      maxTokens: info !== undefined && info !== null && typeof info.defaultMaxTokens === 'number' ? info.defaultMaxTokens : null,
      configured: {
        reasoningEffort,
        input: configuredInput !== undefined ? clone(configuredInput) : null,
        params: effectiveParamsFor(cfg, provider, entry.id),
      },
    }
  }

  /** 构建响应快照：任何单路由/单模型失败只降级该点（不整体 500）。 */
  async function buildModelsPayload() {
    const cfg = configOf(NS)
    const missing = []
    const addMissing = (label) => { if (!missing.includes(label)) missing.push(label) }
    const hasListProviders = typeof llm[HOST_LLM_METHODS.listProviders] === 'function'
    const hasListModels = typeof llm[HOST_LLM_METHODS.listModels] === 'function'
    const hasResolve = typeof llm[HOST_LLM_METHODS.resolveModelInfo] === 'function'
    if (!hasListProviders) addMissing('llm.' + HOST_LLM_METHODS.listProviders)
    if (!hasListModels) addMissing('llm.' + HOST_LLM_METHODS.listModels)
    if (!hasResolve) addMissing('llm.' + HOST_LLM_METHODS.resolveModelInfo)
    let providers = []
    if (hasListProviders) {
      try {
        const listed = await llm[HOST_LLM_METHODS.listProviders]()
        if (Array.isArray(listed)) providers = listed
      } catch (error) {
        providers = []
        ctx.logger?.warn('dsh-reasoning-level: llm.listProviders failed — models endpoint degraded')
      }
    }
    const routes = []
    const models = []
    for (const rawRoute of providers) {
      if (rawRoute === null || typeof rawRoute !== 'object') continue
      const provider = typeof rawRoute.id === 'string' && rawRoute.id !== ''
        ? rawRoute.id
        : (typeof rawRoute.provider === 'string' ? rawRoute.provider : '')
      if (provider === '') continue
      const name = typeof rawRoute.name === 'string' && rawRoute.name !== '' ? rawRoute.name : provider
      const kind = routeKindOf(provider)
      routes.push({ provider, name, kind })
      let catalog = []
      if (hasListModels) {
        try {
          const listed = await llm[HOST_LLM_METHODS.listModels](provider)
          if (Array.isArray(listed)) catalog = listed
        } catch (error) {
          catalog = []
        }
      }
      for (const entry of catalog) {
        if (entry === null || typeof entry !== 'object' || typeof entry.id !== 'string' || entry.id === '') continue
        let info
        if (hasResolve) {
          try {
            info = await llm[HOST_LLM_METHODS.resolveModelInfo](provider, entry.id)
          } catch (error) {
            info = undefined
          }
        }
        models.push(projectModelRow({ cfg, provider, kind, entry, info }))
      }
    }
    const missingAll = [...contractHealth.missing]
    for (const label of missing) if (!missingAll.includes(label)) missingAll.push(label)
    return {
      version: 1,
      generatedAt: Date.now(),
      routes,
      models,
      params: projectRegistry(),
      modalities: modalityProjection(),
      contractHealth: { ok: contractHealth.ok === true && missingAll.length === 0, missing: missingAll },
    }
  }

  /** 缓存 + 并发合并（设计 §6：60s 缓存、并发请求合并、单点失败不 500）。 */
  async function modelsSnapshot() {
    if (modelsCache !== undefined && Date.now() - modelsCache.at < MODELS_CACHE_TTL_MS) return modelsCache.payload
    if (modelsInFlight !== undefined) return modelsInFlight
    const generation = modelsCacheGeneration
    let run
    run = (async () => {
      try {
        const payload = await buildModelsPayload()
        // 构建期间设置面变更（invalidate）→ 不得把过期快照写回缓存；
        // 当前调用方仍拿到自己的结果，下一次读取重建。
        if (generation === modelsCacheGeneration) modelsCache = { at: Date.now(), payload }
        return payload
      } finally {
        if (modelsInFlight === run) modelsInFlight = undefined
      }
    })()
    modelsInFlight = run
    return run
  }

  /** 兜底快照：构建期出现未预期异常时仍返回可解析 JSON（端点只读、绝不 500）。 */
  function degradedModelsPayload() {
    const missing = [...contractHealth.missing, 'model catalog']
    return {
      version: 1,
      generatedAt: Date.now(),
      routes: [],
      models: [],
      params: projectRegistry(),
      modalities: modalityProjection(),
      contractHealth: { ok: false, missing },
    }
  }

  /**
   * 挂载统计 + 测试/探测/固化请求端点（可选服务：无 webServer 的部署跳过，统计仍
   * 在收集）。注册失败（如迁移期旧行未清导致重复路由）只降级端点，不影响其余功能。
   *
   * RCA 2026-10-20（0.2.x 代序服务晚到）：本函数不再在 apply 期调用，而是由
   * webServer 服务的注入回调在服务就绪后调用（见下方挂载入口）——cordis 4 的
   * ctx.get(name, strict=true) 在提供方 fiber 未 ACTIVE 时返回 undefined，而 DSH
   * 0.2.x 代序中 webServer 常在 profile 行插件 apply 之后才挂载，旧实现因此整块
   * 静默跳过（四端点 404、无任何日志）。
   *
   * @param scope 注入子 ctx（提供 effect——路由注册一律挂 scope.effect，使路由
   *              生命周期跟随 webServer 服务的激活/重启自动销毁重建）
   * @param webServer 已就绪的 webServer 服务实例
   */
  function mountHttpEndpoints(scope, webServer) {
    scope.effect(() => {
      try {
        return webServer.register({
          kind: 'exact',
          path: STATS_PATH,
          handler: (req, res) => {
            // 访问控制：statsPublic=false 时仅回环 Host 可读；LAN 部署需显式开启。
            const cfg = configOf(NS)
            const publicOk = cfg !== undefined && cfg.statsPublic === true
            if (!publicOk && !isLoopbackHost(req)) {
              res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
              res.end('forbidden: stats endpoint is loopback-only (set llm-reasoning.statsPublic: true to expose)')
              return
            }
            const body = JSON.stringify(statsSnapshot())
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(body)
          },
        })
      } catch (error) {
        ctx.logger?.warn(`dsh-reasoning-level: stats route registration failed (${STATS_PATH}) — duplicate route 或宿主注册面变化；stats endpoint disabled`)
        ctx.logger?.warn(error)
        return () => {}
      }
    }, 'dsh-reasoning-level: stats route')

    // FEAT-007（设计 §6）：只读模型信息端点——工作台「模型」视图的数据源。
    // 回环门控与 stats 同口径（statsPublic=true 才放行非回环 Host）；任何异常
    // 降级为可解析空快照，绝不把端点变成 500（UI 依赖它渲染，500 会让整页空白）。
    scope.effect(() => {
      try {
        return webServer.register({
          kind: 'exact',
          path: MODELS_PATH,
          handler: (req, res) => {
            const cfg = configOf(NS)
            const publicOk = cfg !== undefined && cfg.statsPublic === true
            if (!publicOk && !isLoopbackHost(req)) {
              res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
              res.end('forbidden: models endpoint is loopback-only (set llm-reasoning.statsPublic: true to expose)')
              return
            }
            modelsSnapshot().then((payload) => {
              res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
              res.end(JSON.stringify(payload))
            }).catch((error) => {
              ctx.logger?.warn('dsh-reasoning-level: models endpoint degraded')
              ctx.logger?.warn(error)
              try {
                res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
                res.end(JSON.stringify(degradedModelsPayload()))
              } catch (error2) { /* 连接已关闭：端点只读，忽略 */ }
            })
          },
        })
      } catch (error) {
        ctx.logger?.warn(`dsh-reasoning-level: models route registration failed (${MODELS_PATH}) — duplicate route 或宿主注册面变化；models endpoint disabled`)
        ctx.logger?.warn(error)
        return () => {}
      }
    }, 'dsh-reasoning-level: models route')

    // ── 探测（实测）基础设施 ──────────────────────────────────────────────────
    // v0.7.0 核心修复：DSH 的 Message.content 必须是 ContentBlock 数组
    // （[{type:'text', text}]）。旧版发 `content: 'ping'` 字符串，适配器在
    // 组装阶段就抛 `content.some is not a function` —— 无论模型是否支持，
    // 每个等级都"失败"。这是"探测全部显示失败"的根因。
    const PROBE_MESSAGES = [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }]

    /** 单次实测：1-token 请求验证某 provider/model 某等级；`probe: true` 标记使统计旁路。
     *  @param {number} [timeoutMs] - 可选超时覆盖；缺省使用 PROBE_TIMEOUT_MS。 */
    async function probeLevelOnce(provider, model, effort, timeoutMs = PROBE_TIMEOUT_MS) {
      const started = Date.now()
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const stream = llm.stream({
          provider,
          model,
          ...(effort === undefined ? {} : { reasoningEffort: effort }),
          messages: PROBE_MESSAGES,
          maxTokens: 1,
          signal: controller.signal,
          probe: true,
        })
        let finish = null
        for await (const chunk of stream) {
          if (chunk.type === 'finish') { finish = chunk.reason; break }
        }
        const kind = finish !== null && finish !== undefined && typeof finish.kind === 'string' ? finish.kind : 'unknown'
        const failure = finish !== null && finish !== undefined ? finish.failure : null
        const ok = kind === 'stop' || kind === 'max-tokens' || kind === 'tool-calls'
        return {
          ok,
          kind,
          code: failure !== null && failure !== undefined ? failure.code : undefined,
          message: failure !== null && failure !== undefined ? failure.message : undefined,
          durationMs: Date.now() - started,
        }
      } catch (error) {
        return {
          ok: false,
          kind: 'thrown',
          code: error !== null && error !== undefined ? error.code : undefined,
          message: error !== null && error !== undefined && error.message !== undefined ? error.message : String(error),
          durationMs: Date.now() - started,
        }
      } finally {
        clearTimeout(timer)
      }
    }

    /** 从 llm-pi-ai 原始 user 节读取某模型声明的能力表（无则 undefined）。 */
    function declaredEffortsOf(provider, model) {
      try {
        const raw = rawSection(HOST_NAMESPACES.piAi)
        const profile = raw !== undefined && raw.providers !== undefined ? raw.providers[provider] : undefined
        if (profile === undefined || !Array.isArray(profile.models)) return undefined
        const entry = profile.models.find((entry) => entry.id === model)
        return entry !== undefined ? entry.reasoningEfforts : undefined
      } catch (error) { return undefined }
    }

    /** 探测目标是否在 llm-pi-ai 用户配置内（027-F1/027-F4：越界目标结局显式化）。 */
    function piAiModelEntry(provider, model) {
      try {
        const raw = rawSection(HOST_NAMESPACES.piAi)
        const profile = raw !== undefined && raw.providers !== undefined ? raw.providers[provider] : undefined
        if (profile === undefined || !Array.isArray(profile.models)) return undefined
        return profile.models.find((entry) => entry.id === model)
      } catch (error) { return undefined }
    }

    /**
     * 027-F1：一次探测的持久化结局（RCA §4 F1(027) 枚举 + 诚实补充项）。
     * - converged：探测收敛已把 working 集写入能力声明；
     * - no-change-already-correct：声明已与实测一致，无需改动；
     * - pending-apply：声明与实测不一致且探测阶段未改（待 /probe/apply 固化）；
     * - skipped:not-in-pi-ai-config：目标不在 llm-pi-ai 用户配置且不归官方适配器管辖——
     *   结果仅展示，未写入；
     * - skipped:official-adapter（FEAT-004 ⑦ / 设计 §10.1）：目标由宿主官方
     *   DeepSeek 适配器管辖——等级经官方通道下发，无需（也不应）写模型能力声明；
     * - skipped:no-working：无可用等级可固化（原声明保留/回滚）；
     * - persist-error：写入失败（converge replace 失败）。
     *
     * MAINT-019（P2-3）：filtered 探测（levelsFilter 非空）跳过收敛写回——临时声明
     * 回滚为原声明，声明未被固化 → 结局同 pending-apply（等待显式 /probe/apply）。
     * 不得落入 persist-error 兜底：回滚成功是正常结局而非失败。
     *
     * `skipped:official-adapter` 判据（三条同时成立，全部可判定——不是文案猜测）：
     *  1. 目标不在 llm-pi-ai 用户配置内（inConfig === false，调用方给定事实）；
     *  2. provider 是宿主官方 DeepSeek 适配器独占的路由 id `deepseek-official`：
     *     该常量定义在 @deepseek-ai/dsh-llm-deepseek-api-key lib/index.js
     *     `const PROVIDER = "deepseek-official"`，并以
     *     `llm.registerAdapter([PROVIDER], adapter)` 独占注册该路由
     *     （dsh-llm prepareRoutes 对重复 provider 抛 DUPLICATE_ADAPTER——
     *     provider 与适配器一一对应，故该 id 即官方适配器管辖权凭据）；
     *  3. 官方适配器的设置节 llm-deepseek 已注册（describe 描述符 value 非
     *     undefined）——证明宿主确实安装并接线了该适配器（其 settingsNs =
     *     profile entry id `llm-deepseek`），而不是只存在一个同名孤儿 provider id。
     *
     * 三条成立 ⇒ 该模型的能力声明不归 llm-pi-ai 管，等级经
     * llm-deepseek.reasoningEffort 下发（applyDeepseekRoute 同一口径），因此不得报成
     * 「不在 llm-pi-ai 配置——仅展示，未写入」（会误导用户去模型配置里添加一个
     * 本就不该存在的声明）。
     *
     * MAINT-041（2026-10-22）：账号版适配器同理——路由 id `deepseek-account`、设置节
     * `llm-deepseek-account`（出处 @deepseek-ai/dsh-llm-deepseek-account 0.2.1-rc.2
     * README.zh.md）。此前它被误报成「由其他适配器提供」，用户以为是第三方插件。
     */
    const OFFICIAL_ADAPTER_NAMESPACES = Object.freeze({
      'deepseek-official': HOST_NAMESPACES.deepseek,
      'deepseek-account': HOST_NAMESPACES.deepseekAccount,
    })
    function officialAdapterOwns(provider) {
      if (typeof provider !== 'string') return false
      const ns = OFFICIAL_ADAPTER_NAMESPACES[provider]
      if (ns === undefined) return false
      try {
        return configOf(settingsNamespace(ns)) !== undefined
      } catch (error) {
        return false
      }
    }

    function probePersistedOutcome(inConfig, working, tempDeclWritten, declared, convergeResult, officialAdapter = false) {
      // 官方适配器直辖的模型不在 llm-pi-ai 配置属正常态（设计 §10.1 三态之一）
      if (!inConfig) return officialAdapter === true ? 'skipped:official-adapter' : 'skipped:not-in-pi-ai-config'
      if (working.length === 0) return 'skipped:no-working'
      if (tempDeclWritten) {
        if (convergeResult === undefined) return 'pending-apply'
        if (convergeResult.skipped === 'no-change') return 'no-change-already-correct'
        if (convergeResult.writes === 1) return 'converged'
        if (convergeResult.skipped === 'filtered-no-converge') return 'pending-apply'
        if (convergeResult.skipped === 'replace-failed') return 'persist-error'
        if (convergeResult.skipped === 'no-pi-ai-section' || convergeResult.skipped === 'no-models-entry' || convergeResult.skipped === 'model-not-in-pi-ai-config') return 'skipped:not-in-pi-ai-config'
        return 'persist-error'
      }
      // 无临时声明（声明已覆盖候选集）：比对当前声明与实测集
      const declaredKeys = declared !== undefined ? Object.keys(declared).sort().join(',') : ''
      const workingKeys = working.slice().sort().join(',')
      return declaredKeys === workingKeys ? 'no-change-already-correct' : 'pending-apply'
    }

    /**
     * 探测单个模型后收敛声明：根据原始声明的性质（手写/生成/未声明）
     * 把 working 集写入正式声明。
     *
     * @param {string} provider
     * @param {string} model
     * @param {object|undefined} originalDecl - 探测前的原始 reasoningEfforts（clone）
     * @param {string|undefined} thinkingFormat - 路由的 thinking 格式
     * @param {string[]} working - 实测可用的等级列表
     * @returns {Promise<{writes: number, skipped?: string}>}
     */
    async function convergeProbeDeclaration(provider, model, originalDecl, thinkingFormat, working) {
      // 整节写串行化：fresh 读（含 F1 回滚）全程持锁，不得与 applyPiAi 或其他收敛交错。
      return withPiAiWriteLock(() => convergeProbeDeclarationCore(provider, model, originalDecl, thinkingFormat, working))
    }

    async function convergeProbeDeclarationCore(provider, model, originalDecl, thinkingFormat, working) {
      const raw = rawSection(HOST_NAMESPACES.piAi)
      if (raw === undefined) return { writes: 0, skipped: 'no-pi-ai-section' }
      const target = clone(raw)
      const profile = target.providers !== undefined ? target.providers[provider] : undefined
      if (profile === undefined || !Array.isArray(profile.models)) return { writes: 0, skipped: 'no-models-entry' }
      const entry = profile.models.find((e) => e.id === model)
      if (entry === undefined) return { writes: 0, skipped: 'model-not-in-pi-ai-config' }

      if (working.length === 0) {
        // 无可用等级：恢复原声明（或留空）
        if (originalDecl !== undefined) entry.reasoningEfforts = clone(originalDecl)
        else delete entry.reasoningEfforts
      } else {
        const current = entry.reasoningEfforts
        const actualOriginal = originalDecl !== undefined ? originalDecl : current

        if (actualOriginal !== undefined && !isGeneratedEfforts(actualOriginal, thinkingFormat) &&
            !deepEq(actualOriginal, buildFullVocabDeclaration(thinkingFormat))) {
          // ── 手写声明：并入（保留用户档位与 wire，追加 working 集里的新档位）──
          const merged = clone(actualOriginal)
          for (const level of working) {
            if (merged[level] === undefined) {
              merged[level] = wireForLevel(level, thinkingFormat)
            }
          }
          entry.reasoningEfforts = merged
        } else {
          // ── 生成声明/未声明：替换为 working 集 ──
          const verified = {}
          for (const level of working) {
            verified[level] = wireForLevel(level, thinkingFormat)
          }
          if (Object.keys(verified).length === 0) {
            if (originalDecl !== undefined) entry.reasoningEfforts = clone(originalDecl)
            else delete entry.reasoningEfforts
          } else {
            entry.reasoningEfforts = verified
          }
        }
      }

      if (!deepEq(target, raw)) {
        try {
          await replaceSettings(settingsNamespace(HOST_NAMESPACES.piAi),target)
          // 更新内存台账并持久化 probeEfforts
          if (entry.reasoningEfforts !== undefined) {
            const finalDecl = clone(entry.reasoningEfforts)
            verifiedEfforts.set(provider + '\u0000' + model, finalDecl)
            persistProbeEfforts({ [provider + '/' + model]: finalDecl })
          }
          return { writes: 1 }
        } catch (error) {
          ctx.logger?.warn('dsh-reasoning-level: converge declaration replace failed')
          ctx.logger?.warn(error)
          // MAINT-017 R1（F1）：探测窗口写过临时全量声明时，converge replace 失败
          // 不得把设置停留在临时声明——回写 originalDecl（或删除），恢复探测前形态。
          const rollbackTarget = clone(raw)
          let rollbackOk = true
          if (rollbackTarget.providers?.[provider] !== undefined && Array.isArray(rollbackTarget.providers[provider].models)) {
            const re = rollbackTarget.providers[provider].models.find((e) => e.id === model)
            if (re !== undefined) {
              if (originalDecl !== undefined) re.reasoningEfforts = clone(originalDecl)
              else delete re.reasoningEfforts
              rollbackOk = deepEq(rollbackTarget, raw)
            }
          }
          if (!rollbackOk) {
            try {
              await replaceSettings(settingsNamespace(HOST_NAMESPACES.piAi),rollbackTarget)
              rollbackOk = true
            } catch (error2) {
              ctx.logger?.warn('dsh-reasoning-level: converge rollback failed — declaration may remain at temp full-vocab state (handled as generated shape on next apply)')
              ctx.logger?.warn(error2)
            }
          }
          // 台账与磁盘保持一致：回滚成功 → originalDecl 为当前真值（未声明则移除 pin）
          if (rollbackOk) {
            if (originalDecl !== undefined) verifiedEfforts.set(provider + '\u0000' + model, clone(originalDecl))
            else verifiedEfforts.delete(provider + '\u0000' + model)
          }
          return { writes: 0, skipped: 'replace-failed', rollback: rollbackOk ? 'restored' : 'left-temp' }
        }
      }
      // 027-F2（MAINT-019 P3-1 / MAINT-027 RCA §4）：no-change 路径同样落 pin——
      // 全档可用时临时声明=最终声明，收敛走此分支；此前不写 pin 导致重启后
      // hydrate 失忆、UI「固化 0 处」。幂等合并由 persistProbeEfforts 内建。
      if (entry.reasoningEfforts !== undefined) {
        const finalDecl = clone(entry.reasoningEfforts)
        verifiedEfforts.set(provider + '\u0000' + model, finalDecl)
        persistProbeEfforts({ [provider + '/' + model]: finalDecl })
      }
      return { writes: 1, skipped: 'no-change' }
    }

    /**
     * MAINT-019（P2-3）：filtered 探测的临时声明回滚——只把探测窗口写入的临时
     * 全量声明恢复为探测前的原声明（原无声明则删除），不写回任何 working 集。
     *
     * 与 convergeProbeDeclaration 分开实现（而非以 working=[] 复用）：converge 的
     * 返回契约是「收敛写回」（writes:1 即上报 converged），复用会把「声明未被固化」
     * 谎报为已收敛。本函数返回 skipped='filtered-no-converge'，由 probePersistedOutcome
     * 映射为 pending-apply（声明未改，等待显式 /probe/apply）。整节写锁与 converge 一致。
     */
    async function rollbackProbeDeclaration(provider, model, originalDecl) {
      return withPiAiWriteLock(async () => {
        const raw = rawSection(HOST_NAMESPACES.piAi)
        if (raw === undefined) return { writes: 0, skipped: 'no-pi-ai-section' }
        const target = clone(raw)
        const profile = target.providers !== undefined ? target.providers[provider] : undefined
        if (profile === undefined || !Array.isArray(profile.models)) return { writes: 0, skipped: 'no-models-entry' }
        const entry = profile.models.find((e) => e.id === model)
        if (entry === undefined) return { writes: 0, skipped: 'model-not-in-pi-ai-config' }
        if (originalDecl !== undefined) entry.reasoningEfforts = clone(originalDecl)
        else delete entry.reasoningEfforts
        if (deepEq(target, raw)) return { writes: 0, skipped: 'filtered-no-converge' }
        try {
          await replaceSettings(settingsNamespace(HOST_NAMESPACES.piAi),target)
          return { writes: 0, skipped: 'filtered-no-converge', rollback: 'restored' }
        } catch (error) {
          ctx.logger?.warn('dsh-reasoning-level: filtered probe rollback failed — declaration may remain at temp full-vocab shape')
          ctx.logger?.warn(error)
          return { writes: 0, skipped: 'replace-failed', rollback: 'left-temp' }
        }
      })
    }

    /**
     * 探测一个模型的全部候选等级（并发 3）。
     *
     * MAINT-017 重构：候选集 = 通用词汇表全量 7 档 ∪ 目录声明 ∪ 配置声明，
     *   不再使用 GENERATED_LEVELS 子集 fallback（兼容常量保留）；临时声明
     *   机制使 llm.stream 校验放行全部候选，实测后收敛到 working 集。
     *
     * MAINT-019（P2-3）：levelsFilter 非空 = 客户端子集筛选，filtered working 不是
     *   全量实测真值——跳过收敛写回（不得把声明缩到筛选子集「缩档陷阱」）；
     *   探测照常执行并返回结果，探测窗口写过的临时声明回滚为原声明。
     *
     * 被网关拒绝的等级仅作为该次探测结果的 rejected 列表返回——不入黑名单、
     * 不持久化（探测是"测量"不是用户调用，MAINT-013）；限流/超时等其他错误
     * 只标记 blocked。候选选择不读黑名单（每次探测全量重测），且探测开始即
     * 重置该 provider/model 的既有黑名单条目：会话内瞬时误判残留不得继续
     * 卡死该模型，探测结果成为注入依据的最新真值。
     */
    async function probeModelLevels(provider, model, levelsFilter) {
      const key = provider + '/' + model
      // per-model 互斥队列（F2）：并发 /probe 同一模型时整个流程串行化，
      // 后到请求等待前一请求完整完成（临时声明→实测→收敛→回滚）。
      return withProbeQueue(key, () => probeModelLevelsCore(provider, model, levelsFilter, key))
    }

    async function probeModelLevelsCore(provider, model, levelsFilter, key) {
      blacklist.delete(key)
      // 获取目录声明与配置声明
      const [resolveInfo, declared] = await Promise.all([
        (async () => {
          try {
            const info = await llm.resolveModelInfo(provider, model)
            if (info !== undefined && info.reasoning !== undefined && Array.isArray(info.reasoning.efforts)) {
              return info.reasoning.efforts.map((entry) => entry.id)
            }
            return []
          } catch (error) { return [] }
        })(),
        Promise.resolve(declaredEffortsOf(provider, model)),
      ])
      // 候选集 = 通用词汇表全量 7 档 ∪ 目录声明 ∪ 配置声明
      // 不再使用 GENERATED_LEVELS fallback（MAINT-017——词表全量即为基准）。
      const seen = new Set()
      const candidates = []
      function push(level) {
        if (!seen.has(level)) { seen.add(level); candidates.push(level) }
      }
      // 词汇表全量 7 档优先（THINKING_LEVEL_VOCABULARY 含 xhigh、max）
      for (const level of THINKING_LEVEL_VOCABULARY) push(level)
      // 目录声明：不过滤非标准档（MAINT-014 保留）
      for (const level of resolveInfo) push(level)
      // 配置声明：不过滤非标准档——词表外等级也能进入候选
      if (declared !== undefined) {
        for (const level of Object.keys(declared)) {
          if (!seen.has(level)) { seen.add(level); candidates.push(level) }
        }
      }
      // levelsFilter 作用于最终候选集（客户端显式筛选）
      if (Array.isArray(levelsFilter) && levelsFilter.length > 0) {
        const filtered = candidates.filter((level) => levelsFilter.includes(level))
        candidates.splice(0, candidates.length, ...filtered)
      }
      if (candidates.length === 0) {
        return { provider, model, key, levels: {}, working: [], rejected: [], blocked: [], blockedReasons: {}, error: 'no candidate levels' }
      }
      // ── 临时声明机制（MAINT-017）──────────────────────────────────────────────
      // 若词汇表中存在"不在当前声明内"的档位 → 临时写入全量声明使校验放行
      const declaredLevels = declared !== undefined ? Object.keys(declared) : []
      const vocabMissing = THINKING_LEVEL_VOCABULARY.filter((l) => !declaredLevels.includes(l))
      let tempDeclWritten = false
      let actualThinkingFormat

      if (vocabMissing.length > 0) {
        await withPiAiWriteLock(async () => {
          const raw = rawSection(HOST_NAMESPACES.piAi)
          if (raw !== undefined) {
            const tmpTarget = clone(raw)
            const tmpProfile = tmpTarget.providers !== undefined ? tmpTarget.providers[provider] : undefined
            if (tmpProfile !== undefined && Array.isArray(tmpProfile.models)) {
              const tmpEntry = tmpProfile.models.find((e) => e.id === model)
              if (tmpEntry !== undefined) {
                const api = typeof tmpProfile.api === 'string' ? tmpProfile.api : 'openai-completions'
                actualThinkingFormat = thinkingFormatOf(provider, api, tmpProfile)
                const tempDecl = buildFullVocabDeclaration(actualThinkingFormat)
                tmpEntry.reasoningEfforts = tempDecl
                try {
                  await replaceSettings(settingsNamespace(HOST_NAMESPACES.piAi),tmpTarget)
                  tempDeclWritten = true
                } catch (error) {
                  ctx.logger?.warn('dsh-reasoning-level: temp declaration write failed — probing with current declaration')
                }
              }
            }
          }
        })
      }
      // ── 探测执行 ──────────────────────────────────────────────────────────────
      const results = {}
      let next = 0
      async function worker() {
        while (next < candidates.length) {
          const level = candidates[next++]
          results[level] = await probeLevelOnce(provider, model, level)
        }
      }
      const workers = []
      for (let i = 0; i < PROBE_CONCURRENCY; i++) workers.push(worker())
      await Promise.all(workers)
      const working = []
      const rejected = []
      const blocked = []
      for (const level of candidates) {
        const result = results[level]
        if (result.ok) {
          working.push(level)
        } else if (result.code === 'UNSUPPORTED_REASONING_EFFORT' || rejectionLevelOf(result) !== undefined
          || rejectionLevelFromEnumeration(result, level) !== undefined) {
          // 真实环境（2026-10-21 用户截图）：聚合网关对 `minimal` 返回
          // INVALID_REQUEST 400 + `Invalid option: expected one of "off"|"low"|…`——
          // 语义是「该档位不被接受」，与「网络/鉴权失败」完全不同。按枚举解析归类为
          // rejected，UI 才不会把整段 JSON 糊在「其他错误」列里。
          rejected.push(level)
        } else {
          blocked.push(level)
        }
      }
      // FEAT-004 ⑦（设计 §6.2）：仅 blocked 档位的错误归因（code/message/kind）——
      // 把「其他错误」黑盒变成可解释结局。缺字段时省略该键（不写 undefined）；
      // rejected（能力拒绝语义明确）不进入本表。旧客户端忽略该新增字段。
      const blockedReasons = {}
      for (const level of blocked) {
        const result = results[level]
        const reason = {}
        if (typeof result.code === 'string') reason.code = result.code
        if (typeof result.message === 'string') reason.message = result.message
        if (typeof result.kind === 'string') reason.kind = result.kind
        if (Object.keys(reason).length > 0) blockedReasons[level] = reason
      }
      // ── 收敛 ──────────────────────────────────────────────────────────────────
      // MAINT-019（P2-3）：levelsFilter 非空 = 客户端子集筛选——filtered working 不是
      // 全量实测真值，以它替换声明会把声明缩到筛选子集（缩档陷阱）。探测照常执行并
      // 返回结果，收敛写回跳过；但探测窗口写过的临时全量声明 MUST 回滚为探测前原声明
      // （否则设置会停在临时形状——MAINT-017 R1 F1 同一纪律）。
      const filteredProbe = Array.isArray(levelsFilter) && levelsFilter.length > 0
      let convergeResult
      if (tempDeclWritten) {
        convergeResult = filteredProbe
          ? await rollbackProbeDeclaration(provider, model, declared)
          : await convergeProbeDeclaration(provider, model, declared, actualThinkingFormat, working)
      }
      // 027-F1：每模型持久化结局（越界目标显式化 + 「固化 N 处」措辞诚实化的服务端事实源）
      const inConfig = piAiModelEntry(provider, model) !== undefined
      // FEAT-004 ⑦：官方适配器管辖判定与 llm-pi-ai 配置判定同源（设计 §10.1）
      const persisted = probePersistedOutcome(inConfig, working, tempDeclWritten, declared, convergeResult, officialAdapterOwns(provider))
      return { provider, model, key, levels: results, working, rejected, blocked, blockedReasons, persisted }
    }

    /** 应用探测结果：把实测可用的等级固化进 llm-pi-ai 模型能力声明。
     *  MAINT-017 合并语义：手写声明→并入（保留用户档位与 wire，追加 working
     *  集里的新档位）；生成声明/未声明→替换为 working 集。 */
    async function applyProbeResults(results) {
      // 整节写串行化：与探测临时声明/收敛、applyPiAi 的 RMW 互斥（F5）。
      return withPiAiWriteLock(() => applyProbeResultsCore(results))
    }

    async function applyProbeResultsCore(results) {
      const raw = rawSection(HOST_NAMESPACES.piAi)
      if (raw === undefined) return { writes: 0, skipped: [], outcomes: [] }
      const target = clone(raw)
      const entries = new Map()
      for (const [route, profile] of Object.entries(target.providers ?? {})) {
        if (!Array.isArray(profile.models)) continue
        for (const model of profile.models) entries.set(route + '\u0000' + model.id, model)
      }
      let writes = 0
      const skipped = []
      const outcomes = [] // 027-F3：per-model 固化结局（written / already-verified / not-in-pi-ai-config / no-working-levels / persist-error）
      const pendingVerified = {}
      const pendingPins = [] // {key: route\0model, verified} —— replace 成功后统一写入台账
      for (const result of Array.isArray(results) ? results : []) {
        if (result === null || result === undefined || typeof result.provider !== 'string' || typeof result.model !== 'string') continue
        const resultKey = typeof result.key === 'string' ? result.key : result.provider + '/' + result.model
        const entry = entries.get(result.provider + '\u0000' + result.model)
        if (entry === undefined) {
          // R0-P2-1（FEAT-004 ⑦ / 设计 §10.1）：两种「未写入」结局在汇总层必须可区分——
          // 官方适配器管辖（等级经 llm-deepseek 官方通道下发）≠ 其他适配器提供。
          // 判据与服务端探测同源：优先采信探测阶段已判定的 persisted（/probe 响应随
          // collected 结果原样回传给 /probe/apply），并回退 officialAdapterOwns(provider)
          //（旧客户端不携带 persisted 时仍可判定）；绝不按 provider 名猜测。
          // outcomes 形状保持不变（旧客户端消费 not-in-pi-ai-config，红线：只加不改）。
          const official = result.persisted === 'skipped:official-adapter' || officialAdapterOwns(result.provider)
          skipped.push({ key: result.key, reason: official ? 'official-adapter' : 'not-in-pi-ai-config' })
          outcomes.push({ key: resultKey, outcome: 'not-in-pi-ai-config' })
          continue
        }
        // MAINT-014：不再按 GENERATED_LEVELS 过滤 working——非标准档（如 qwen 的
        // custom/ultra）也能进入固化逻辑；无线值映射时以等级名自身作为线值。
        const working = Array.isArray(result.working) ? result.working : []
        if (working.length === 0) {
          skipped.push({ key: result.key, reason: 'no-working-levels' })
          outcomes.push({ key: resultKey, outcome: 'no-working-levels' })
          continue
        }
        const current = entry.reasoningEfforts
        const mine = myModelEfforts.get(result.provider + '\u0000' + result.model)
        const mineLike = mine !== undefined && current !== undefined && deepEq(current, mine)
        const pinned = verifiedEfforts.get(result.provider + '\u0000' + result.model)
        const pinnedLike = pinned !== undefined && current !== undefined && deepEq(current, pinned)
        const profile = target.providers[result.provider]
        const api = typeof profile.api === 'string' ? profile.api : 'openai-completions'
        const thinkingFormat = thinkingFormatOf(result.provider, api, profile)

        if (current !== undefined && !isGeneratedEfforts(current, thinkingFormat) && !mineLike && !pinnedLike) {
          // ── 手写声明：并入（保留用户档位与 wire，追加 working 集里的新档位）──
          const merged = clone(current)
          for (const level of working) {
            if (merged[level] === undefined) {
              merged[level] = wireForLevel(level, thinkingFormat)
            }
          }
          if (deepEq(merged, current)) {
            skipped.push({ key: result.key, reason: 'already-verified' })
            outcomes.push({ key: resultKey, outcome: 'already-verified' })
            continue
          }
          entry.reasoningEfforts = merged
          // 钉入台账（延迟到 settings.replace 成功后写入）
          pendingPins.push({ key: result.provider + '\u0000' + result.model, verified: clone(merged) })
          pendingVerified[result.provider + '/' + result.model] = clone(merged)
          outcomes.push({ key: resultKey, outcome: 'written' })
          writes += 1
          continue // 跳到下一个 result，避免重复 fallthrough
        }
        // ── 生成声明/未声明：替换为 working 集 ──
        const verified = {}
        for (const level of working) {
          verified[level] = wireForLevel(level, thinkingFormat)
        }
        if (Object.keys(verified).length === 0) {
          skipped.push({ key: result.key, reason: 'no-working-levels' })
          outcomes.push({ key: resultKey, outcome: 'no-working-levels' })
          continue
        }
        if (current !== undefined && deepEq(verified, current)) {
          skipped.push({ key: result.key, reason: 'already-verified' })
          outcomes.push({ key: resultKey, outcome: 'already-verified' })
          continue
        }
        entry.reasoningEfforts = verified
        // 钉入台账（与 llm-reasoning.probeEfforts 持久化）：实测即真值，不再被生成表升级覆盖；
        // 与 myModelEfforts 不同——关闭开关（enabled:false）不会撤销这些已固化的声明。
        // 台账延迟到 settings.replace 成功后写入：失败时不得残留"内存已 pin、磁盘未写"的分叉。
        pendingPins.push({ key: result.provider + '\u0000' + result.model, verified: clone(verified) })
        pendingVerified[result.provider + '/' + result.model] = clone(verified)
        outcomes.push({ key: resultKey, outcome: 'written' })
        writes += 1
      }
      if (writes > 0 && !deepEq(target, raw)) {
        try {
          await replaceSettings(settingsNamespace(HOST_NAMESPACES.piAi),target)
          // 落盘成功后才生效内存台账并持久化 probeEfforts（失败直接 return，不产生状态分叉）
          for (const pin of pendingPins) verifiedEfforts.set(pin.key, pin.verified)
          persistProbeEfforts(pendingVerified)
        } catch (error) {
          ctx.logger?.warn('dsh-reasoning-level: probe apply replace failed')
          ctx.logger?.warn(error)
          // 027-F3：整节写失败——本轮拟写入的模型结局如实标 persist-error
          for (const o of outcomes) { if (o.outcome === 'written') o.outcome = 'persist-error' }
          return { writes: 0, skipped, outcomes, error: error !== undefined && error.message !== undefined ? error.message : String(error) }
        }
      }
      return { writes, skipped, outcomes }
    }

    function readBody(req) {
      return new Promise((resolve) => {
        let body = ''
        req.on('data', (chunk) => { body += chunk })
        req.on('end', () => resolve(body))
        req.on('error', () => resolve(body))
      })
    }

    /**
     * 027-F3：把一次 /probe 的结果并入 llm-reasoning.lastProbe（读改写整字段，
     * 与 persistProbeEfforts 同模式；失败仅 warn）。挂载回显与「保留」期望的数据源。
     */
    function recordLastProbe(result) {
      try {
        if (result === null || typeof result !== 'object') return
        if (typeof result.provider !== 'string' || typeof result.model !== 'string') return
        const cfg = configOf(NS)
        const prev = cfg !== undefined && cfg.lastProbe !== undefined && typeof cfg.lastProbe === 'object' && cfg.lastProbe !== null ? clone(cfg.lastProbe) : {}
        const models = prev.models !== undefined && typeof prev.models === 'object' && prev.models !== null ? prev.models : {}
        const entry = {
          working: Array.isArray(result.working) ? result.working.slice() : [],
          rejected: Array.isArray(result.rejected) ? result.rejected.slice() : [],
          blocked: Array.isArray(result.blocked) ? result.blocked.slice() : [],
          persisted: typeof result.persisted === 'string' ? result.persisted : 'pending-apply',
        }
        // FEAT-004 ⑦（设计 §6.2）：blocked 档位归因随 lastProbe 落盘。写边界再收一次
        // 口径——只接受 blocked 列表内的等级 + 三个字符串字段；全缺时字段保持缺席
        // （旧 lastProbe 同形，客户端按「未知原因」降级），绝不写 undefined。
        const blockedReasons = {}
        const rawReasons = result.blockedReasons !== null && result.blockedReasons !== undefined
          && typeof result.blockedReasons === 'object' && !Array.isArray(result.blockedReasons)
          ? result.blockedReasons
          : {}
        for (const level of entry.blocked) {
          const raw = rawReasons[level]
          if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
          const reason = {}
          if (typeof raw.code === 'string') reason.code = raw.code
          if (typeof raw.message === 'string') reason.message = raw.message
          if (typeof raw.kind === 'string') reason.kind = raw.kind
          if (Object.keys(reason).length > 0) blockedReasons[level] = reason
        }
        if (Object.keys(blockedReasons).length > 0) entry.blockedReasons = blockedReasons
        models[result.provider + '/' + result.model] = entry
        const next = { t: Date.now(), models }
        mutateSettings(NS, [{ op: 'set', path: ['lastProbe'], value: next }]).catch((error) => {
          ctx.logger?.warn('dsh-reasoning-level: lastProbe persist failed')
          ctx.logger?.warn(error)
        })
      } catch (error) {
        ctx.logger?.warn('dsh-reasoning-level: lastProbe persist failed')
        ctx.logger?.warn(error)
      }
    }

    /**
     * 027-F3：/probe/apply 收口——按 per-model outcomes 刷新 lastProbe 的持久化
     * 结局。写入/失败/越界/无可用等级如实覆盖；already-verified 保留探测阶段
     * 结局（converged / no-change-already-correct 语义不因确认而降级）。
     */
    function recordLastProbeApply(results, outcomes) {
      try {
        const outcomeByKey = new Map()
        for (const o of Array.isArray(outcomes) ? outcomes : []) {
          if (o !== null && typeof o === 'object' && typeof o.key === 'string') outcomeByKey.set(o.key, o.outcome)
        }
        if (outcomeByKey.size === 0) return
        const cfg = configOf(NS)
        const prev = cfg !== undefined && cfg.lastProbe !== undefined && typeof cfg.lastProbe === 'object' && cfg.lastProbe !== null ? clone(cfg.lastProbe) : undefined
        if (prev === undefined) return
        let changed = false
        for (const result of Array.isArray(results) ? results : []) {
          if (result === null || typeof result !== 'object') continue
          const key = typeof result.key === 'string' ? result.key : (typeof result.provider === 'string' && typeof result.model === 'string' ? result.provider + '/' + result.model : undefined)
          if (key === undefined) continue
          const entry = prev.models !== undefined ? prev.models[key] : undefined
          if (entry === undefined || typeof entry !== 'object') continue
          const outcome = outcomeByKey.get(key)
          let persisted
          if (outcome === 'written' || outcome === 'persist-error') persisted = outcome === 'written' ? 'written' : 'persist-error'
          else if (outcome === 'not-in-pi-ai-config') {
            // FEAT-004 ⑦（设计 §10.1）：探测阶段已判定为官方适配器管辖的模型，apply
            // 不得把归因降级回「不在 llm-pi-ai 配置」（两者是不同结局；apply 的
            // per-model outcome 形状保持既有 not-in-pi-ai-config 不变）。
            persisted = entry.persisted === 'skipped:official-adapter' ? 'skipped:official-adapter' : 'skipped:not-in-pi-ai-config'
          }
          else if (outcome === 'no-working-levels') persisted = 'skipped:no-working'
          else if (outcome === 'already-verified') persisted = typeof entry.persisted === 'string' ? entry.persisted : 'no-change-already-correct'
          else continue
          if (entry.persisted !== persisted) { entry.persisted = persisted; changed = true }
        }
        if (!changed) return
        const next = { t: Date.now(), models: prev.models !== undefined ? prev.models : {} }
        mutateSettings(NS, [{ op: 'set', path: ['lastProbe'], value: next }]).catch((error) => {
          ctx.logger?.warn('dsh-reasoning-level: lastProbe persist failed')
          ctx.logger?.warn(error)
        })
      } catch (error) {
        ctx.logger?.warn('dsh-reasoning-level: lastProbe persist failed')
        ctx.logger?.warn(error)
      }
    }

    async function parseProbeInput(req) {
      const cfg = configOf(NS)
      const publicOk = cfg !== undefined && cfg.statsPublic === true
      if (!publicOk && !isLoopbackHost(req)) return { forbidden: true }
      let input = {}
      try { input = JSON.parse(await readBody(req) || '{}') } catch (error) { input = {} }
      return input
    }

    function sendJson(res, payload) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(payload))
    }

    // P0-2 实测按钮（单品）：1-token 请求验证某模型某等级实际可用（底层已修复）。
    // MAINT-013：探测是"测量"——被拒等级仅作为该次响应 rejected 返回，不入黑名单。
    scope.effect(() => {
      try {
        return webServer.register({
          kind: 'exact',
          path: STATS_PATH + '/test',
          handler: (req, res) => {
            parseProbeInput(req).then(async (input) => {
              if (input.forbidden === true) {
                res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
                res.end('forbidden')
                return
              }
              const provider = typeof input.provider === 'string' ? input.provider : ''
              const model = typeof input.model === 'string' ? input.model : ''
              const effort = typeof input.level === 'string' ? input.level : undefined
              if (provider === '' || model === '') {
                res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
                res.end(JSON.stringify({ ok: false, error: 'provider and model required' }))
                return
              }
              const result = await probeLevelOnce(provider, model, effort)
              const rejected = result.code === 'UNSUPPORTED_REASONING_EFFORT' || rejectionLevelOf(result) !== undefined
              sendJson(res, {
                ok: result.ok,
                provider,
                model,
                level: effort ?? null,
                durationMs: result.durationMs,
                finish: result.kind,
                code: result.code ?? null,
                error: result.message ?? null,
                rejected,
                blacklisted: effort !== undefined && isBlacklisted(provider, model, effort),
              })
            }).catch((error) => {
              try { sendJson(res, { ok: false, error: error !== undefined && error.message !== undefined ? error.message : String(error) }) } catch (error2) { /* ignore */ }
            })
          },
        })
      } catch (error) {
        ctx.logger?.warn(`dsh-reasoning-level: stats test route registration failed (${STATS_PATH}/test) — duplicate route 或宿主注册面变化；test endpoint disabled`)
        ctx.logger?.warn(error)
        return () => {}
      }
    }, 'dsh-reasoning-level: stats test route')

    // v0.7.0 一键探测：POST /reasoning-level-stats/probe {provider, model, levels?}
    // —— 探测单个模型全部候选等级（并发 3）；网关实测拒绝的等级仅作为该次探测
    // 结果的 rejected 列表返回（不入黑名单、不持久化——探测是测量，MAINT-013）。
    scope.effect(() => {
      try {
        return webServer.register({
          kind: 'exact',
          path: STATS_PATH + '/probe',
          handler: (req, res) => {
            parseProbeInput(req).then(async (input) => {
              if (input.forbidden === true) {
                res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
                res.end('forbidden')
                return
              }
              const provider = typeof input.provider === 'string' ? input.provider : ''
              const model = typeof input.model === 'string' ? input.model : ''
              if (provider === '' || model === '') {
                res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
                res.end(JSON.stringify({ ok: false, error: 'provider and model required' }))
                return
              }
              // 027-F3：探测收口——把该模型结果并入 llm-reasoning.lastProbe（持久回显）
              const result = await probeModelLevels(provider, model, Array.isArray(input.levels) ? input.levels : undefined)
              recordLastProbe(result)
              sendJson(res, result)
            }).catch((error) => {
              try { sendJson(res, { ok: false, error: error !== undefined && error.message !== undefined ? error.message : String(error) }) } catch (error2) { /* ignore */ }
            })
          },
        })
      } catch (error) {
        ctx.logger?.warn(`dsh-reasoning-level: probe route registration failed (${STATS_PATH}/probe) — duplicate route 或宿主注册面变化；probe endpoint disabled`)
        ctx.logger?.warn(error)
        return () => {}
      }
    }, 'dsh-reasoning-level: probe route')

    // v0.7.0 固化配置：POST /reasoning-level-stats/probe/apply {results: [...]}
    // —— 把实测可用的等级写回 llm-pi-ai 能力声明（不覆盖用户手写声明）。
    scope.effect(() => {
      try {
        return webServer.register({
          kind: 'exact',
          path: STATS_PATH + '/probe/apply',
          handler: (req, res) => {
            parseProbeInput(req).then(async (input) => {
              if (input.forbidden === true) {
                res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
                res.end('forbidden')
                return
              }
              // 027-F3：apply 收口——按 per-model outcomes 刷新 lastProbe 持久化结局
              const applied = await applyProbeResults(input.results)
              recordLastProbeApply(input.results, applied.outcomes)
              sendJson(res, applied)
            }).catch((error) => {
              try { sendJson(res, { ok: false, error: error !== undefined && error.message !== undefined ? error.message : String(error) }) } catch (error2) { /* ignore */ }
            })
          },
        })
      } catch (error) {
        ctx.logger?.warn(`dsh-reasoning-level: probe apply route registration failed (${STATS_PATH}/probe/apply) — duplicate route 或宿主注册面变化；apply endpoint disabled`)
        ctx.logger?.warn(error)
        return () => {}
      }
    }, 'dsh-reasoning-level: probe apply route')
  }

  // ── HTTP 端点挂载入口（RCA 2026-10-20：0.2.x 代序 webServer 晚到）───────────
  // cordis 4 的 ctx.get(name, strict=true) 在提供方 fiber 未 ACTIVE（state !== 2）
  // 时返回 undefined（cordis lib/index.js ReflectService.get/_getImpl L763-772）；
  // DSH 0.2.x 代序中 webServer 常在 profile 行插件 apply 之后才挂载——兄弟项目
  // writing-workflow lib/host-boundary.js L155-165 已把该现象写成契约，dsh-agent-
  // router lib/index.js L66 以 `export const inject = ['settings','typert','webServer']`
  // 等待服务就绪。因此 webServer 一律经 ctx.inject(['webServer']) 注入等待：服务
  // 就绪即挂载，服务重启（新实例）时注入子 fiber 销毁重建 → 路由随 scope.effect
  // 自动重挂；仅宿主无 ctx.inject 表面（或注入调用失败）时回退一次性 ctx.get
  // 探测（0.1.x 已证路径：apply 期 webServer 已在场）。
  //
  // 幂等守卫（mountedWebServer）：同一 webServer 实例被重复投递时只注册一次，避免
  // 重复 register 的副作用与重复错误日志（真实 dsh-host-webserver 对重复 path 先
  // throw 且不改旧路由表——旧端点不会因此消失）。真实 cordis 的服务重启 = 提供方
  // fiber 重建：旧实例的注入子 fiber 先 unload（effect cleanup 复位守卫）→ 新实例
  // reload 后重挂；"同实例再次注入"不是真实独立重入路径，守卫只覆盖重复投递。
  let mountedWebServer
  /** 当前可见的 webServer：已挂载实例优先，否则 ctx.get 探测（可缺席，不得抛出）。 */
  function visibleWebServer() {
    if (mountedWebServer !== undefined) return mountedWebServer
    try {
      return typeof ctx.get === 'function' ? ctx.get(HOST_SERVICES.webServer) : undefined
    } catch (error) {
      return undefined
    }
  }
  /**
   * 契约漂移 fail-loud（MAINT-036 面，RCA 2026-10-20 补充）：服务晚到时 settings
   * 注入回调里的 checkHostContract 已经把 webServer 判为"缺席（可选服务既定降级）"
   * 跑过；此后 webServer 可见但 register 非函数 = 宿主注册面漂移。此形态下四条
   * stats 路由本身必然挂不上（register 不可调用），contractHealth 没有可读端点
   * （页面横幅通道不存在），因此这里直接 logger.error 一条可检索的契约漂移日志；
   * contractHealth 标记仍如实保留，供后续可读健康面/诊断消费，不宣称页面可见。
   */
  function noteWebServerContract(webServerService) {
    if (webServerService === undefined || webServerService === null) return
    if (typeof webServerService.register === 'function') return
    ctx.logger?.error('dsh-reasoning-level: 宿主契约漂移——webServer.register 非函数 → HTTP 端点不可用（要求 dsh ≥0.2.0-rc.2 的 dsh-host-webserver register({kind:"exact",path,handler}) 面；请升级宿主或确认 webServer 服务实现匹配）')
    if (!contractHealth.missing.includes('webServer.register')) contractHealth.missing.push('webServer.register')
    contractHealth.ok = false
    contractHealth.checkedAt = Date.now()
  }
  /** 挂载一次：同实例幂等；路由生命周期挂 scope.effect（服务重启自动销毁重建）。 */
  function mountOnce(scope, webServerService) {
    if (webServerService === undefined || webServerService === null) return
    if (mountedWebServer === webServerService) return
    mountedWebServer = webServerService
    try {
      noteWebServerContract(webServerService)
      scope.effect(() => () => {
        if (mountedWebServer === webServerService) mountedWebServer = undefined
      }, 'dsh-reasoning-level: http endpoints lifetime')
      mountHttpEndpoints(scope, webServerService)
    } catch (error) {
      // 挂载异常只降级端点，绝不影响插件行加载（boot 级爆炸半径红线）。
      if (mountedWebServer === webServerService) mountedWebServer = undefined
      ctx.logger?.warn('dsh-reasoning-level: http endpoints mount failed — stats/probe endpoints disabled')
      ctx.logger?.warn(error)
    }
  }
  /**
   * 注入等待 webServer 就绪（cordis 4 ctx.inject 回调语义：服务在场立即执行、
   * 后到则到场时执行；返回 fiber，生命周期随本插件 ctx，父 dispose 自动清理）。
   *
   * @returns {boolean} true = 已走注入路径；false = 宿主无 ctx.inject 表面或注入
   *          调用失败，调用方回退一次性 ctx.get 探测。
   */
  function injectWebServerWhenReady() {
    if (typeof ctx.inject !== 'function') return false
    try {
      ctx.inject([...HOST_SERVICES.webServerInject], (child) => {
        const webServerService = child[HOST_SERVICES.webServer]
        if (webServerService === undefined) return
        mountOnce(child, webServerService)
      })
      return true
    } catch (error) {
      ctx.logger?.warn('dsh-reasoning-level: ctx.inject(webServer) unavailable — falling back to eager ctx.get')
      ctx.logger?.warn(error)
      return false
    }
  }
  if (!injectWebServerWhenReady()) {
    const webServerService = visibleWebServer()
    if (webServerService !== undefined) mountOnce(ctx, webServerService)
  }

  // ---- 启动即应用；llm-pi-ai 未就绪时短暂重试 ----
  // R0-P3-3（REVIEW-MAINT-035+036-R0）：entry 守卫与 piAi 就绪重试各自独立
  // 计数（entryRetries / retries）——两语义不同（前者等 Config 接线生效，
  // 后者等 pi-ai entry 出现），共享计数会在交错时互相吞掉对方的重试额度。
  let retries = 0
  let entryRetries = 0
  function boot() {
    // MAINT-036：entry 可见性守卫（最优先）——0.2.0 接线下 describe() 必含本插件
    // 描述符（loader 接线 Config 为 entry，user 层空也有 value=defaults 投影）；
    // 0.1.x 旧宿主上 Config 导出不会被接线、描述符永不出现（静默失效的旧形态）。
    // 重试耗尽仍缺席 = 宿主代际不符或接线失败 → fail-loud + 数据面自禁用。
    if (describeEntry(NS) === undefined) {
      if (entryRetries < 5) {
        entryRetries += 1
        try {
          ctx.timeout(boot, 1000)
        } catch (error) {
          ctx.logger?.warn('dsh-reasoning-level: boot retry scheduling failed — applying once more at next settings update')
        }
        return
      }
      contractHealth.ok = false
      contractHealth.missing.push('settings entry "' + NS + '"')
      ctx.logger?.error('dsh-reasoning-level: 自有设置描述符 ' + NS + ' 重试后仍未出现——宿主代际不符（要求 dsh ≥0.2.0-rc.2）或 entry 接线失败；插件数据面已自禁用，宿主不受影响')
      return
    }
    hydrateVerifiedEfforts()
    hydrateAppliedLedger()
    // FEAT-007：能力写回台账（appliedInputs）跨重启恢复——启动即应用时据此
    // 判断「已写入/待撤销」，关闭插件后仍能还原。
    hydrateAppliedInputs()
    applyLevel().then(() => {
      // settings 注入前已创建的 agent（极简 profile / 热重载 / 先于本插件
      // 激活的兄弟 agent）在这里补一次首见对齐；sweep 内部逐 agent 隔离异常。
      effortEnforcer.sweep()
      // 0.2.2 代序：provider 条目与 agent-default-model 条目都可能晚于本插件
      // ACTIVE，applyDefaultAgent() 会因 configOf() === undefined 静默跳过。
      // 重试条件（REVIEW R0 F10 收窄）：piAi 缺席（DSH 必装面）恒重试；
      // agent-default-model 缺席只在 syncDefaultAgent 开启时才值得重试（关闭时
      // applyDefaultAgent 本就是 no-op——宿主没有该条目的极简 profile 不烧 5 次
      // 幂等重试）。DeepSeek 适配器设置节缺席不重试：适配器可选安装，缺席可能
      // 是常态；其同步由 settings 变更事件路径补（既有语义）。
      const piAiMissing = configOf(settingsNamespace(HOST_NAMESPACES.piAi)) === undefined
      const admWanted = configOf(NS)?.syncDefaultAgent === true
      const agentDefaultMissing = admWanted && configOf(settingsNamespace(HOST_NAMESPACES.agentDefaultModel)) === undefined
      if ((piAiMissing || agentDefaultMissing) && retries < 5) {
        retries += 1
        try {
          ctx.timeout(boot, 1000)
        } catch (error) {
          ctx.logger?.warn('dsh-reasoning-level: boot retry scheduling failed — applying once more at next settings update')
        }
      }
    }).catch((error) => {
      ctx.logger?.warn('dsh-reasoning-level: boot apply rejected')
      ctx.logger?.warn(error)
    })
  }

  // ── MAINT-035：一次性迁移旧版 settings.yaml 滞留段（DEC-019）───────────────
  // 背景：宿主升级 0.2.0 时把 settings.yaml 一次性导入各同 id entry——本插件当时
  // 已卸载无 entry 承接，用户数据滞留 settings.yaml.imported 的 llm-reasoning 段
  // （enabled/level/models/probeEfforts/applied/lastProbe）。boot 前检测（新配置
  // user 层为空 + .imported 存在该段）→ 动态 import('yaml') 解析（宿主平坦树
  // 实测含 yaml 包；缺席 = 静默跳过迁移，不炸机）→ 字段白名单过滤为 Config 已
  // 知字段（防意外形状）→ settings.replace(NS, 段) 导入 → 写标记文件防重复。
  // 对 .imported 文件只读；标记文件放 $DSH_HOME/storages/（stats 持久化同目录
  // 先例）——用户重置配置后不会被 .imported 复活旧数据。任何失败单独 log，
  // 不阻断 boot-apply。
  const MIGRATION_MARKER_FILE = 'reasoning-level-migrated.json'
  async function migrateLegacySettingsOnce() {
    const home = resolveDshHomeSafe()
    if (home === undefined) return
    const markerPath = join(home, 'storages', MIGRATION_MARKER_FILE)
    if (existsSync(markerPath)) return
    const entry = describeEntry(NS)
    const userLayer = entry !== undefined && entry.user !== null && typeof entry.user === 'object' ? entry.user : undefined
    if (userLayer !== undefined && Object.keys(userLayer).length > 0) return
    const importedPath = join(home, 'settings.yaml.imported')
    if (!existsSync(importedPath)) return
    // 动态可选能力：yaml 包缺席（import 失败）= 抛给调用方 catch 记日志跳过——
    // 零运行时依赖红线不动摇（dependencies 恒 {}）。
    const yamlModule = await import('yaml')
    const parsed = yamlModule.parse(readFileSync(importedPath, 'utf8'))
    const section = parsed !== null && typeof parsed === 'object' ? parsed[NS] : undefined
    if (section === null || typeof section !== 'object') return
    // 字段白名单：只导入 Config 已知字段（键集单源自 schema 定义，防意外形状）。
    const knownFields = Object.keys(Config.dict)
    const filtered = {}
    for (const key of Object.keys(section)) {
      if (knownFields.includes(key)) filtered[key] = clone(section[key])
    }
    await replaceSettings(NS, filtered)
    mkdirSync(join(home, 'storages'), { recursive: true })
    writeFileSync(markerPath, JSON.stringify({ migratedAt: Date.now(), ns: NS, fields: Object.keys(filtered).sort() }), 'utf8')
    ctx.logger?.info(`dsh-reasoning-level: 旧版设置已一次性迁移（${Object.keys(filtered).length} 字段 → ${NS}；标记 ${MIGRATION_MARKER_FILE}）`)
  }

  // ── MAINT-036：宿主契约自检（消费面方法存在性；见 contractHealth 声明处注释）──
  // settings×4 + llm×2 为数据面硬消费；webServer.register 仅在服务**可见**时校验
  // （可选服务缺席本就是既定降级路径，不算契约缺失）。0.2.x 代序服务晚到：判据取
  // "已挂载实例或当前可见实例"（visibleWebServer——注入子 fiber 已挂载的实例优先，
  // 否则 ctx.get 探测），不得因改成 ctx.inject 而把这条 fail-loud 检查静默跳过；
  // 服务在 settings 注入回调之后才到货的窗口由 noteWebServerContract 补齐。
  // configure 不入致命集——缺席只降级表单策略（warn-only，见下方 configure
  // 调用处的 try/catch）。
  function checkHostContract(settingsService) {
    const missing = []
    const requireFn = (holder, method, label) => {
      if (typeof holder?.[method] !== 'function') missing.push(label)
    }
    for (const method of ['describe', 'update', 'replace', 'mutate']) {
      requireFn(settingsService, method, 'settings.' + method)
    }
    requireFn(llm, HOST_LLM_METHODS.resolveModelInfo, 'llm.resolveModelInfo')
    requireFn(llm, HOST_LLM_METHODS.stream, 'llm.stream')
    const webServerService = visibleWebServer()
    if (webServerService !== undefined) requireFn(webServerService, 'register', 'webServer.register')
    contractHealth.ok = missing.length === 0
    contractHealth.missing = missing
    contractHealth.checkedAt = Date.now()
    return missing
  }

  // ── MAINT-035/036：settings 服务注入回调（configure / 事件监听 / 迁移 / boot）───
  // RCA 2026-10-20：宿主无 ctx.inject 表面（非 cordis 4 代序 / 极简 stub）时不得让
  // 插件行加载抛错——数据面自禁用，与「settings 服务缺席」同一降级路径（stats
  // 端点仍活；contractHealth 由 statsSnapshot 的 settings===undefined 分支如实
  // 上报）。有注入表面的宿主（DSH 全代）行为零变化。
  const onSettingsReady = (child) => {
    settings = child.settings
    // 契约自检 fail-loud：消费面缺失（服务面漂移 / 0.1.x 旧宿主 register 形态）→
    // log error + 数据面自禁用（不注册事件/迁移/boot，stats 端点仍活供 health
    // 上报）——绝不抛出（插件行失败 = profile 挂载失败 = 整机级爆炸半径）。
    const missing = checkHostContract(child.settings)
    if (missing.length > 0) {
      ctx.logger?.error('dsh-reasoning-level: 宿主契约不兼容——缺失消费面: ' + missing.join(', ') + '（要求 dsh ≥0.2.0-rc.2）。插件数据面已自禁用，宿主不受影响；请升级插件或确认宿主版本匹配')
      return
    }
    // 关闭宿主设置表单自动生成（自有设置页的原生模式；dsh-settings README +
    // 先例 dsh-llm-pi-ai 0.2.0 L2532-2534）。configure 缺席（0.1.x 旧宿主）只
    // 降级为日志，绝不阻塞挂载。
    try {
      const dispose = child.settings.configure({ auto: false }, ctx.fiber)
      child.effect(() => dispose, 'dsh-reasoning-level: settings presentation policy')
    } catch (error) {
      ctx.logger?.warn('dsh-reasoning-level: settings.configure({auto:false}) failed — 宿主设置面与插件预期不符（要求 dsh ≥0.2.0-rc.2）')
      ctx.logger?.warn(error)
    }
    // 事件：主名 settings/document-updated（0.2.0 契约）+ 历史名 settings/updated
    // （跨代容错，candidates 不是契约）。handler 只消费首参 ns——两代 payload
    // 形状兼容。
    // R0-P2-1（REVIEW-MAINT-035+036-R0）：挂 child.on（注入子 fiber）而非主
    // ctx.on——settings 服务重启时注入回调重入，主 ctx 上的 handler 会累积
    // 重复（applyLevel 幂等无功能影响，但属泄漏面）；child fiber 随服务重启
    // 一并销毁重建，handler 生命周期自动对齐。
    for (const eventName of HOST_EVENTS.settingsUpdatedCandidates) {
      child.on(eventName, (ns) => {
        // R0-P1-1：设置面有任何变更（含本插件自身写——宿主对所有写者 emit）
        // → describe 缓存失效，下次读取走宿主新鲜面。
        invalidateDescribeCache()
        // FEAT-007：模型信息快照同样失效——用户改配置后工作台必须立即看到新值。
        invalidateModelsCache()
        if (!isRelevantSettingsNs(ns)) return
        // 本插件正在写该 ns：dsh-settings 在 write 内同步 emit，这个事件由当前
        // apply/revert/probe 负责，不再排一轮（自写风暴的源头抑制）。只抑制同一
        // ns——写窗口内其他 ns 的外部事件仍照常调度（不吞用户变更）。
        if (selfWriteNs.includes(ns)) return
        scheduleApply()
      })
    }
    // 插件/设置 child 卸载时清掉挂起调度，避免 fiber 释放后仍触发 apply。
    child.effect(() => () => cancelScheduledApply(), 'dsh-reasoning-level: pending settings apply')
    // 迁移失败不阻断 boot-apply（DEC-019）；boot 链在迁移落定后启动。
    ;(async () => {
      try {
        await migrateLegacySettingsOnce()
      } catch (error) {
        ctx.logger?.warn('dsh-reasoning-level: 旧版设置迁移失败（已跳过，不影响其余功能）')
        ctx.logger?.warn(error)
      }
      try {
        boot()
      } catch (error) {
        ctx.logger?.warn('dsh-reasoning-level: boot failed')
        ctx.logger?.warn(error)
      }
    })()
  }
  if (typeof ctx.inject === 'function') ctx.inject([...HOST_SERVICES.optionalInject], onSettingsReady)
}
