/**
 * agent-selection — 推理强度「会话选择」执行面（MAINT-042 / DSH 0.2.2）。
 *
 * 为什么需要独立模块（设计边界，BM-5）：
 * 0.2.2 的 `dsh-agent-loop` 在 `preStep()` 读取 `agent.model.current()` 之后
 * 才发 `agent/request` 瀑布；瀑布里再改 `reasoningEffort` 会被守卫拒绝
 * （`use agent.model.select() before step preparation`）。因此「全局默认等级」
 * 必须在步骤准备**之前**落到 `agent.model.select()`——这是与 settings 配置同步
 * 完全不同的执行面，独立成模块以便纯单测、注入假 agent、未来宿主再变时只改
 * 这一个文件。
 *
 * 本模块不 import 任何宿主包（零运行时依赖红线）：事件/服务/方法名由
 * `lib/index.js` 从 `lib/host-compat.js` 取常量后注入；这里只做策略与执行。
 *
 * 策略（用户可感知语义）：
 * - root agent（`agents.roots()`）首次出现 / 换 provider·model / 全局目标变化：
 *   对齐到 `config.models[provider/model] ?? config.level`；
 * - root agent 同一路由后续回合：若用户用模型选择器显式换了 effort，尊重用户
 *   选择（不每回合强制改回全局值）；
 * - 子 agent / 被 router 托管的 agent：只在没有显式 effort 时补缺省，绝不
 *   覆盖调用方预设；
 * - 能力未知（宿主还没有 resolve 出该模型 effort 列表）：先异步预热，当前回合
 *   不猜；预热返回时若用户已改选择则不覆盖。
 */

/** @typedef {{ action: 'select' | 'skip' | 'defer', effort?: string, reason: string }} EffortPlan */

/**
 * 解析某 provider/model 应落到的目标等级。纯函数。
 *
 * @param {unknown} config 插件自身配置（`configOf(NS)` 的 value 投影）
 * @param {unknown} provider
 * @param {unknown} model
 * @returns {string | undefined}
 */
export function targetEffortFor(config, provider, model) {
  if (config === null || typeof config !== 'object' || config.enabled !== true) return undefined
  if (typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '') return undefined
  const models = config.models
  if (models !== null && typeof models === 'object' && !Array.isArray(models)) {
    const perModel = models[provider + '/' + model]
    if (typeof perModel === 'string' && perModel !== '') return perModel
  }
  return typeof config.level === 'string' && config.level !== '' ? config.level : undefined
}

/**
 * 纯策略：给定当前选择/能力/agent 类型与已见状态，决定是否 select。
 *
 * `seen` 是同一 agent 上一次「已对齐」的路由+目标（WeakMap 值），用于区分
 * 首次出现与用户后续手选；不要把它当持久状态。
 * `excluded === true` 表示目标等级已被经验黑名单拒绝（MAINT-013 自愈面）：
 * 按 unsupported 同型跳过，且**不落 seen**——后续设置改到非黑名单档仍会对齐。
 *
 * @param {{ config?: unknown, selection?: unknown, supported?: string[] | undefined, isRoot?: boolean, seen?: { routeKey?: string, target?: string } | undefined, excluded?: boolean }} input
 * @returns {EffortPlan}
 */
export function planEffortSelection(input = {}) {
  const { config, selection, supported, isRoot, seen, excluded } = input
  const provider = selection?.provider
  const model = selection?.model
  if (typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '') {
    return { action: 'skip', reason: 'no-route' }
  }
  const target = targetEffortFor(config, provider, model)
  if (target === undefined) return { action: 'skip', reason: 'no-target' }
  if (excluded === true) return { action: 'skip', reason: 'excluded', effort: target }
  if (!Array.isArray(supported)) return { action: 'defer', reason: 'capability-unknown' }
  if (!supported.includes(target)) return { action: 'skip', reason: 'unsupported', effort: target }

  const routeKey = provider + '/' + model
  const current = selection?.reasoningEffort
  if (isRoot === true) {
    if (seen === undefined) return { action: 'select', reason: 'first-sight', effort: target }
    if (seen.routeKey !== routeKey) return { action: 'select', reason: 'route-change', effort: target }
    if (seen.target !== target) return { action: 'select', reason: 'target-change', effort: target }
    if (current === target) return { action: 'skip', reason: 'aligned', effort: target }
    return { action: 'skip', reason: 'user-choice', effort: target }
  }
  if (current === undefined) return { action: 'select', reason: 'missing-effort', effort: target }
  return { action: 'skip', reason: 'explicit-effort', effort: target }
}

function routeKeyOf(selection) {
  return selection.provider + '/' + selection.model
}

function errorText(error) {
  return String(error?.message ?? error)
}

/**
 * 创建执行器。所有方法同步、吞噬宿主对象异常（只上报 health/日志），
 * 因为调用点是 `agent/created` / `agent/status` 的宿主同步分发路径。
 *
 * @param {{
 *   getConfig?: () => unknown,
 *   syncEfforts?: (provider: string, model: string) => string[] | undefined,
 *   resolveEfforts?: (provider: string, model: string) => Promise<string[] | undefined> | string[] | undefined,
 *   isRoot?: (agent: unknown) => boolean,
 *   isExcluded?: (provider: string, model: string, effort: string) => boolean,
 *   listAgents?: () => unknown[],
 *   logger?: { info?: (...args: unknown[]) => void, warn?: (...args: unknown[]) => void },
 *   onHealth?: (patch: { mode?: 'native' | 'legacy' | 'unknown', lastTarget?: string | null, lastError?: string | null }) => void,
 * }} [options]
 */
export function createAgentEffortEnforcer(options = {}) {
  const opts = options ?? {}
  /** @type {WeakMap<object, { routeKey: string, target: string }>} */
  const states = new WeakMap()
  /** @type {WeakMap<object, string>} agent -> route warming */
  const warming = new WeakMap()
  let mode = 'unknown'

  const report = (patch) => {
    try { opts.onHealth?.(patch) } catch { /* host health surface is best-effort */ }
  }
  const logInfo = (line) => {
    try { if (typeof opts.logger?.info === 'function') opts.logger.info(line) } catch { /* logging must never break a turn */ }
  }
  const logWarn = (line, error) => {
    try { if (typeof opts.logger?.warn === 'function') opts.logger.warn(line, error) } catch { /* same */ }
  }
  const readConfig = () => {
    try { return opts.getConfig?.() } catch { return undefined }
  }
  const readSelection = (agent) => {
    try { return agent?.model?.current?.() } catch { return undefined }
  }
  const readRoot = (agent) => {
    try { return typeof opts.isRoot === 'function' ? opts.isRoot(agent) === true : true } catch { return true }
  }
  const readSync = (provider, model) => {
    try {
      const value = opts.syncEfforts?.(provider, model)
      return Array.isArray(value) && value.length > 0 ? value : undefined
    } catch {
      return undefined
    }
  }
  // MAINT-013 自愈面接入（REVIEW-MAINT-042-R0 F1）：经验黑名单拒绝过的
  // (provider, model, effort) 不再 select——否则声明档被网关拒绝时每回合
  // 反复失败且 seen 误锁 'aligned'，失去 0.2.1 注入路径的「拒绝即跳过」语义。
  const isExcluded = (provider, model, effort) => {
    try { return opts.isExcluded?.(provider, model, effort) === true } catch { return false }
  }

  function select(agent, selection, effort, reason) {
    try {
      agent.model.select({
        provider: selection.provider,
        model: selection.model,
        reasoningEffort: effort,
      })
      states.set(agent, { routeKey: routeKeyOf(selection), target: effort })
      mode = 'native'
      report({ mode: 'native', lastTarget: effort, lastError: null })
      logInfo(`[reasoning-level] agent ${agent?.id ?? '?'} -> ${effort} (${reason})`)
      return true
    } catch (error) {
      mode = 'native'
      report({ mode: 'native', lastTarget: effort, lastError: errorText(error) })
      logWarn(`[reasoning-level] agent ${agent?.id ?? '?'} select ${effort} failed`, error)
      return false
    }
  }

  function warm(agent, selection, root) {
    const routeKey = routeKeyOf(selection)
    if (warming.get(agent) === routeKey) return
    if (typeof opts.resolveEfforts !== 'function') return
    warming.set(agent, routeKey)
    const baseline = selection.reasoningEffort
    Promise.resolve()
      .then(() => opts.resolveEfforts(selection.provider, selection.model))
      .then((supported) => {
        if (warming.get(agent) === routeKey) warming.delete(agent)
        if (!Array.isArray(supported) || supported.length === 0) return
        const current = readSelection(agent)
        if (current === undefined) return
        if (current.provider !== selection.provider || current.model !== selection.model) return
        // 预热期间用户若已显式改 effort：基线不再相等，绝不覆盖。
        if (current.reasoningEffort !== baseline) return
        const config = readConfig()
        const plan = planEffortSelection({
          config,
          selection: current,
          supported,
          isRoot: root,
          seen: states.get(agent),
          excluded: isExcluded(current.provider, current.model, targetEffortFor(config, current.provider, current.model)),
        })
        if (plan.action === 'select') select(agent, current, plan.effort, plan.reason)
        else if (plan.action === 'skip' && (plan.reason === 'aligned' || plan.reason === 'user-choice')) {
          states.set(agent, { routeKey: routeKeyOf(current), target: plan.effort })
        }
      })
      .catch((error) => {
        if (warming.get(agent) === routeKey) warming.delete(agent)
        mode = 'native'
        report({ mode: 'native', lastError: errorText(error) })
        logWarn(`[reasoning-level] resolve efforts ${routeKey} failed`, error)
      })
  }

  function evaluate(agent) {
    try {
      if (agent === null || typeof agent !== 'object') return
      const model = agent.model
      if (model === null || typeof model !== 'object'
        || typeof model.select !== 'function' || typeof model.current !== 'function') {
        mode = 'legacy'
        report({ mode: 'legacy' })
        return
      }
      const selection = readSelection(agent)
      if (selection === null || typeof selection !== 'object') return
      if (typeof selection.provider !== 'string' || selection.provider === ''
        || typeof selection.model !== 'string' || selection.model === '') return
      const config = readConfig()
      if (config === null || typeof config !== 'object') return
      const root = readRoot(agent)
      const supported = readSync(selection.provider, selection.model)
      if (supported === undefined) {
        mode = 'native'
        report({ mode: 'native' })
        warm(agent, selection, root)
        return
      }
      const plan = planEffortSelection({
        config,
        selection,
        supported,
        isRoot: root,
        seen: states.get(agent),
        excluded: isExcluded(selection.provider, selection.model, targetEffortFor(config, selection.provider, selection.model)),
      })
      if (plan.action === 'select') {
        select(agent, selection, plan.effort, plan.reason)
        return
      }
      if (plan.action === 'skip' && (plan.reason === 'aligned' || plan.reason === 'user-choice')) {
        states.set(agent, { routeKey: routeKeyOf(selection), target: plan.effort })
      }
      mode = 'native'
      report({ mode: 'native' })
    } catch (error) {
      mode = 'native'
      report({ mode: 'native', lastError: errorText(error) })
      logWarn('[reasoning-level] agent selection evaluation failed', error)
    }
  }

  return {
    /** `agent/created` payload（0.2.2 可选提前路径；0.2.1 无 select 时 no-op）。 */
    created(payload) {
      try { evaluate(payload?.agent) } catch (error) { logWarn('[reasoning-level] created hook failed', error) }
    },
    /** `agent/status` payload；只在 running 时执行（同步早于 preStep）。 */
    status(payload) {
      try {
        if (payload?.status !== 'running') return
        evaluate(payload.agent)
      } catch (error) {
        logWarn('[reasoning-level] status hook failed', error)
      }
    },
    /** settings 就绪 / 变更后，对已存在 agent 补一次首见对齐。 */
    sweep() {
      let agents = []
      try { agents = opts.listAgents?.() ?? [] } catch { agents = [] }
      if (!Array.isArray(agents)) return
      for (const agent of agents) {
        try { evaluate(agent) } catch (error) { logWarn('[reasoning-level] sweep failed', error) }
      }
    },
    /** 最近一次上报的执行面模式：native(0.2.2) / legacy(0.2.1) / unknown。 */
    mode() {
      return mode
    },
  }
}
