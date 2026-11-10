/**
 * param-registry — 采样参数注册表（FEAT-007，设计
 * docs/design/unified-model-workbench-v0.10.md §3/§5，DEC-026）。
 *
 * 职责边界（BM-5 同族约束）：纯数据 + 纯函数，**零宿主 import**。参数边界、
 * 宿主支持面（hostSupport）与应用方式（apply）的唯一事实源——服务端
 * `/reasoning-level-models` 下发 `projectRegistry()` 投影，客户端据此渲染参数
 * 控件，`lib/index.js` 据此过滤注入面；新增参数只改本文件的 PARAM_REGISTRY，
 * 无需改 UI 参数列表（扩展契约 §11）。
 *
 * hostSupport 语义（事实基线 DSH 0.2.2-rc.1）：
 *  · active   —— 宿主调用配置（GenerateOptions / agent/request call config）
 *               有对应字段，可真实生效；
 *  · reserved —— 宿主当前没有字段（GenerateOptions 无 topP/topK），只保存 +
 *               展示 + 标注原因；宿主未来提供入口时改 hostSupport 为 active 并
 *               补 apply 适配即可（不得提前偷偷塞进请求）。
 * apply 语义：
 *  · call-config —— activeCallParams() 把它放进宿主调用配置；
 *  · none        —— 永不进入请求（保留在配置里）。
 *
 * 边界（用户裁决 + 任务硬要求）：temperature 0..2；topP 0..1；topK
 * 0..1000000 整数；maxTokens 1..2000000 整数。空 = 继承（缺省不写）。
 *
 * @module dsh-reasoning-level/param-registry
 */

/** 深度冻结纯数据（注册表是只读事实源，杜绝运行期改写）。 */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

/**
 * 参数注册表（顺序即 UI 渲染顺序）。
 * 每条：{ id, type:'number'|'integer', min, max, step, decimals,
 *        label:{zh,en}, hint:{zh,en}, hostSupport:'active'|'reserved',
 *        apply:'call-config'|'none', reason?:{zh,en} }
 */
export const PARAM_REGISTRY = deepFreeze([
  {
    id: 'temperature',
    type: 'number',
    min: 0,
    max: 2,
    step: 0.05,
    decimals: 2,
    label: { zh: '温度', en: 'Temperature' },
    hint: { zh: '越低越稳定，越高越发散', en: 'Lower = steadier, higher = more varied' },
    hostSupport: 'active',
    apply: 'call-config',
  },
  {
    id: 'topP',
    type: 'number',
    min: 0,
    max: 1,
    step: 0.05,
    decimals: 2,
    label: { zh: 'Top P', en: 'Top P' },
    hint: { zh: '核采样概率阈值；保存并预留，暂不下发宿主', en: 'Nucleus sampling threshold; saved and reserved, not sent to the host yet' },
    hostSupport: 'reserved',
    apply: 'none',
    reason: {
      zh: '宿主 0.2.2 的 GenerateOptions / LlmCallControls 无 topP 字段',
      en: 'DSH 0.2.2 GenerateOptions / LlmCallControls has no topP field',
    },
  },
  {
    id: 'topK',
    type: 'integer',
    min: 0,
    max: 1000000,
    step: 1,
    decimals: 0,
    label: { zh: 'Top K', en: 'Top K' },
    hint: { zh: '每步保留的候选 token 数；保存并预留，暂不下发宿主', en: 'Candidate tokens per step; saved and reserved, not sent to the host yet' },
    hostSupport: 'reserved',
    apply: 'none',
    reason: {
      zh: '宿主 0.2.2 的 GenerateOptions / LlmCallControls 无 topK 字段',
      en: 'DSH 0.2.2 GenerateOptions / LlmCallControls has no topK field',
    },
  },
  {
    id: 'maxTokens',
    type: 'integer',
    min: 1,
    max: 2000000,
    step: 1,
    decimals: 0,
    label: { zh: '最大输出 token', en: 'Max output tokens' },
    hint: { zh: '单次响应的输出上限；缺省沿用模型/宿主默认', en: 'Upper bound for one response; omitted = model/host default' },
    hostSupport: 'active',
    apply: 'call-config',
  },
])

/** id → 条目（内部索引；注册表只读）。 */
const PARAM_BY_ID = new Map(PARAM_REGISTRY.map((entry) => [entry.id, entry]))

/**
 * 内置参数预设（代码常量，不写死进用户配置直到套用）。
 * 键 = preset id；custom 为空包（用户自定义当前参数）。
 */
export const PARAM_PRESETS = deepFreeze({
  precise: {
    id: 'precise',
    label: { zh: '精确', en: 'Precise' },
    params: { temperature: 0.2, topP: 0.9, topK: 20 },
  },
  balanced: {
    id: 'balanced',
    label: { zh: '均衡', en: 'Balanced' },
    params: { temperature: 0.7, topP: 0.95, topK: 40 },
  },
  creative: {
    id: 'creative',
    label: { zh: '创意', en: 'Creative' },
    params: { temperature: 1.0, topP: 1.0, topK: 0 },
  },
  custom: {
    id: 'custom',
    label: { zh: '自定义', en: 'Custom' },
    params: {},
  },
})

/**
 * 清洗参数包：丢弃未知键、非法类型/非有限数、越界值；整数参数四舍五入。
 *
 * 策略选择（有意锚定）：**越界丢弃**而非裁剪——裁剪会把用户手填的 5.0 静默
 * 改成 2.0 并让它生效，隐瞒配置问题；丢弃则回到「继承」，同时 UI 仍能显示
 * 用户填写的原值（配置层由宿主 schema 保留）。非法值绝不抛出（调用点在请求
 * 路径与 boot 路径，任何异常都不得升级为请求失败）。
 *
 * @param {unknown} raw - 任意原始参数包（来自 settings 或模型级覆盖）。
 * @returns {{[paramId: string]: number}} 仅含注册表中合法参数的新对象。
 */
export function sanitizeParams(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out = {}
  for (const [key, value] of Object.entries(raw)) {
    const def = PARAM_BY_ID.get(key)
    if (def === undefined) continue
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    let numeric = value
    if (def.type === 'integer') numeric = Math.round(numeric)
    if (numeric < def.min || numeric > def.max) continue
    // 归一 -0（JSON 往返后是 0，避免深比较/快照出现 -0）
    out[key] = numeric === 0 ? 0 : numeric
  }
  return out
}

/**
 * 逐字段合并「默认 → 覆盖」：覆盖值优先，缺省字段继承默认值。
 * 双侧都先 sanitize（非法覆盖不得清空合法默认）。
 *
 * @param {unknown} defaults - 全局默认参数包。
 * @param {unknown} override - 模型级覆盖参数包。
 * @returns {{[paramId: string]: number}} 合并后的合法参数包。
 */
export function mergeParams(defaults, override) {
  return { ...sanitizeParams(defaults), ...sanitizeParams(override) }
}

/**
 * 真实可注入宿主调用配置的参数子集：仅 hostSupport === 'active' 且
 * apply === 'call-config' 的条目（当前 = temperature / maxTokens）。
 * topP/topK 属 reserved，**永远不进入请求**（DEC-026）。
 *
 * @param {unknown} params - 任意参数包（already-merged 或用户配置）。
 * @returns {{[paramId: string]: number}} 仅可注入字段的新对象。
 */
export function activeCallParams(params) {
  const sanitized = sanitizeParams(params)
  const out = {}
  for (const def of PARAM_REGISTRY) {
    if (def.hostSupport !== 'active' || def.apply !== 'call-config') continue
    const value = sanitized[def.id]
    if (value !== undefined) out[def.id] = value
  }
  return out
}

/**
 * 服务端/客户端投影：注册表条目的可下发快照（含 label/hint/status/reason），
 * 是设置页参数控件的唯一事实源。新增注册表条目自动出现在投影（UI 无需枚举）。
 *
 * @param {ReadonlyArray<object>} [registry=PARAM_REGISTRY] - 注册表（扩展/测试可注入）。
 * @returns {Array<object>} 投影数组（每次调用新对象，不含共享可变引用）。
 */
export function projectRegistry(registry = PARAM_REGISTRY) {
  const list = Array.isArray(registry) ? registry : PARAM_REGISTRY
  return list.map((def) => {
    const projected = {
      id: def.id,
      type: def.type,
      min: def.min,
      max: def.max,
      step: def.step,
      decimals: def.decimals,
      label: { zh: def.label?.zh ?? '', en: def.label?.en ?? '' },
      hint: { zh: def.hint?.zh ?? '', en: def.hint?.en ?? '' },
      hostSupport: def.hostSupport,
      apply: def.apply,
      status: def.hostSupport === 'active' ? 'active' : 'reserved',
    }
    if (def.hostSupport !== 'active' && def.reason !== undefined) {
      projected.reason = { zh: def.reason.zh ?? '', en: def.reason.en ?? '' }
    }
    return projected
  })
}
