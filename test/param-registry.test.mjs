/**
 * FEAT-007 参数注册表判别测试（设计 docs/design/unified-model-workbench-v0.10.md §3/§5）。
 *
 * 判别性：lib/param-registry.js 在旧实现中不存在（模块解析失败即红）；即便存在，
 * 下列断言锚定的是「注册表是 hostSupport/apply 的唯一事实源」「sanitize 丢弃非法
 * 值而不抛错」「active 过滤只给 temperature/maxTokens」三条新语义，旧实现没有任何
 * 对应行为。
 *
 * 测试策略：直接驱动真实 lib/param-registry.js 纯函数（模块本身即被测工件，无桩），
 * 用真实参数面形状（temperature/topP/topK/maxTokens）作为夹具。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PARAM_REGISTRY,
  PARAM_PRESETS,
  sanitizeParams,
  mergeParams,
  activeCallParams,
  projectRegistry,
} from '../lib/param-registry.js'

const byId = (id) => PARAM_REGISTRY.find((entry) => entry.id === id)

// ── A. 注册表形状（扩展接口的唯一事实源）──────────────────────────────────────
test('(registry-1) PARAM_REGISTRY 四参数齐全且边界/标签/宿主支持面完整', () => {
  assert.deepEqual(PARAM_REGISTRY.map((entry) => entry.id), ['temperature', 'topP', 'topK', 'maxTokens'])
  const expected = {
    temperature: { type: 'number', min: 0, max: 2, step: 0.05, decimals: 2, hostSupport: 'active', apply: 'call-config' },
    // 用户裁决 DEC-026：topP/topK 保存并预留扩展（宿主 0.2.2 GenerateOptions 无字段）
    topP: { type: 'number', min: 0, max: 1, step: 0.05, decimals: 2, hostSupport: 'reserved', apply: 'none' },
    topK: { type: 'integer', min: 0, max: 1000000, step: 1, decimals: 0, hostSupport: 'reserved', apply: 'none' },
    maxTokens: { type: 'integer', min: 1, max: 2000000, step: 1, decimals: 0, hostSupport: 'active', apply: 'call-config' },
  }
  for (const [id, shape] of Object.entries(expected)) {
    const entry = byId(id)
    assert.ok(entry !== undefined, `注册表必须含 ${id}`)
    for (const [field, value] of Object.entries(shape)) {
      assert.equal(entry[field], value, `${id}.${field} 与设计契约漂移`)
    }
    assert.ok(typeof entry.label?.zh === 'string' && entry.label.zh.length > 0, `${id}.label.zh 必须非空`)
    assert.ok(typeof entry.label?.en === 'string' && entry.label.en.length > 0, `${id}.label.en 必须非空`)
    assert.ok(typeof entry.hint?.zh === 'string' && entry.hint.zh.length > 0, `${id}.hint.zh 必须非空`)
    assert.ok(typeof entry.hint?.en === 'string' && entry.hint.en.length > 0, `${id}.hint.en 必须非空`)
  }
  // reserved 必须带原因（zh/en 成对），active 不带 reason
  for (const id of ['topP', 'topK']) {
    const entry = byId(id)
    assert.ok(typeof entry.reason?.zh === 'string' && entry.reason.zh.length > 0, `${id} 预留原因（zh）必须存在`)
    assert.ok(typeof entry.reason?.en === 'string' && entry.reason.en.length > 0, `${id} 预留原因（en）必须存在`)
  }
  assert.equal(byId('temperature').reason, undefined, 'active 参数不得带预留原因')
  // 纯数据面：冻结（UI/服务端只读投影，杜绝运行期改写注册表）
  assert.ok(Object.isFrozen(PARAM_REGISTRY), 'PARAM_REGISTRY 必须冻结')
  for (const entry of PARAM_REGISTRY) assert.ok(Object.isFrozen(entry), `${entry.id} 条目必须冻结`)
})

test('(registry-2) PARAM_PRESETS：精确/均衡/创意/自定义，参数与设计表一致', () => {
  assert.deepEqual(Object.keys(PARAM_PRESETS), ['precise', 'balanced', 'creative', 'custom'])
  assert.deepEqual(PARAM_PRESETS.precise.params, { temperature: 0.2, topP: 0.9, topK: 20 })
  assert.deepEqual(PARAM_PRESETS.balanced.params, { temperature: 0.7, topP: 0.95, topK: 40 })
  assert.deepEqual(PARAM_PRESETS.creative.params, { temperature: 1.0, topP: 1.0, topK: 0 })
  assert.deepEqual(PARAM_PRESETS.custom.params, {})
  for (const [id, preset] of Object.entries(PARAM_PRESETS)) {
    assert.equal(preset.id, id)
    assert.ok(typeof preset.label?.zh === 'string' && preset.label.zh.length > 0)
    assert.ok(typeof preset.label?.en === 'string' && preset.label.en.length > 0)
  }
  assert.ok(Object.isFrozen(PARAM_PRESETS), 'PARAM_PRESETS 必须冻结')
})

// ── B. sanitizeParams（非法值丢弃，绝不抛出）──────────────────────────────────
test('(sanitize-1) 未知键丢弃，合法字段保留', () => {
  assert.deepEqual(sanitizeParams({ temperature: 0.5, seed: 42, foo: 'bar' }), { temperature: 0.5 })
  assert.deepEqual(sanitizeParams({ topP: 0.95, topK: 40, maxTokens: 4096 }), { topP: 0.95, topK: 40, maxTokens: 4096 })
})

test('(sanitize-2) 非法类型/非有限数丢弃（字符串、布尔、null、NaN、Infinity、对象/数组）', () => {
  assert.deepEqual(sanitizeParams({ temperature: '0.5' }), {})
  assert.deepEqual(sanitizeParams({ temperature: true }), {})
  assert.deepEqual(sanitizeParams({ temperature: null }), {})
  assert.deepEqual(sanitizeParams({ temperature: Number.NaN }), {})
  assert.deepEqual(sanitizeParams({ temperature: Number.POSITIVE_INFINITY }), {})
  assert.deepEqual(sanitizeParams({ topK: {} }), {})
  assert.deepEqual(sanitizeParams({ topK: [] }), {})
  assert.deepEqual(sanitizeParams({ maxTokens: -1 }), {})
})

test('(sanitize-3) 越界值丢弃（范围裁剪策略未采用；边界内接受）', () => {
  // temperature 0..2
  assert.deepEqual(sanitizeParams({ temperature: -0.01 }), {})
  assert.deepEqual(sanitizeParams({ temperature: 2.01 }), {})
  assert.deepEqual(sanitizeParams({ temperature: 0 }), { temperature: 0 })
  assert.deepEqual(sanitizeParams({ temperature: 2 }), { temperature: 2 })
  // topP 0..1
  assert.deepEqual(sanitizeParams({ topP: -0.01 }), {})
  assert.deepEqual(sanitizeParams({ topP: 1.01 }), {})
  assert.deepEqual(sanitizeParams({ topP: 0 }), { topP: 0 })
  assert.deepEqual(sanitizeParams({ topP: 1 }), { topP: 1 })
  // topK 0..1e6 整数
  assert.deepEqual(sanitizeParams({ topK: -1 }), {})
  assert.deepEqual(sanitizeParams({ topK: 1000001 }), {})
  assert.deepEqual(sanitizeParams({ topK: 0 }), { topK: 0 })
  assert.deepEqual(sanitizeParams({ topK: 1000000 }), { topK: 1000000 })
  // maxTokens 1..2e6 整数
  assert.deepEqual(sanitizeParams({ maxTokens: 0 }), {})
  assert.deepEqual(sanitizeParams({ maxTokens: 2000001 }), {})
  assert.deepEqual(sanitizeParams({ maxTokens: 1 }), { maxTokens: 1 })
  assert.deepEqual(sanitizeParams({ maxTokens: 2000000 }), { maxTokens: 2000000 })
})

test('(sanitize-4) 整数参数强制整数（四舍五入）；number 参数不裁剪精度', () => {
  assert.deepEqual(sanitizeParams({ topK: 20.6 }), { topK: 21 })
  assert.deepEqual(sanitizeParams({ topK: 20.4 }), { topK: 20 })
  assert.deepEqual(sanitizeParams({ maxTokens: 1.4 }), { maxTokens: 1 })
  assert.deepEqual(sanitizeParams({ temperature: 0.123456 }), { temperature: 0.123456 })
})

test('(sanitize-5) 非对象输入（undefined/null/数组/字符串）→ 空包，不抛错', () => {
  for (const input of [undefined, null, [], 'x', 42, true]) {
    assert.deepEqual(sanitizeParams(input), {})
  }
})

// ── C. mergeParams（逐字段覆盖）──────────────────────────────────────────────
test('(merge-1) 覆盖优先、缺省继承；非法覆盖值被丢弃且不清空默认', () => {
  const defaults = { temperature: 0.7, maxTokens: 4096 }
  assert.deepEqual(mergeParams(defaults, { temperature: 0.2 }), { temperature: 0.2, maxTokens: 4096 })
  assert.deepEqual(mergeParams(defaults, {}), { temperature: 0.7, maxTokens: 4096 })
  assert.deepEqual(mergeParams(defaults, undefined), { temperature: 0.7, maxTokens: 4096 })
  // 覆盖值越界 → sanitize 丢弃 → 默认值继续生效（不得把非法值写进结果）
  assert.deepEqual(mergeParams(defaults, { temperature: 9 }), { temperature: 0.7, maxTokens: 4096 })
  // 未知键丢弃
  assert.deepEqual(mergeParams(defaults, { seed: 1 }), { temperature: 0.7, maxTokens: 4096 })
})

test('(merge-2) 双侧非法值全部清空后为空包', () => {
  assert.deepEqual(mergeParams({ temperature: 8 }, { topP: 5 }), {})
})

// ── D. activeCallParams（只给宿主真实消费面）──────────────────────────────────
test('(active-1) 只返回 active + call-config 的 temperature/maxTokens，topP/topK 留在配置里不注入', () => {
  assert.deepEqual(
    activeCallParams({ temperature: 0.2, topP: 0.9, topK: 20, maxTokens: 1024 }),
    { temperature: 0.2, maxTokens: 1024 },
  )
  assert.deepEqual(activeCallParams({ topP: 0.9, topK: 20 }), {})
  assert.deepEqual(activeCallParams({}), {})
  assert.deepEqual(activeCallParams(undefined), {})
  // 非法值同样被过滤（注入面绝不携带脏值）
  assert.deepEqual(activeCallParams({ temperature: 99, maxTokens: 1024 }), { maxTokens: 1024 })
})

// ── E. projectRegistry（服务端下发 / 客户端渲染的唯一事实源）──────────────────
test('(project-1) 投影含 status/reason，且不改变原注册表', () => {
  const snapshot = JSON.stringify(PARAM_REGISTRY)
  const projected = projectRegistry()
  assert.equal(projected.length, 4)
  const baseKeys = ['apply', 'decimals', 'hint', 'hostSupport', 'id', 'label', 'max', 'min', 'status', 'step', 'type'].sort()
  for (const item of projected) {
    const expectedKeys = item.hostSupport === 'active' ? baseKeys : [...baseKeys, 'reason'].sort()
    assert.deepEqual(Object.keys(item).sort(), expectedKeys)
    assert.equal(item.status, item.hostSupport === 'active' ? 'active' : 'reserved')
  }
  const topP = projected.find((entry) => entry.id === 'topP')
  assert.equal(topP.status, 'reserved')
  assert.ok(typeof topP.reason?.zh === 'string' && topP.reason.zh.length > 0)
  assert.equal(projected.find((entry) => entry.id === 'temperature').reason, undefined)
  assert.equal(JSON.stringify(PARAM_REGISTRY), snapshot, '投影不得原地修改注册表')
})

test('(project-2) 扩展契约：新增注册表条目自动出现在投影（UI 无需枚举参数名）', () => {
  const extended = [
    ...PARAM_REGISTRY,
    {
      id: 'seed',
      type: 'integer',
      min: 0,
      max: 2147483647,
      step: 1,
      decimals: 0,
      label: { zh: '随机种子', en: 'Seed' },
      hint: { zh: '相同种子复现相同输出', en: 'Same seed reproduces output' },
      hostSupport: 'active',
      apply: 'call-config',
    },
  ]
  const projected = projectRegistry(extended)
  const seed = projected.find((entry) => entry.id === 'seed')
  assert.ok(seed !== undefined, '新增注册表条目必须自动出现在服务端投影')
  assert.equal(seed.status, 'active')
  assert.equal(seed.apply, 'call-config')
})
