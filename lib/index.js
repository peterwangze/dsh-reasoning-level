/**
 * dsh-reasoning-level 宿主行（composition：`- id: reasoning-level; name: dsh-reasoning-level`）。
 *
 * v0.3.0 演进：
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
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export const name = 'dsh-reasoning-level'

/** 硬依赖：settings seam、llm 注册表、timer（boot 重试）。webServer 可选（无则统计端点不可用）。 */
export const inject = ['settings', 'llm', 'timer']

const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const DEEPSEEK_LEVELS = ['off', 'low', 'high', 'max']
// 手写模型（无目录能力）自动声明的能力表：openai 系 reasoning_effort 线值。
// max 原样发送（智谱 bigmodel/z.ai 与聚合网关实测接受）；xhigh 无标准线值故不声明。
const GENERATED_EFFORTS = { off: null, minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', max: 'max' }
const GENERATED_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'max']
/** 统计环形缓冲上限与统计端点路径。 */
const STATS_LIMIT = 300
const STATS_PATH = '/reasoning-level-stats'
/** 统计聚合持久化文件（$DSH_HOME/storages/）。 */
const STATS_FILE = 'reasoning-level-stats.json'
const STATS_PERSIST_INTERVAL_MS = 5000

/** 统一设置项：llm-reasoning { enabled, level, models, syncDefaultAgent }，写入 $DSH_HOME/settings.yaml。 */
const NS = settingsNamespace('llm-reasoning')
const Config = z.object({
  enabled: z.boolean().default(true),
  level: z.union(LEVELS).default('high'),
  /** 模型级默认推理等级，键为 "provider/model"。 */
  models: z.dict(z.union(LEVELS), z.string()).default({}),
  /** 全局等级变化时同步默认 agent 模型的 reasoningEffort。 */
  syncDefaultAgent: z.boolean().default(false),
})

export function apply(ctx) {
  const settings = ctx.settings
  const llm = ctx.llm

  settings.register(NS, Config)

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
    const current = Object.keys(GENERATED_EFFORTS).sort().join(',')
    const legacy = ['high', 'low', 'medium', 'minimal', 'off'].join(',')
    return keys === current || keys === legacy
  }

  // 读取 llm-pi-ai 命名空间的原始 user 节（describe 脱敏、结构等同设置文件）
  function rawSection(ns) {
    try {
      const entry = settings.describe({ redactSecrets: true }).find((d) => d.ns === ns)
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

  /** 记入实测黑名单：该 provider/model 拒绝该等级 → 后续注入跳过。 */
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
    }
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
      const supportedByModel = []
      for (let i = 0; i < rawProfile.models.length; i++) {
        const model = rawProfile.models[i]
        const key = route + '\u0000' + model.id
        const mine = myModelEfforts.get(key)
        const rawEfforts = model.reasoningEfforts
        if (mine !== undefined && deepEq(rawEfforts, mine)) {
          supportedByModel.push(GENERATED_LEVELS)
          continue
        }
        if (isGeneratedEfforts(rawEfforts)) {
          // 本插件生成的声明（含旧版形状）：必要时升级为当前能力表
          if (!deepEq(rawEfforts, GENERATED_EFFORTS)) {
            rawProfile.models[i] = { ...model, reasoningEfforts: clone(GENERATED_EFFORTS) }
            pendingModels.push({ key, efforts: clone(GENERATED_EFFORTS) })
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
          rawProfile.models[i] = { ...model, reasoningEfforts: clone(GENERATED_EFFORTS) }
          pendingModels.push({ key, efforts: clone(GENERATED_EFFORTS) })
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
  const statsPath = join(resolveDshHome(), 'storages', STATS_FILE)

  // 启动时恢复持久化的聚合
  try {
    if (existsSync(statsPath)) {
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
      mkdirSync(join(resolveDshHome(), 'storages'), { recursive: true })
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
    // P0-1：未冻结请求（router 子代理 / session-title / compaction 等手建调用）
    // 直接注入模型级默认；冻结的 loop 请求由 agent/request 注入，此处只读。
    try {
      if (!Object.isFrozen(options) && typeof options.reasoningEffort !== 'string') {
        const cfg = settings.get(NS)
        if (cfg !== undefined && cfg.enabled === true) {
          const perModel = (cfg.models ?? {})[options.provider + '/' + options.model]
          if (perModel !== undefined) {
            const efforts = effortsCache.get(options.provider + '/' + options.model)
            if (efforts !== undefined && efforts.length > 0 && efforts.includes(perModel) && !isBlacklisted(options.provider, options.model, perModel)) {
              options.reasoningEffort = perModel
            }
          }
        }
      }
    } catch (error) { /* 注入失败不影响请求 */ }

    const record = beginRecord(options)
    const stream = next()
    return (async function* () {
      try {
        for await (const chunk of stream) {
          try {
            if (chunk.type === 'usage' && chunk.usage !== undefined) {
              if (typeof chunk.usage.reasoningTokens === 'number') record.rt = chunk.usage.reasoningTokens
              if (typeof chunk.usage.outputTokens === 'number') record.ot = chunk.usage.outputTokens
              if (typeof chunk.usage.inputTokens === 'number') record.it = chunk.usage.inputTokens
            } else if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
              record.rc = (record.rc ?? 0) + chunk.text.length
            } else if (chunk.type === 'finish' && chunk.reason !== undefined) {
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
        if (record.finish === null) {
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
    const black = {}
    for (const [key, set] of blacklist) black[key] = [...set]
    return { since: statsSince, totalCalls, models, recent: recent.slice(0, 100), blacklist: black }
  }

  // 统计端点（可选服务：无 webServer 的部署跳过，统计仍在收集）
  const webServer = ctx.get('webServer')
  if (webServer !== undefined) {
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: STATS_PATH,
      handler: (_req, res) => {
        const body = JSON.stringify(statsSnapshot())
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(body)
      },
    }), 'dsh-reasoning-level: stats route')
  }

  // ---- 启动即应用；llm-pi-ai 未就绪时短暂重试 ----
  let retries = 0
  function boot() {
    applyLevel().then(() => {
      if (settings.get(settingsNamespace('llm-pi-ai')) === undefined && retries < 5) {
        retries += 1
        ctx.timeout(boot, 1000)
      }
    })
  }
  boot()
}
