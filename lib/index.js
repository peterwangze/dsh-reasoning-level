/**
 * dsh-reasoning-level 宿主行（composition：`- id: reasoning-level; name: dsh-reasoning-level`）。
 *
 * 一个行同时是：
 * - 宿主插件：注册 `llm-reasoning` settings 命名空间（全局开关 + 默认等级 + 模型级默认），
 *   动态应用到所有模型——写入 llm-pi-ai（手写模型能力声明 + 路由默认等级）与
 *   llm-deepseek（reasoningEffort）；
 * - 观测面：
 *   · `agent/request` waterfall：模型级默认注入点（会话显式选择 > 模型级 > 全局）；
 *   · `llm/stream` waterfall（只读）：实时调用统计——每次模型调用的实际推理等级、
 *     思考/输出 tokens、结束原因；环形缓冲 + 聚合；
 *   · webServer 路由 `/reasoning-level-stats`：浏览器侧统计面板轮询的数据源。
 * - 浏览器侧插件（dual-face）：「设置 → 统一推理等级」页面（等级配置 + 模型级默认 +
 *   实时调用统计）。
 *
 * 等级优先级（高到低）：会话/模型选择器显式选择 > 模型级默认（models 配置）>
 * 路由默认（全局 level，仅全部模型支持时写入）> 服务商自身默认。
 *
 * @module dsh-reasoning-level
 */
import z from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'

export const name = 'dsh-reasoning-level'

/** 硬依赖：settings seam、llm 注册表、timer（boot 重试）。webServer 可选（无则统计面板不可用）。 */
export const inject = ['settings', 'llm', 'timer']

const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const DEEPSEEK_LEVELS = ['off', 'low', 'high', 'max']
// 手写模型（无目录能力）自动声明的能力表：openai 系 reasoning_effort 线值。
// max 原样发送（智谱 bigmodel/z.ai 与聚合网关实测接受）；xhigh 无标准线值故不声明。
const GENERATED_EFFORTS = { off: null, minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', max: 'max' }
const GENERATED_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'max']
/** 统计环形缓冲上限与 webServer 统计端点。 */
const STATS_LIMIT = 300
const STATS_PATH = '/reasoning-level-stats'

/** 统一设置项：llm-reasoning { enabled, level, models }，写入 $DSH_HOME/settings.yaml。 */
const NS = settingsNamespace('llm-reasoning')
const Config = z.object({
  enabled: z.boolean().default(true),
  level: z.union(LEVELS).default('high'),
  /** 模型级默认推理等级，键为 "provider/model"。 */
  models: z.dict(z.union(LEVELS), z.string()).default({}),
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
    if (ns === NS || ns === settingsNamespace('llm-pi-ai') || ns === settingsNamespace('llm-deepseek')) applyLevel()
  })

  // ── 模型级默认注入（agent/request waterfall）──────────────────────────
  // 优先级：会话显式选择（提案已带 reasoningEffort）> 模型级默认 > 路由默认。
  // 注入的等级必须被该模型支持，否则放弃注入（保持路由默认/服务商默认）。
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
      if (!efforts.includes(perModel)) {
        ctx.logger?.warn(`dsh-reasoning-level: per-model default "${perModel}" for ${config.provider}/${config.model} unsupported; keeping route default`)
        return config
      }
      return { ...config, reasoningEffort: perModel }
    } catch (error) {
      ctx.logger?.warn('dsh-reasoning-level: agent/request injection failed')
      ctx.logger?.warn(error)
      return config
    }
  })

  // ── 实时调用统计（llm/stream waterfall，只读）─────────────────────────
  const recent = [] // 新在前
  const perModel = new Map() // 'provider/model' -> {calls, efforts: Map, reasoningTokens, outputTokens, errors}
  let totalCalls = 0
  const statsSince = Date.now()

  function beginRecord(options) {
    totalCalls += 1
    const record = {
      t: Date.now(),
      provider: typeof options.provider === 'string' ? options.provider : '',
      model: typeof options.model === 'string' ? options.model : '',
      effort: typeof options.reasoningEffort === 'string' ? options.reasoningEffort : null,
      rt: null, // reasoningTokens
      ot: null, // outputTokens
      it: null, // inputTokens
      finish: null,
    }
    recent.unshift(record)
    if (recent.length > STATS_LIMIT) recent.length = STATS_LIMIT
    return record
  }

  function settleRecord(record) {
    const key = record.provider + '/' + record.model
    let agg = perModel.get(key)
    if (agg === undefined) {
      agg = { calls: 0, efforts: {}, reasoningTokens: 0, outputTokens: 0, errors: 0 }
      perModel.set(key, agg)
    }
    agg.calls += 1
    const effortKey = record.effort ?? '(默认)'
    agg.efforts[effortKey] = (agg.efforts[effortKey] ?? 0) + 1
    if (record.rt !== null) agg.reasoningTokens += record.rt
    if (record.ot !== null) agg.outputTokens += record.ot
    if (record.finish === 'error' || record.finish === 'aborted') agg.errors += 1
  }

  ctx.on('llm/stream', (options, next) => {
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
            } else if (chunk.type === 'finish' && chunk.reason !== undefined) {
              record.finish = typeof chunk.reason.kind === 'string' ? chunk.reason.kind : null
              settleRecord(record)
            }
          } catch (error) { /* 统计解析失败不影响转发 */ }
          yield chunk
        }
      } finally {
        if (record.finish === null) {
          record.finish = 'aborted'
          settleRecord(record)
        }
      }
    })()
  })

  function statsSnapshot() {
    const models = {}
    for (const [key, agg] of perModel) {
      models[key] = {
        calls: agg.calls,
        efforts: agg.efforts,
        reasoningTokens: agg.reasoningTokens,
        outputTokens: agg.outputTokens,
        errors: agg.errors,
      }
    }
    return { since: statsSince, totalCalls, models, recent: recent.slice(0, 100) }
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
