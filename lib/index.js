/**
 * dsh-reasoning-level 宿主行（composition：`- id: reasoning-level; name: dsh-reasoning-level`）。
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
 * - 注册全部容错：settings.register / webServer.register（重复路由）失败
 *   降级为日志，任何单点失败不允许升级为 profile 挂载失败（boot 级爆炸半径）。
 * - 钩子全隔离：agent/request / llm/stream 的任何异常都被吸收，请求路径
 *   永远按"无本插件"语义继续。
 *
 * v0.3.0-v0.5.0 演进：
 * - P0-1 模型级默认全路径注入：`agent/request`（loop 请求）+ `llm/stream` 对未冻结
 *   请求（router 子代理 / session-title / compaction 等手建调用）直接写入
 *   `options.reasoningEffort`——覆盖此前"模型级默认只对 loop 生效"的缺口；
 * - P0-2 自愈降级：监听 `agent/request-error` 与流内 `error/aborted` finish，
 *   识别 `UNSUPPORTED_REASONING_EFFORT`（网关实测拒绝）→ 记入"实测黑名单"，
 *   后续注入自动跳过该档，统计/设置页明示；
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
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/**
 * 与 @deepseek-ai/dsh-home-paths 同源的解析规则，但零外部接缝：
 * $DSH_HOME 显式优先，缺省 ~/.dsh。解析失败返回 undefined（统计持久化降级
 * 为内存态，宿主与请求路径完全不受影响）。
 */
function resolveDshHomeSafe() {
  try {
    const env = typeof process !== 'undefined' && typeof process.env?.DSH_HOME === 'string' && process.env.DSH_HOME !== ''
      ? process.env.DSH_HOME
      : undefined
    return env !== undefined ? env : join(homedir(), '.dsh')
  } catch (error) {
    return undefined
  }
}

export const name = 'dsh-reasoning-level'

/** 硬依赖：settings seam、llm 注册表、timer（boot 重试）。webServer 可选（无则统计端点不可用）。 */
export const inject = ['settings', 'llm', 'timer']

const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
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
/** 统计环形缓冲上限与统计端点路径。 */
const STATS_LIMIT = 300
const STATS_PATH = '/reasoning-level-stats'
/** 统计聚合持久化文件（$DSH_HOME/storages/）。 */
const STATS_FILE = 'reasoning-level-stats.json'
const STATS_PERSIST_INTERVAL_MS = 5000
/** 单次实测请求超时（网关卡死不拖垮整轮探测）。 */
const PROBE_TIMEOUT_MS = 30000
/** 单模型多等级探测的并发数。 */
const PROBE_CONCURRENCY = 3

/** 统一设置项：llm-reasoning { enabled, level, models, syncDefaultAgent, purposes, statsPublic, probeBlacklist }，写入 $DSH_HOME/settings.yaml。 */
const NS = settingsNamespace('llm-reasoning')
const Config = z.object({
  enabled: z.boolean().default(true),
  level: z.union(LEVELS).default('high'),
  /** 模型级默认推理等级，键为 "provider/model"。 */
  models: z.dict(z.union(LEVELS), z.string()).default({}),
  /** 全局等级变化时同步默认 agent 模型的 reasoningEffort。 */
  syncDefaultAgent: z.boolean().default(false),
  /** 辅助调用（compaction / session-title）的独立默认等级，键为 purpose。 */
  purposes: z.dict(z.union(LEVELS), z.string()).default({}),
  /** 统计端点是否允许非回环 Host（LAN 部署显式开启；默认仅回环）。 */
  statsPublic: z.boolean().default(false),
  /** 一键探测固化的实测黑名单：provider/model -> 网关实测拒绝的等级（持久化，重启恢复）。 */
  probeBlacklist: z.dict(z.array(z.string()), z.string()).default({}),
  /**
   * 一键探测固化的实测能力声明：provider/model -> {等级: 线值}（持久化，重启后不再被生成表覆盖/升级）。
   * 线值词汇表来源：generatedEffortsFor —— zai/deepseek thinking 格式的 off 为 'disabled'、
   * openai 系为 null、其余为 'minimal'/'low'/'medium'/'high'/'max'。
   * 值 schema 用 z.string()：本版本 schemastery 对未 required 的 schema 直接放行 null，
   * 即等价于 "string | null"；同时明确拒绝非字符串值。旧写法
   * z.union([...LEVELS, null]) 中的 null 成员经 Schema.from(null) 编译为 any()，
   * 使 union 对任意值都通过——线值完全未校验（且一旦 schemastery 采用严格 union
   * 语义，'disabled' 将校验失败，zai/deepseek 路由的 probeEfforts 即无法持久化）。
   */
  probeEfforts: z.dict(z.dict(z.string(), z.string()), z.string()).default({}),
})

export function apply(ctx) {
  const settings = ctx.settings
  const llm = ctx.llm

  // 注册失败（如 HMR 重挂载导致命名空间冲突）只降级本插件，绝不让异常
  // 冒泡成 profile 挂载失败——那是整机级爆炸半径（v0.6.0 事故教训）。
  try {
    settings.register(NS, Config)
  } catch (error) {
    ctx.logger?.warn('dsh-reasoning-level: settings.register failed — plugin disabled for this mount')
    ctx.logger?.warn(error)
    return
  }

  // ---- 本插件写入位置的台账（区分“我写的”与“用户手改的”） ----
  let myRouteReasoning = new Map() // route -> level
  let myModelEfforts = new Map() // route + '\u0000' + modelId -> generated map
  let myDeepseekEffort // level this plugin set on llm-deepseek
  let originalDeepseek = null
  let running = false
  let queued = false
  /** provider/model -> 支持等级缓存（apply 时失效，注入前校验用）。 */
  let effortsCache = new Map()
  /** 实测黑名单：provider/model -> Set(网关实测拒绝的等级)。 */
  const blacklist = new Map()
  /** 一键探测固化的能力声明台账（route\0model -> map），与 llm-reasoning.probeEfforts 持久化同步。 */
  const verifiedEfforts = new Map()

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

  // 识别“本插件生成的”能力声明（当前版或旧版 5 键形状），以便自动升级而不是当作手写值
  function isGeneratedEfforts(map) {
    if (map === null || typeof map !== 'object' || Array.isArray(map)) return false
    const keys = Object.keys(map).sort().join(',')
    const current = GENERATED_KEYS.slice().sort().join(',')
    const legacy = ['high', 'low', 'medium', 'minimal', 'off'].join(',')
    return keys === current || keys === legacy
  }

  /** 推导路由的 thinking 格式（决定 off 线值）：zai-coding-cn 路由为 zai，openai 缺省检测。 */
  function thinkingFormatOf(route, api, profile) {
    if (profile?.compat && typeof profile.compat.thinkingFormat === 'string') return profile.compat.thinkingFormat
    if (api !== 'openai-completions') return undefined
    if (route === 'zai' || route === 'zai-coding-cn') return 'zai'
    if (route === 'deepseek' || route === 'deepseek-official') return 'deepseek'
    return undefined
  }

  // 读取 llm-pi-ai 命名空间的原始 user 节（结构等同设置文件）。
  // v0.6.0：不再请求 redactSecrets 脱敏视图——本插件运行在宿主侧而非 wire 面，
  // 原值往返才能保证 replace 写回无损；脱敏视图曾意味着任何 role('secret')
  // 字段都会在整节 replace 时被静默清空（该 schema 今天没有 secret 字段，
  // 但不能把安全性押在别人的 schema 演进上）。
  function rawSection(ns) {
    try {
      const entry = settings.describe().find((d) => d.ns === ns)
      return entry !== undefined && entry.user !== undefined ? clone(entry.user) : undefined
    } catch (error) {
      ctx.logger?.warn('dsh-reasoning-level: describe failed for ' + ns)
      ctx.logger?.warn(error)
      return undefined
    }
  }

  /** 查询并缓存一个模型支持的推理等级（adapter 不识别时返回 undefined）。 */
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
    effortsCache.set(key, efforts)
    return efforts
  }

  /** 从失败信息提取“实测拒绝”的等级（pi-ai 与 llm-deepseek 的错误文案/码）。 */
  function rejectionLevelOf(failure) {
    if (failure === undefined || failure === null) return undefined
    const text = (typeof failure.message === 'string' ? failure.message : '') + ' ' + (typeof failure.code === 'string' ? failure.code : '')
    const match = text.match(/reasoning effort "([^"]+)"/)
    if (match !== null) return match[1]
    return undefined
  }

  /** 记入实测黑名单：该 provider/model 拒绝该等级 → 后续注入跳过，并持久化（probeBlacklist）。 */
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
      ctx.logger?.warn(`dsh-reasoning-level: ${key} 实测拒绝 ${level}，已加入黑名单（注入将跳过）`)
      persistBlacklist()
    }
  }

  /** 把内存黑名单写入 llm-reasoning.probeBlacklist（settings.mutate set 整键替换）。 */
  function persistBlacklist() {
    try {
      const obj = {}
      for (const [key, levels] of blacklist) obj[key] = [...levels].sort()
      const current = settings.get(NS)
      if (current !== undefined && deepEq(current.probeBlacklist ?? {}, obj)) return
      settings.mutate(NS, [{ op: 'set', path: ['probeBlacklist'], value: obj }]).catch((error) => {
        ctx.logger?.warn('dsh-reasoning-level: blacklist persist failed')
        ctx.logger?.warn(error)
      })
    } catch (error) {
      ctx.logger?.warn('dsh-reasoning-level: blacklist persist failed')
      ctx.logger?.warn(error)
    }
  }

  /** 持久化实测固化的能力声明（merge 后整键 replace probeEfforts）。 */
  function persistProbeEfforts(providerModelMap) {
    try {
      const current = settings.get(NS)
      const prev = current !== undefined && typeof current.probeEfforts === 'object' && current.probeEfforts !== null ? clone(current.probeEfforts) : {}
      let changed = false
      for (const [providerModel, map] of Object.entries(providerModelMap)) {
        if (!deepEq(prev[providerModel], map)) changed = true
        prev[providerModel] = map
      }
      if (!changed) return
      settings.mutate(NS, [{ op: 'set', path: ['probeEfforts'], value: prev }]).catch((error) => {
        ctx.logger?.warn('dsh-reasoning-level: probeEfforts persist failed')
        ctx.logger?.warn(error)
      })
    } catch (error) {
      ctx.logger?.warn('dsh-reasoning-level: probeEfforts persist failed')
      ctx.logger?.warn(error)
    }
  }

  /** 启动时恢复持久化黑名单与实测能力声明（并集合并，幂等）。 */
  function hydrateBlacklist() {
    try {
      const cfg = settings.get(NS)
      if (cfg !== undefined && cfg.probeBlacklist !== undefined) {
        for (const [key, levels] of Object.entries(cfg.probeBlacklist)) {
          if (!Array.isArray(levels) || !key.includes('/')) continue
          let set = blacklist.get(key)
          if (set === undefined) {
            set = new Set()
            blacklist.set(key, set)
          }
          for (const level of levels) if (typeof level === 'string') set.add(level)
        }
      }
      if (cfg !== undefined && cfg.probeEfforts !== undefined) {
        for (const [providerModel, map] of Object.entries(cfg.probeEfforts)) {
          if (typeof map !== 'object' || map === null) continue
          const sep = providerModel.indexOf('/')
          if (sep <= 0) continue
          verifiedEfforts.set(providerModel.slice(0, sep) + '\u0000' + providerModel.slice(sep + 1), clone(map))
        }
      }
    } catch (error) { /* 黑名单/能力恢复失败不影响其余功能 */ }
  }

  async function applyLevel() {
    if (running) { queued = true; return }
    running = true
    try {
      effortsCache = new Map()
      const cfg = settings.get(NS)
      if (cfg === undefined) return
      const deepseek = settings.get(settingsNamespace('llm-deepseek'))
      if (originalDeepseek === null && deepseek !== undefined) originalDeepseek = clone(deepseek)
      if (cfg.enabled) {
        await applyPiAi(cfg.level)
        await applyDeepseek(deepseek, cfg.level)
        if (cfg.syncDefaultAgent === true) await applyDefaultAgent(cfg.level)
      } else {
        await revertPiAi()
        await revertDeepseek(deepseek)
      }
      ctx.logger?.info(`dsh-reasoning-level: applied, level=${cfg.level}, models-configured=${Object.keys(cfg.models ?? {}).length}, routes=${myRouteReasoning.size}, models=${myModelEfforts.size}`)
    } catch (error) {
      ctx.logger?.warn('dsh-reasoning-level: apply failed')
      ctx.logger?.warn(error)
    } finally {
      running = false
      if (queued) { queued = false; applyLevel() }
    }
  }

  // llm-pi-ai：从原始 user 节构建目标节，整体 replace
  // （settings.mutate 的路径 op 不支持数组索引，models[i] 必须整节替换）
  async function applyPiAi(level) {
    const resolved = settings.get(settingsNamespace('llm-pi-ai'))
    if (resolved === undefined) return
    const raw = rawSection('llm-pi-ai')
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
        if (isGeneratedEfforts(rawEfforts)) {
          // 本插件生成的声明（含旧版形状）：必要时升级为当前能力表（off 线值按协议）
          if (!deepEq(rawEfforts, effortsForRoute)) {
            rawProfile.models[i] = { ...model, reasoningEfforts: clone(effortsForRoute) }
            pendingModels.push({ key, efforts: clone(effortsForRoute) })
          }
          supportedByModel.push(GENERATED_LEVELS)
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
        await settings.replace(settingsNamespace('llm-pi-ai'), target)
        for (const entry of pendingModels) myModelEfforts.set(entry.key, entry.efforts)
        for (const [route, value] of pendingRoutes) {
          if (value === null) myRouteReasoning.delete(route)
          else myRouteReasoning.set(route, value)
        }
      } catch (error) {
        ctx.logger?.warn('dsh-reasoning-level: llm-pi-ai replace failed')
        ctx.logger?.warn(error)
      }
    }
  }

  async function applyDeepseek(deepseek, level) {
    if (deepseek === undefined) return
    if (deepseek.thinking === 'disabled') return
    try {
      if (DEEPSEEK_LEVELS.includes(level)) {
        if (deepseek.reasoningEffort !== level) {
          await settings.mutate(settingsNamespace('llm-deepseek'), [{ op: 'set', path: ['reasoningEffort'], value: level }])
          myDeepseekEffort = level
        }
      } else if (myDeepseekEffort !== undefined && deepseek.reasoningEffort === myDeepseekEffort) {
        const original = originalDeepseek !== null ? originalDeepseek.reasoningEffort : undefined
        const op = original !== undefined
          ? { op: 'set', path: ['reasoningEffort'], value: original }
          : { op: 'unset', path: ['reasoningEffort'] }
        await settings.mutate(settingsNamespace('llm-deepseek'), [op])
        myDeepseekEffort = undefined
      }
    } catch (error) {
      ctx.logger?.warn('dsh-reasoning-level: llm-deepseek mutate failed')
      ctx.logger?.warn(error)
    }
  }

  /** P1-2：syncDefaultAgent 开启时，把全局等级同步到默认 agent 模型的 reasoningEffort（校验支持）。 */
  async function applyDefaultAgent(level) {
    try {
      const adm = settings.get(settingsNamespace('agent-default-model'))
      if (adm === undefined || typeof adm.provider !== 'string' || typeof adm.model !== 'string') return
      if (adm.provider === '' || adm.model === '') return
      const efforts = await supportedEfforts(adm.provider, adm.model)
      if (efforts === undefined || efforts.length === 0) return
      if (!efforts.includes(level)) {
        ctx.logger?.warn(`dsh-reasoning-level: syncDefaultAgent skip — ${adm.provider}/${adm.model} does not support ${level}`)
        return
      }
      if (adm.reasoningEffort === level) return
      await settings.mutate(settingsNamespace('agent-default-model'), [{ op: 'set', path: ['reasoningEffort'], value: level }])
      ctx.logger?.info(`dsh-reasoning-level: synced default agent model to ${level}`)
    } catch (error) {
      ctx.logger?.warn('dsh-reasoning-level: syncDefaultAgent failed')
      ctx.logger?.warn(error)
    }
  }

  async function revertPiAi() {
    const raw = rawSection('llm-pi-ai')
    if (raw === undefined) return
    const target = clone(raw)
    const providers = target.providers ?? {}
    for (const [route, profile] of Object.entries(providers)) {
      const mineLevel = myRouteReasoning.get(route)
      if (mineLevel !== undefined && profile.reasoning === mineLevel) delete profile.reasoning
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
        await settings.replace(settingsNamespace('llm-pi-ai'), target)
      } catch (error) {
        ctx.logger?.warn('dsh-reasoning-level: revert llm-pi-ai failed')
        ctx.logger?.warn(error)
      }
    }
  }

  async function revertDeepseek(deepseek) {
    if (myDeepseekEffort === undefined || deepseek === undefined || deepseek.reasoningEffort !== myDeepseekEffort) return
    try {
      const original = originalDeepseek !== null ? originalDeepseek.reasoningEffort : undefined
      const op = original !== undefined
        ? { op: 'set', path: ['reasoningEffort'], value: original }
        : { op: 'unset', path: ['reasoningEffort'] }
      await settings.mutate(settingsNamespace('llm-deepseek'), [op])
    } catch (error) {
      ctx.logger?.warn('dsh-reasoning-level: revert llm-deepseek failed')
      ctx.logger?.warn(error)
    }
    myDeepseekEffort = undefined
  }

  ctx.on('settings/updated', (ns) => {
    if (ns === NS || ns === settingsNamespace('llm-pi-ai') || ns === settingsNamespace('llm-deepseek') || ns === settingsNamespace('agent-default-model')) applyLevel()
  })

  // ── P0-1 模型级默认注入（agent/request：loop 请求；llm/stream：未冻结手建调用）────
  ctx.on('agent/request', async (payload, next) => {
    const config = await next()
    try {
      if (config.reasoningEffort !== undefined) return config
      const cfg = settings.get(NS)
      if (cfg === undefined || cfg.enabled !== true) return config
      const perModel = (cfg.models ?? {})[config.provider + '/' + config.model]
      if (perModel === undefined) return config
      const efforts = await supportedEfforts(config.provider, config.model)
      if (efforts === undefined || efforts.length === 0) return config
      if (!efforts.includes(perModel)) return config
      if (isBlacklisted(config.provider, config.model, perModel)) return config
      return { ...config, reasoningEffort: perModel }
    } catch (error) {
      ctx.logger?.warn('dsh-reasoning-level: agent/request injection failed')
      ctx.logger?.warn(error)
      return config
    }
  })

  function isBlacklisted(provider, model, level) {
    const set = blacklist.get(provider + '/' + model)
    return set !== undefined && set.has(level)
  }

  // ── P0-2 自愈降级（agent/request-error 瀑布）──────────────────────────────
  ctx.on('agent/request-error', async (payload, next) => {
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
    recent.unshift(record)
    if (recent.length > STATS_LIMIT) recent.length = STATS_LIMIT
    return record
  }

  function settleRecord(record) {
    const key = record.provider + '/' + record.model
    let agg = perModelAgg.get(key)
    if (agg === undefined) {
      agg = { calls: 0, efforts: {}, reasoningTokens: 0, outputTokens: 0, reasoningChars: 0, durationMs: 0, errors: 0 }
      perModelAgg.set(key, agg)
    }
    agg.calls += 1
    const effortKey = record.effort ?? '(默认)'
    agg.efforts[effortKey] = (agg.efforts[effortKey] ?? 0) + 1
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

  ctx.on('llm/stream', (options, next) => {
    // 探测请求（一键探测 / 实测按钮发的 1-token ping）：不注入、不统计，
    // 完全不进入观测数据（probe 标记由本插件的探测路径设置）。
    if (options !== undefined && options.probe === true) return next()
    // P0-1：未冻结请求（router 子代理 / session-title / compaction 等手建调用）
    // 直接注入模型级默认；冻结的 loop 请求由 agent/request 注入，此处只读。
    try {
      if (!Object.isFrozen(options) && typeof options.reasoningEffort !== 'string') {
        const cfg = settings.get(NS)
        if (cfg !== undefined && cfg.enabled === true) {
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
      models[key] = {
        calls: agg.calls,
        efforts: agg.efforts,
        reasoningTokens: agg.reasoningTokens,
        outputTokens: agg.outputTokens,
        reasoningChars: agg.reasoningChars,
        durationMs: agg.durationMs,
        errors: agg.errors,
        errRate,
        rejected,
        highestUsed,
        suggestion: errRate >= 20 ? `错误率 ${errRate}% 偏高，建议降低等级` : (rejected.length > 0 ? `实测拒绝 ${rejected.join('/')}，建议用最高档 ${highestUsed ?? '（默认）'}` : undefined),
        _provider: provider,
        _model: model,
      }
    }
    const black = {}
    for (const [key, set] of blacklist) black[key] = [...set]
    return { since: statsSince, totalCalls, models, recent: recent.slice(0, 100), blacklist: black }
  }

  function rank(level) {
    const i = LEVELS.indexOf(level)
    return i < 0 ? -1 : i
  }

  /** 统计端点访问控制：默认仅回环 Host；statsPublic 时放行。 */
  function isLoopbackHost(req) {
    const host = (req.headers?.host ?? '').toLowerCase()
    if (host === '' || host === 'localhost') return true
    const name = host.split(':')[0]
    return name === '127.0.0.1' || name === '::1' || name === '[::1]' || name === 'localhost'
  }

  // 统计 + 测试请求端点（可选服务：无 webServer 的部署跳过，统计仍在收集）。
  // 注册失败（如迁移期旧行未清导致重复路由）只降级端点，不影响其余功能。
  const webServer = ctx.get('webServer')
  if (webServer !== undefined) {
    ctx.effect(() => {
      try {
        return webServer.register({
          kind: 'exact',
          path: STATS_PATH,
          handler: (req, res) => {
            // 访问控制：statsPublic=false 时仅回环 Host 可读；LAN 部署需显式开启。
            const cfg = settings.get(NS)
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
        ctx.logger?.warn(`dsh-reasoning-level: stats route registration failed (duplicate ${STATS_PATH}?) — stats endpoint disabled`)
        ctx.logger?.warn(error)
        return () => {}
      }
    }, 'dsh-reasoning-level: stats route')

    // ── 探测（实测）基础设施 ──────────────────────────────────────────────────
    // v0.7.0 核心修复：DSH 的 Message.content 必须是 ContentBlock 数组
    // （[{type:'text', text}]）。旧版发 `content: 'ping'` 字符串，适配器在
    // 组装阶段就抛 `content.some is not a function` —— 无论模型是否支持，
    // 每个等级都"失败"。这是"探测全部显示失败"的根因。
    const PROBE_MESSAGES = [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }]

    /** 单次实测：1-token 请求验证某 provider/model 某等级；`probe: true` 标记使统计旁路。 */
    async function probeLevelOnce(provider, model, effort) {
      const started = Date.now()
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
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
        const raw = rawSection('llm-pi-ai')
        const profile = raw !== undefined && raw.providers !== undefined ? raw.providers[provider] : undefined
        if (profile === undefined || !Array.isArray(profile.models)) return undefined
        const entry = profile.models.find((entry) => entry.id === model)
        return entry !== undefined ? entry.reasoningEfforts : undefined
      } catch (error) { return undefined }
    }

    /**
     * 探测一个模型的全部候选等级（并发 3）：目录能力 → 配置声明 → 标准档生成集。
     * 真的被网关拒绝的等级记入黑名单；限流/超时等其他错误只标记 blocked。
     */
    async function probeModelLevels(provider, model, levelsFilter) {
      let candidates = []
      try {
        const info = await llm.resolveModelInfo(provider, model)
        if (info !== undefined && info.reasoning !== undefined && Array.isArray(info.reasoning.efforts)) {
          candidates = info.reasoning.efforts.map((entry) => entry.id).filter((id) => LEVELS.includes(id))
        }
      } catch (error) { candidates = [] }
      if (candidates.length === 0) {
        const declared = declaredEffortsOf(provider, model)
        if (declared !== undefined) candidates = supportedLevels(declared)
      }
      if (candidates.length === 0) candidates = GENERATED_LEVELS.slice()
      if (Array.isArray(levelsFilter) && levelsFilter.length > 0) {
        candidates = candidates.filter((level) => levelsFilter.includes(level))
      }
      const key = provider + '/' + model
      if (candidates.length === 0) {
        return { provider, model, key, levels: {}, working: [], rejected: [], blocked: [], error: 'no candidate levels' }
      }
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
        } else if (result.code === 'UNSUPPORTED_REASONING_EFFORT' || rejectionLevelOf(result) !== undefined) {
          rejected.push(level)
          markRejected(provider, model, level)
        } else {
          blocked.push(level)
        }
      }
      return { provider, model, key, levels: results, working, rejected, blocked }
    }

    /** 应用探测结果：把实测可用的等级固化进 llm-pi-ai 模型能力声明（用户手写声明不动）。 */
    async function applyProbeResults(results) {
      const raw = rawSection('llm-pi-ai')
      if (raw === undefined) return { writes: 0, skipped: [] }
      const target = clone(raw)
      const entries = new Map()
      for (const [route, profile] of Object.entries(target.providers ?? {})) {
        if (!Array.isArray(profile.models)) continue
        for (const model of profile.models) entries.set(route + '\u0000' + model.id, model)
      }
      let writes = 0
      const skipped = []
      const pendingVerified = {}
      for (const result of Array.isArray(results) ? results : []) {
        if (result === null || result === undefined || typeof result.provider !== 'string' || typeof result.model !== 'string') continue
        const entry = entries.get(result.provider + '\u0000' + result.model)
        if (entry === undefined) {
          skipped.push({ key: result.key, reason: 'not-in-pi-ai-config' })
          continue
        }
        const working = (Array.isArray(result.working) ? result.working : []).filter((level) => GENERATED_LEVELS.includes(level))
        if (working.length === 0) {
          skipped.push({ key: result.key, reason: 'no-working-levels' })
          continue
        }
        const current = entry.reasoningEfforts
        const mine = myModelEfforts.get(result.provider + '\u0000' + result.model)
        const mineLike = mine !== undefined && current !== undefined && deepEq(current, mine)
        const pinned = verifiedEfforts.get(result.provider + '\u0000' + result.model)
        const pinnedLike = pinned !== undefined && current !== undefined && deepEq(current, pinned)
        // 只固化"本插件生成 / 已在台账 / 未声明"的能力；用户手写的声明永远不覆盖
        if (current !== undefined && !isGeneratedEfforts(current) && !mineLike && !pinnedLike) {
          skipped.push({ key: result.key, reason: 'user-declared' })
          continue
        }
        const profile = target.providers[result.provider]
        const api = typeof profile.api === 'string' ? profile.api : 'openai-completions'
        const generated = generatedEffortsFor(thinkingFormatOf(result.provider, api, profile))
        const verified = {}
        for (const level of GENERATED_LEVELS) {
          if (working.includes(level) && generated[level] !== undefined) verified[level] = generated[level]
        }
        if (Object.keys(verified).length === 0) {
          skipped.push({ key: result.key, reason: 'no-working-levels' })
          continue
        }
        if (current !== undefined && deepEq(verified, current)) {
          skipped.push({ key: result.key, reason: 'already-verified' })
          continue
        }
        entry.reasoningEfforts = verified
        // 钉入台账（与 llm-reasoning.probeEfforts 持久化）：实测即真值，不再被生成表升级覆盖；
        // 与 myModelEfforts 不同——关闭开关（enabled:false）不会撤销这些已固化的声明。
        verifiedEfforts.set(result.provider + '\u0000' + result.model, clone(verified))
        pendingVerified[result.provider + '/' + result.model] = clone(verified)
        writes += 1
      }
      if (writes > 0 && !deepEq(target, raw)) {
        try {
          await settings.replace(settingsNamespace('llm-pi-ai'), target)
          persistProbeEfforts(pendingVerified)
        } catch (error) {
          ctx.logger?.warn('dsh-reasoning-level: probe apply replace failed')
          ctx.logger?.warn(error)
          return { writes: 0, skipped, error: error !== undefined && error.message !== undefined ? error.message : String(error) }
        }
      }
      return { writes, skipped }
    }

    function readBody(req) {
      return new Promise((resolve) => {
        let body = ''
        req.on('data', (chunk) => { body += chunk })
        req.on('end', () => resolve(body))
        req.on('error', () => resolve(body))
      })
    }

    async function parseProbeInput(req) {
      const cfg = settings.get(NS)
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
    ctx.effect(() => {
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
              if (!result.ok && rejected) markRejected(provider, model, result.code !== undefined ? effort : rejectionLevelOf(result))
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
        ctx.logger?.warn(`dsh-reasoning-level: stats test route registration failed (duplicate ${STATS_PATH}/test?) — test endpoint disabled`)
        ctx.logger?.warn(error)
        return () => {}
      }
    }, 'dsh-reasoning-level: stats test route')

    // v0.7.0 一键探测：POST /reasoning-level-stats/probe {provider, model, levels?}
    // —— 探测单个模型全部候选等级（并发 3），网关实测拒绝自动入黑名单。
    ctx.effect(() => {
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
              sendJson(res, await probeModelLevels(provider, model, Array.isArray(input.levels) ? input.levels : undefined))
            }).catch((error) => {
              try { sendJson(res, { ok: false, error: error !== undefined && error.message !== undefined ? error.message : String(error) }) } catch (error2) { /* ignore */ }
            })
          },
        })
      } catch (error) {
        ctx.logger?.warn(`dsh-reasoning-level: probe route registration failed (duplicate ${STATS_PATH}/probe?) — probe endpoint disabled`)
        ctx.logger?.warn(error)
        return () => {}
      }
    }, 'dsh-reasoning-level: probe route')

    // v0.7.0 固化配置：POST /reasoning-level-stats/probe/apply {results: [...]}
    // —— 把实测可用的等级写回 llm-pi-ai 能力声明（不覆盖用户手写声明）。
    ctx.effect(() => {
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
              sendJson(res, await applyProbeResults(input.results))
            }).catch((error) => {
              try { sendJson(res, { ok: false, error: error !== undefined && error.message !== undefined ? error.message : String(error) }) } catch (error2) { /* ignore */ }
            })
          },
        })
      } catch (error) {
        ctx.logger?.warn(`dsh-reasoning-level: probe apply route registration failed (duplicate ${STATS_PATH}/probe/apply?) — apply endpoint disabled`)
        ctx.logger?.warn(error)
        return () => {}
      }
    }, 'dsh-reasoning-level: probe apply route')
  }

  // ---- 启动即应用；llm-pi-ai 未就绪时短暂重试 ----
  let retries = 0
  function boot() {
    hydrateBlacklist()
    applyLevel().then(() => {
      if (settings.get(settingsNamespace('llm-pi-ai')) === undefined && retries < 5) {
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
  try {
    boot()
  } catch (error) {
    ctx.logger?.warn('dsh-reasoning-level: boot failed')
    ctx.logger?.warn(error)
  }
}
