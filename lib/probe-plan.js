/**
 * probe-plan — 增量探测决策（FEAT-009）。
 *
 * 职责边界（与 model-capabilities / param-registry 同族的纯函数单点约束）：
 * 零 import、零宿主依赖。本模块只回答「哪些模型需要重测、哪些沿用上次结果」——
 * 不读设置、不发请求、不写盘。lib/index.js 负责读 llm-reasoning.lastProbe 并
 * 调用 planProbe 暴露计划端点；lib/client.js 负责按计划编排实测与固化。
 *
 * 判定语义（probeEntryNeedsProbe，顺序敏感）：
 *  1. 无条目 / 非普通对象 / 无任何探测记录 → never-probed（从未探测）；
 *  2. entry.error 为非空字符串 → probe-error（前向兼容守卫：面向外部/历史写入的
 *     error 字段；v0.11.1 起生产路径不再写入带 error 的 lastProbe 条目）；
 *  3. blocked 非空 → blocked-levels（存在网关阻塞档位，结果未收敛）；
 *  4. persisted === 'persist-error' → persist-error（上次写回失败）；
 *  5. persisted === 'pending-apply' → pending-apply（声明待固化）；
 *  6. 其余 → settled（定论：converged / no-change-already-correct / written /
 *     skipped:official-adapter / skipped:not-in-pi-ai-config / skipped:no-working）。
 *
 * planProbe 的额外规则：
 *  - force=true 时跳过上述判定，全部按 forced 重测（「全量重探」兜底）；
 *  - settled 但 persisted === 'skipped:not-in-pi-ai-config' 且 isConfigured(provider,
 *    model) === true（模型此后被加入 llm-pi-ai 配置）→ config-changed（必须重测并
 *    固化）；skipped:official-adapter 不在此规则内（官方适配器不写 pi-ai 声明）。
 *
 * @module dsh-reasoning-level/probe-plan
 */

/** 探测计划判定原因（端点与测试共用的字符串单一来源；客户端模块不 import 本模块）。 */
export const PROBE_PLAN_REASONS = Object.freeze({
  NEVER_PROBED: 'never-probed',
  BLOCKED_LEVELS: 'blocked-levels',
  PROBE_ERROR: 'probe-error',
  PERSIST_ERROR: 'persist-error',
  PENDING_APPLY: 'pending-apply',
  CONFIG_CHANGED: 'config-changed',
  SETTLED: 'settled',
  FORCED: 'forced',
})

/** 普通对象判定（排除 null / 数组；与宿主设置数据形状同源）。 */
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/** 只保留字符串元素的数组快照；非数组/缺失 → []。 */
const stringListOf = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [])

/** 递归复制普通对象/数组（快照隔离，调用方改动不会回写 lastProbe）。 */
function clonePlain(value) {
  if (Array.isArray(value)) return value.map(clonePlain)
  if (isPlainObject(value)) {
    const out = {}
    for (const key of Object.keys(value)) out[key] = clonePlain(value[key])
    return out
  }
  return value
}

/**
 * 判定单个 lastProbe 条目是否需要重测。
 *
 * @param {unknown} entry - llm-reasoning.lastProbe.models['provider/model']。
 * @returns {{probe: boolean, reason: string}} probe=true 表示需要重测。
 */
export function probeEntryNeedsProbe(entry) {
  // 1. 无条目 / 非普通对象 / 无任何探测记录 = 从未探测（error 单独存在不算记录，
  //    否则「探测异常但未落结果」会被误判为可沿用）。
  if (!isPlainObject(entry)) return { probe: true, reason: PROBE_PLAN_REASONS.NEVER_PROBED }
  const hasRecord = Array.isArray(entry.working) || Array.isArray(entry.rejected) || Array.isArray(entry.blocked) || typeof entry.persisted === 'string'
  if (!hasRecord) return { probe: true, reason: PROBE_PLAN_REASONS.NEVER_PROBED }
  // 2. 上次探测异常（前向兼容守卫：面向外部/历史写入的 error 字段；当前生产路径
  //    不写 error——空串视为「无错误」，否则会让该模型永久重测）。
  if (entry.error !== undefined && entry.error !== null && entry.error !== '') return { probe: true, reason: PROBE_PLAN_REASONS.PROBE_ERROR }
  // 3. 存在阻塞档位：结果未收敛，需重测以确认是否恢复。
  if (Array.isArray(entry.blocked) && entry.blocked.length > 0) return { probe: true, reason: PROBE_PLAN_REASONS.BLOCKED_LEVELS }
  // 4. 上次写回失败：声明可能未落地，需重测重写。
  if (entry.persisted === 'persist-error') return { probe: true, reason: PROBE_PLAN_REASONS.PERSIST_ERROR }
  // 5. 声明待固化：探测结果已定论但尚未写回能力声明。
  if (entry.persisted === 'pending-apply') return { probe: true, reason: PROBE_PLAN_REASONS.PENDING_APPLY }
  // 6. 定论结局：沿用上次结果。
  return { probe: false, reason: PROBE_PLAN_REASONS.SETTLED }
}

/**
 * 生成 skip 行的上次结果快照：只含 working/rejected/blocked（字符串元素）、
 * blockedReasons（普通对象且非空）、persisted（字符串）——其余字段绝不外泄。
 * 非普通对象 → undefined（调用方据此省略 entry 字段）。
 */
function snapshotEntry(entry) {
  if (!isPlainObject(entry)) return undefined
  const snapshot = {
    working: stringListOf(entry.working),
    rejected: stringListOf(entry.rejected),
    blocked: stringListOf(entry.blocked),
  }
  if (isPlainObject(entry.blockedReasons) && Object.keys(entry.blockedReasons).length > 0) {
    snapshot.blockedReasons = clonePlain(entry.blockedReasons)
  }
  if (typeof entry.persisted === 'string') snapshot.persisted = entry.persisted
  return snapshot
}

/**
 * 规划一次探测：把目标模型分成「需重测（probe）」与「沿用上次结果（skip）」。
 *
 * @param {object} [options]
 * @param {unknown} [options.targets] - [{provider, model, key?}]；非数组视为空。
 * @param {unknown} [options.lastProbe] - llm-reasoning.lastProbe（{t, models}）。
 * @param {unknown} [options.force] - true = 全部重测（跳过判定，reason='forced'）。
 * @param {unknown} [options.isConfigured] - 可选同步函数 (provider, model) => boolean，
 *   用于「模型后加入 llm-pi-ai 配置」对账（返回 true 时 skipped:not-in-pi-ai-config
 *   改判 config-changed）；缺省/非函数时不做该对账。
 * @returns {{probe: Array<{provider: string, model: string, key: string, reason: string}>,
 *   skip: Array<{provider: string, model: string, key: string, reason: string, entry?: object}>,
 *   total: number, force: boolean}}
 */
export function planProbe({ targets, lastProbe, force, isConfigured } = {}) {
  const list = Array.isArray(targets) ? targets : []
  const models = isPlainObject(lastProbe) && isPlainObject(lastProbe.models) ? lastProbe.models : {}
  const forced = force === true
  const probe = []
  const skip = []
  for (const target of list) {
    // 逐项校验：provider/model 必须均为非空字符串；非法目标不进 probe 也不进 skip，
    // 也不计入 total（调用方按 total 对账时不会被脏数据污染）。
    if (target === null || typeof target !== 'object') continue
    const provider = target.provider
    const model = target.model
    if (typeof provider !== 'string' || provider === '') continue
    if (typeof model !== 'string' || model === '') continue
    const key = typeof target.key === 'string' && target.key !== '' ? target.key : provider + '/' + model
    if (forced) {
      probe.push({ provider, model, key, reason: PROBE_PLAN_REASONS.FORCED })
      continue
    }
    const entry = models[key]
    const verdict = probeEntryNeedsProbe(entry)
    if (verdict.probe) {
      probe.push({ provider, model, key, reason: verdict.reason })
      continue
    }
    // FEAT-009 R1（P2-1）：「不在 llm-pi-ai 配置」是随配置变化的暂时结局——用户把该
    // 模型加入配置后必须重测并固化；skipped:official-adapter 不在此规则内（官方适配器
    // 不写 pi-ai 声明）。
    if (entry.persisted === 'skipped:not-in-pi-ai-config'
      && typeof isConfigured === 'function'
      && isConfigured(provider, model) === true) {
      probe.push({ provider, model, key, reason: PROBE_PLAN_REASONS.CONFIG_CHANGED })
      continue
    }
    const row = { provider, model, key, reason: verdict.reason }
    const snapshot = snapshotEntry(entry)
    if (snapshot !== undefined) row.entry = snapshot
    skip.push(row)
  }
  return { probe, skip, total: probe.length + skip.length, force: forced }
}
