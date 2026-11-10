/**
 * model-capabilities — 多模态能力注册表与写回规划（FEAT-007，设计
 * docs/design/unified-model-workbench-v0.10.md §4.3/§5）。
 *
 * 职责边界（BM-5 同族约束）：纯数据 + 纯函数，**零宿主 import**。本模块只回答
 * 「把某个模型的输入模态写成什么、写在哪里、写前是什么」——不读设置、不发写、
 * 不猜宿主目录；`lib/index.js` 负责读 raw section → 调用本模块规划 → 整节
 * settings.replace → 落 appliedInputs 台账。
 *
 * 三种写点（事实基线 DSH 0.2.2-rc.1）：
 *  1. pi-ai 路由，raw `models` 数组非空 → 定位 `models[i].id === model`，写
 *     `entry.input = ['text'] | ['text','image']`（其余字段原样保留）。
 *  2. pi-ai 路由，raw `models` 缺省/空 → 写 `modelOverrides[model] = {
 *     ...(既有 ?? {}), input }`。**不得**在有 models 列表时写 overrides——
 *     宿主 dsh-llm-pi-ai 校验 "sets modelOverrides ... beside a models list" → invalid。
 *  3. deepseek 路由，raw `models` 数组含该模型 → 写 `models[i].inputModalities`；
 *     raw `models` 缺省时**不写**（内置目录未物化，凭空创建会覆盖用户/适配器目录）。
 *
 * 撤销语义：仅当宿主当前值与台账 `written` 深相等时恢复 `previous`
 * （null → 删除字段 / 删除空覆盖项），否则不动（尊重用户手改）。
 *
 * @module dsh-reasoning-level/model-capabilities
 */

/** 输入模态注册表（text 必选、image 可选；顺序即 UI 渲染顺序）。 */
export const MODALITIES = Object.freeze([
  Object.freeze({ id: 'text', label: Object.freeze({ zh: '文本', en: 'Text' }), required: true }),
  Object.freeze({ id: 'image', label: Object.freeze({ zh: '图像', en: 'Image' }), required: false }),
])

/** 已注册模态 id 集合（normalize/写回共用的单一来源）。 */
const MODALITY_IDS = MODALITIES.map((entry) => entry.id)

const cloneJson = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/**
 * 规范化输入模态列表：去重 + 强制 text + 仅保留已注册模态 + 顺序规范化。
 * 空/非数组 → ['text']（宿主默认文本输入）。
 *
 * @param {unknown} list - 用户/配置声明的模态数组。
 * @returns {string[]} `['text']` 或 `['text','image']`（恒含 text）。
 */
export function normalizeInput(list) {
  if (!Array.isArray(list)) return ['text']
  const present = new Set(list.filter((item) => typeof item === 'string' && MODALITY_IDS.includes(item)))
  present.add('text')
  return MODALITIES.map((entry) => entry.id).filter((id) => present.has(id))
}

/**
 * 解析 appliedInputs / modelInput 的键（"provider/model"）——按**首个** `/`
 * 切分（provider 路由 id 不含 `/`，模型 id 可能含 `/`）。
 *
 * @param {unknown} key - 形如 "zai-coding-cn/glm-5.3" 的键。
 * @returns {{provider: string, model: string}|undefined}
 */
export function parseModelKey(key) {
  if (typeof key !== 'string') return undefined
  const separator = key.indexOf('/')
  if (separator <= 0 || separator === key.length - 1) return undefined
  return { provider: key.slice(0, separator), model: key.slice(separator + 1) }
}

/** 克隆为可安全修改的 section（非对象/缺省 → {}）。 */
function cloneSection(section) {
  return isPlainObject(section) ? cloneJson(section) : {}
}

/** pi-ai 路由 profile（persistence 结构：section.providers[provider]）。 */
function piAiProfile(section, provider) {
  if (!isPlainObject(section.providers)) return undefined
  const profile = section.providers[provider]
  return isPlainObject(profile) ? profile : undefined
}

/** 写点无法执行的统一返回（changed=false + 原因；section 为原样克隆）。 */
function skippedWrite(section, reason) {
  return { section, changed: false, written: null, previous: null, skipped: reason }
}

/** 撤销无法执行的统一返回。 */
function skippedRevert(section, reason) {
  return { section, changed: false, restored: undefined, skipped: reason }
}

/**
 * 规划一次「写入声明输入模态」（纯函数，不修改输入 section）。
 *
 * @param {object} options
 * @param {object} [options.section] - 宿主命名空间原始 user 节（llm-pi-ai 或 llm-deepseek）。
 * @param {'pi-ai'|'deepseek'} options.kind - 路由类型（决定写点）。
 * @param {string} options.provider - 路由 id。
 * @param {string} options.model - 模型 id。
 * @param {unknown} options.input - 用户声明的输入模态（任意脏值，内部 normalize）。
 * @returns {{section: object, changed: boolean, written: string[]|null, previous: string[]|null, skipped?: string}}
 *   `written` = 规范化后的目标值；`previous` = 写入前宿主值（null = 原本缺省）；
 *   `changed=false` 时调用方必须跳过 replace 与台账写入。
 */
export function planInputWrite({ section, kind, provider, model, input } = {}) {
  const written = normalizeInput(input)
  const base = cloneSection(section)

  if (kind === 'pi-ai') {
    const profile = piAiProfile(base, provider)
    if (profile === undefined) return skippedWrite(base, 'route-missing')
    const models = Array.isArray(profile.models) ? profile.models : []
    if (models.length > 0) {
      // 写点 1：models 数组（models 列表存在时 modelOverrides 属宿主非法配置）
      const index = models.findIndex((entry) => isPlainObject(entry) && entry.id === model)
      if (index < 0) return skippedWrite(base, 'model-not-declared')
      const entry = { ...models[index] }
      const previous = Array.isArray(entry.input) ? cloneJson(entry.input) : null
      const changed = !deepEqual(previous, written)
      if (changed) entry.input = cloneJson(written)
      models[index] = entry
      return { section: base, changed, written: cloneJson(written), previous }
    }
    // 写点 2：models 缺省/空 → modelOverrides[model]
    const overrides = profile.modelOverrides
    if (overrides !== undefined && overrides !== null && !isPlainObject(overrides)) {
      return skippedWrite(base, 'invalid-overrides')
    }
    const existing = isPlainObject(overrides) && isPlainObject(overrides[model]) ? overrides[model] : undefined
    if (existing === undefined && overrides !== undefined && overrides !== null && overrides[model] !== undefined) {
      return skippedWrite(base, 'invalid-overrides')
    }
    const previous = existing !== undefined && Array.isArray(existing.input) ? cloneJson(existing.input) : null
    const changed = !deepEqual(previous, written)
    if (!changed) return { section: base, changed, written: cloneJson(written), previous }
    const nextOverride = { ...(existing !== undefined ? existing : {}), input: cloneJson(written) }
    profile.modelOverrides = { ...(isPlainObject(overrides) ? overrides : {}), [model]: nextOverride }
    return { section: base, changed: true, written: cloneJson(written), previous }
  }

  if (kind === 'deepseek') {
    // 写点 3：raw models 数组（缺省 = 适配器内置目录未物化 → 不写）
    const models = Array.isArray(base.models) ? base.models : []
    if (models.length === 0) return skippedWrite(base, 'no-catalog-models')
    const index = models.findIndex((entry) => isPlainObject(entry) && entry.id === model)
    if (index < 0) return skippedWrite(base, 'model-not-in-catalog')
    const entry = { ...models[index] }
    const previous = Array.isArray(entry.inputModalities) ? cloneJson(entry.inputModalities) : null
    const changed = !deepEqual(previous, written)
    if (changed) entry.inputModalities = cloneJson(written)
    models[index] = entry
    return { section: base, changed, written: cloneJson(written), previous }
  }

  return skippedWrite(base, 'unknown-kind')
}

/**
 * 规划一次「撤销声明输入模态」（纯函数，不修改输入 section）。
 * 仅当宿主当前值与台账 `written` 深相等时恢复 `previous`：
 *  · previous = null → 删除 `input` / `inputModalities`；pi-ai modelOverrides 的
 *    条目删空后整条删除，modelOverrides 删空后整键删除；
 *  · previous = 数组 → 写回写入前的模态数组；
 *  · current ≠ written → 不动（用户手改），返回 skipped='user-modified'。
 *
 * @param {object} options
 * @param {object} [options.section] - 宿主命名空间原始 user 节。
 * @param {'pi-ai'|'deepseek'} options.kind - 路由类型。
 * @param {string} options.provider - 路由 id。
 * @param {string} options.model - 模型 id。
 * @param {string[]} options.written - 台账记录的本插件写入值。
 * @param {string[]|null} options.previous - 台账记录的写入前值（null = 原本缺省）。
 * @returns {{section: object, changed: boolean, restored?: string[]|null, skipped?: string}}
 */
export function planInputRevert({ section, kind, provider, model, written, previous } = {}) {
  const base = cloneSection(section)
  if (!Array.isArray(written)) return skippedRevert(base, 'invalid-written')
  const restored = previous === null || previous === undefined
    ? null
    : (Array.isArray(previous) ? cloneJson(previous) : null)

  if (kind === 'pi-ai') {
    const profile = piAiProfile(base, provider)
    if (profile === undefined) return skippedRevert(base, 'not-applicable')
    const models = Array.isArray(profile.models) ? profile.models : []
    if (models.length > 0) {
      const index = models.findIndex((entry) => isPlainObject(entry) && entry.id === model)
      if (index < 0) return skippedRevert(base, 'not-applicable')
      const entry = models[index]
      const current = Array.isArray(entry.input) ? entry.input : null
      if (!deepEqual(current, written)) return skippedRevert(base, 'user-modified')
      const next = { ...entry }
      if (restored === null) delete next.input
      else next.input = cloneJson(restored)
      models[index] = next
      return { section: base, changed: true, restored: restored === null ? null : cloneJson(restored) }
    }
    if (!isPlainObject(profile.modelOverrides)) return skippedRevert(base, 'not-applicable')
    const overrides = profile.modelOverrides
    const entry = overrides[model]
    if (!isPlainObject(entry)) return skippedRevert(base, 'not-applicable')
    const current = Array.isArray(entry.input) ? entry.input : null
    if (!deepEqual(current, written)) return skippedRevert(base, 'user-modified')
    if (restored === null) {
      const next = { ...entry }
      delete next.input
      if (Object.keys(next).length === 0) delete overrides[model]
      else overrides[model] = next
      if (Object.keys(overrides).length === 0) delete profile.modelOverrides
    } else {
      overrides[model] = { ...entry, input: cloneJson(restored) }
    }
    return { section: base, changed: true, restored: restored === null ? null : cloneJson(restored) }
  }

  if (kind === 'deepseek') {
    const models = Array.isArray(base.models) ? base.models : []
    if (models.length === 0) return skippedRevert(base, 'not-applicable')
    const index = models.findIndex((entry) => isPlainObject(entry) && entry.id === model)
    if (index < 0) return skippedRevert(base, 'not-applicable')
    const entry = models[index]
    const current = Array.isArray(entry.inputModalities) ? entry.inputModalities : null
    if (!deepEqual(current, written)) return skippedRevert(base, 'user-modified')
    const next = { ...entry }
    if (restored === null) delete next.inputModalities
    else next.inputModalities = cloneJson(restored)
    models[index] = next
    return { section: base, changed: true, restored: restored === null ? null : cloneJson(restored) }
  }

  return skippedRevert(base, 'unknown-kind')
}
