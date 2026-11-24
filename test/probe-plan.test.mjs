/**
 * FEAT-009 增量探测决策模块单测（lib/probe-plan.js）。
 *
 * 覆盖（与设计契约逐条对应）：
 *  - PROBE_PLAN_REASONS 冻结且字符串值稳定（端点/测试共用单一来源）；
 *  - probeEntryNeedsProbe 判定顺序：never-probed / probe-error（非 null/undefined/
 *    空串）/ blocked-levels / persist-error / pending-apply / settled；
 *  - 定论类 persisted（converged / no-change-already-correct / written /
 *    skipped:*）→ settled（skip）；
 *  - 模型后加入 llm-pi-ai 配置：skipped:not-in-pi-ai-config + isConfigured=true →
 *    config-changed 重测；isConfigured=false/缺省/其它定论不受影响；
 *  - force=true → 全部 probe 且 reason='forced'；
 *  - lastProbe 缺失/为空 → 全部 never-probed；
 *  - malformed targets（缺 provider/model、非字符串）被跳过且不计 total；
 *  - key 兜底（target 无 key 时用 provider + '/' + model）；
 *  - skip entry sanitize（多余字段不泄漏；缺失数组补 []；blockedReasons 非对象时省略）；
 *  - probe/skip 各自保持 targets 顺序。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PROBE_PLAN_REASONS, planProbe, probeEntryNeedsProbe } from '../lib/probe-plan.js'

const R = PROBE_PLAN_REASONS

test('PROBE_PLAN_REASONS：冻结且字符串值稳定（端点/测试共用单一来源）', () => {
  assert.equal(Object.isFrozen(R), true)
  assert.deepEqual({ ...R }, {
    NEVER_PROBED: 'never-probed',
    BLOCKED_LEVELS: 'blocked-levels',
    PROBE_ERROR: 'probe-error',
    PERSIST_ERROR: 'persist-error',
    PENDING_APPLY: 'pending-apply',
    CONFIG_CHANGED: 'config-changed',
    SETTLED: 'settled',
    FORCED: 'forced',
  })
})

test('probeEntryNeedsProbe：无条目/非普通对象/无任何探测记录 → never-probed', () => {
  const entries = [
    undefined,
    null,
    [],
    'converged',
    42,
    {},
    { persisted: 42 },
    { working: 'low' },
    // 顺序敏感：只有 error、没有任何探测记录 → 仍按 never-probed（error 单独存在
    // 不算「上次探测结果」）。
    { error: 'boom' },
  ]
  for (const entry of entries) {
    assert.deepEqual(probeEntryNeedsProbe(entry), { probe: true, reason: R.NEVER_PROBED }, JSON.stringify(entry))
  }
})

test('probeEntryNeedsProbe：error 为非空字符串 → probe-error（优先于 blocked/persisted）；MAINT-047 N5 口径=字符串且非空', () => {
  assert.deepEqual(probeEntryNeedsProbe({ working: [], error: 'boom' }), { probe: true, reason: R.PROBE_ERROR })
  assert.deepEqual(
    probeEntryNeedsProbe({ working: [], error: 'boom', blocked: ['high'], persisted: 'pending-apply' }),
    { probe: true, reason: R.PROBE_ERROR },
  )
  // MAINT-047 N5：非字符串 error（对象）不算异常——口径与 /probe/apply 及客户端统一，
  // 按后续判定走（此处 blocked 非空 → blocked-levels）。
  assert.deepEqual(
    probeEntryNeedsProbe({ working: [], error: { code: 'X' }, blocked: ['high'], persisted: 'pending-apply' }),
    { probe: true, reason: R.BLOCKED_LEVELS },
  )
  assert.deepEqual(probeEntryNeedsProbe({ working: [], error: { code: 'X' }, persisted: 'converged' }), { probe: false, reason: R.SETTLED })
  assert.deepEqual(probeEntryNeedsProbe({ working: [], error: 42, persisted: 'converged' }), { probe: false, reason: R.SETTLED })
  // error 为 null/undefined/空串不算异常（空串若判 probe-error 会让模型永久重测）
  assert.deepEqual(probeEntryNeedsProbe({ working: [], error: null, persisted: 'converged' }), { probe: false, reason: R.SETTLED })
  assert.deepEqual(probeEntryNeedsProbe({ working: [], error: undefined, persisted: 'converged' }), { probe: false, reason: R.SETTLED })
  assert.deepEqual(probeEntryNeedsProbe({ working: [], error: '', persisted: 'converged' }), { probe: false, reason: R.SETTLED })
})

test('probeEntryNeedsProbe：blocked 非空 → blocked-levels（优先于 persisted 失败态）', () => {
  assert.deepEqual(
    probeEntryNeedsProbe({ working: ['low'], rejected: [], blocked: ['high'], persisted: 'converged' }),
    { probe: true, reason: R.BLOCKED_LEVELS },
  )
  assert.deepEqual(
    probeEntryNeedsProbe({ working: [], blocked: ['high'], persisted: 'persist-error' }),
    { probe: true, reason: R.BLOCKED_LEVELS },
  )
  // blocked 为空数组 / 非数组 → 不触发
  assert.deepEqual(probeEntryNeedsProbe({ working: [], blocked: [], persisted: 'converged' }), { probe: false, reason: R.SETTLED })
  assert.deepEqual(probeEntryNeedsProbe({ working: [], blocked: 'high', persisted: 'converged' }), { probe: false, reason: R.SETTLED })
})

test('probeEntryNeedsProbe：persisted 失败态 → persist-error / pending-apply', () => {
  assert.deepEqual(probeEntryNeedsProbe({ working: [], persisted: 'persist-error' }), { probe: true, reason: R.PERSIST_ERROR })
  assert.deepEqual(probeEntryNeedsProbe({ working: [], persisted: 'pending-apply' }), { probe: true, reason: R.PENDING_APPLY })
})

test('probeEntryNeedsProbe：定论类 persisted → settled（skip）', () => {
  const settled = [
    'converged',
    'no-change-already-correct',
    'written',
    'skipped:official-adapter',
    'skipped:not-in-pi-ai-config',
    'skipped:no-working',
  ]
  for (const persisted of settled) {
    assert.deepEqual(
      probeEntryNeedsProbe({ working: ['low'], rejected: ['high'], blocked: [], persisted }),
      { probe: false, reason: R.SETTLED },
      persisted,
    )
  }
})

test('planProbe：skipped:not-in-pi-ai-config + isConfigured=true → config-changed（R1/P2-1 新配置的模型）', () => {
  const lastProbe = {
    models: {
      'p/added': { working: [], rejected: [], blocked: [], persisted: 'skipped:not-in-pi-ai-config' },
      'p/absent': { working: [], rejected: [], blocked: [], persisted: 'skipped:not-in-pi-ai-config' },
    },
  }
  const calls = []
  const plan = planProbe({
    targets: [{ provider: 'p', model: 'added' }, { provider: 'p', model: 'absent' }],
    lastProbe,
    isConfigured: (provider, model) => {
      calls.push(provider + '/' + model)
      return model === 'added'
    },
  })
  assert.equal(plan.total, 2)
  assert.deepEqual(plan.probe, [{ provider: 'p', model: 'added', key: 'p/added', reason: R.CONFIG_CHANGED }])
  assert.deepEqual(plan.skip.map((row) => [row.key, row.reason]), [['p/absent', R.SETTLED]])
  assert.deepEqual(calls, ['p/added', 'p/absent'], 'isConfigured 按 targets 顺序收到 provider/model')
})

test('planProbe：config-changed 只改判 skipped:not-in-pi-ai-config（false/缺省/非函数/其它定论/force 均不受影响）', () => {
  const entry = { working: [], rejected: [], blocked: [], persisted: 'skipped:not-in-pi-ai-config' }
  const lastProbe = { models: { 'p/m': entry } }
  const targets = [{ provider: 'p', model: 'm' }]
  // isConfigured=false → skip(settled)
  const off = planProbe({ targets, lastProbe, isConfigured: () => false })
  assert.deepEqual(off.skip.map((row) => [row.key, row.reason]), [['p/m', R.SETTLED]])
  assert.deepEqual(off.probe, [])
  // 缺省 / 非函数 → 不做对账，仍 skip(settled)
  for (const isConfigured of [undefined, true, 'yes']) {
    const plan = planProbe({ targets, lastProbe, isConfigured })
    assert.deepEqual(plan.skip.map((row) => [row.key, row.reason]), [['p/m', R.SETTLED]], String(isConfigured))
    assert.deepEqual(plan.probe, [], String(isConfigured))
  }
  // 其它定论 persisted 即便 isConfigured=true 也不改判（skipped:official-adapter 不写 pi-ai 声明）
  for (const persisted of ['converged', 'no-change-already-correct', 'written', 'skipped:official-adapter', 'skipped:no-working']) {
    const plan = planProbe({
      targets,
      lastProbe: { models: { 'p/m': { working: [], rejected: [], blocked: [], persisted } } },
      isConfigured: () => true,
    })
    assert.deepEqual(plan.probe, [], persisted)
    assert.deepEqual(plan.skip.map((row) => [row.key, row.reason]), [['p/m', R.SETTLED]], persisted)
  }
  // force=true 优先：即便 isConfigured=true 也按 forced 全量重测
  const forced = planProbe({ targets, lastProbe, isConfigured: () => true, force: true })
  assert.deepEqual(forced.probe, [{ provider: 'p', model: 'm', key: 'p/m', reason: R.FORCED }])
  assert.deepEqual(forced.skip, [])
})

test('planProbe：lastProbe 缺失/非对象/models 非对象 → 全部 never-probed', () => {
  const targets = [{ provider: 'p', model: 'm1' }, { provider: 'p', model: 'm2' }]
  const absent = [undefined, null, 'x', [], {}, { models: [] }, { models: null }, { models: 'p/m1' }]
  for (const lastProbe of absent) {
    const plan = planProbe({ targets, lastProbe })
    assert.equal(plan.total, 2)
    assert.equal(plan.skip.length, 0)
    assert.deepEqual(plan.probe.map((row) => row.reason), [R.NEVER_PROBED, R.NEVER_PROBED])
    assert.equal(plan.force, false)
  }
})

test('planProbe：混合计划——定论 skip / blocked 重测 / 从未探测重测，total 对账', () => {
  const lastProbe = {
    t: 1,
    models: {
      'p/m1': { working: ['low'], rejected: [], blocked: [], persisted: 'converged' },
      'p/m2': { working: [], rejected: [], blocked: ['high'], persisted: 'pending-apply' },
    },
  }
  const plan = planProbe({
    targets: [{ provider: 'p', model: 'm1' }, { provider: 'p', model: 'm2' }, { provider: 'p', model: 'm3' }],
    lastProbe,
  })
  assert.equal(plan.total, 3)
  assert.equal(plan.force, false)
  assert.deepEqual(plan.probe, [
    { provider: 'p', model: 'm2', key: 'p/m2', reason: R.BLOCKED_LEVELS },
    { provider: 'p', model: 'm3', key: 'p/m3', reason: R.NEVER_PROBED },
  ])
  assert.deepEqual(plan.skip, [{
    provider: 'p',
    model: 'm1',
    key: 'p/m1',
    reason: R.SETTLED,
    entry: { working: ['low'], rejected: [], blocked: [], persisted: 'converged' },
  }])
})

test('planProbe：force=true → 全部 probe + reason=forced（跳过判定）', () => {
  const lastProbe = { models: { 'p/m1': { working: ['low'], rejected: [], blocked: [], persisted: 'converged' } } }
  const plan = planProbe({
    targets: [{ provider: 'p', model: 'm1' }, { provider: 'p', model: 'm2' }],
    lastProbe,
    force: true,
  })
  assert.equal(plan.force, true)
  assert.equal(plan.skip.length, 0)
  assert.equal(plan.total, 2)
  assert.deepEqual(plan.probe, [
    { provider: 'p', model: 'm1', key: 'p/m1', reason: R.FORCED },
    { provider: 'p', model: 'm2', key: 'p/m2', reason: R.FORCED },
  ])
  // force 必须是布尔 true（truthy 值不生效）
  const notForced = planProbe({ targets: [{ provider: 'p', model: 'm1' }], lastProbe, force: 1 })
  assert.equal(notForced.force, false)
  assert.equal(notForced.skip.length, 1)
})

test('planProbe：targets 非数组/缺省 → 空计划', () => {
  const empty = { probe: [], skip: [], total: 0, force: false }
  for (const targets of [undefined, null, 'p/m', 42, {}]) {
    assert.deepEqual(planProbe({ targets }), empty)
  }
  assert.deepEqual(planProbe(), empty)
})

test('planProbe：malformed targets 被跳过且不计 total', () => {
  const plan = planProbe({
    targets: [
      null,
      undefined,
      'p/m',
      42,
      [],
      {},
      { provider: 'p' },
      { model: 'm' },
      { provider: '', model: 'm' },
      { provider: 'p', model: '' },
      { provider: 1, model: 'm' },
      { provider: 'p', model: 2 },
      { provider: 'p', model: 'm1' },
    ],
  })
  assert.equal(plan.total, 1)
  assert.deepEqual(plan.probe, [{ provider: 'p', model: 'm1', key: 'p/m1', reason: R.NEVER_PROBED }])
  assert.deepEqual(plan.skip, [])
})

test('planProbe：key 兜底——target.key 非空字符串优先，否则 provider/model', () => {
  const lastProbe = { models: { custom: { working: ['low'], rejected: [], blocked: [], persisted: 'converged' } } }
  const plan = planProbe({
    targets: [
      { provider: 'p', model: 'm1', key: 'custom' },
      { provider: 'p', model: 'm2' },
      { provider: 'p', model: 'm3', key: '' },
      { provider: 'p', model: 'm4', key: 42 },
    ],
    lastProbe,
  })
  assert.deepEqual(plan.skip.map((row) => row.key), ['custom'])
  assert.deepEqual(plan.probe.map((row) => row.key), ['p/m2', 'p/m3', 'p/m4'])
})

test('planProbe：skip entry sanitize——多余字段不泄漏、缺失数组补 []、blockedReasons 非对象省略', () => {
  const lastProbe = {
    models: {
      'p/a': { working: ['low', 1, null, 'xhigh'], rejected: 'high', blocked: undefined, persisted: 'written', secret: 'leak', error: null },
      'p/b': { persisted: 'skipped:official-adapter' },
      'p/c': { working: [], rejected: [], blocked: [], persisted: 'converged', blockedReasons: 'oops' },
      'p/d': { working: [], rejected: [], blocked: [], persisted: 'converged', blockedReasons: { high: { code: 'X', message: 'm' } } },
    },
  }
  const plan = planProbe({ targets: ['a', 'b', 'c', 'd'].map((id) => ({ provider: 'p', model: id })), lastProbe })
  assert.equal(plan.skip.length, 4)
  const entryOf = new Map(plan.skip.map((row) => [row.key, row.entry]))
  assert.deepEqual(entryOf.get('p/a'), { working: ['low', 'xhigh'], rejected: [], blocked: [], persisted: 'written' })
  assert.equal('secret' in entryOf.get('p/a'), false)
  assert.equal('error' in entryOf.get('p/a'), false)
  // 缺失数组补 []；persisted 字符串保留
  assert.deepEqual(entryOf.get('p/b'), { working: [], rejected: [], blocked: [], persisted: 'skipped:official-adapter' })
  // blockedReasons 非普通对象 → 省略字段
  assert.equal('blockedReasons' in entryOf.get('p/c'), false)
  // blockedReasons 普通对象且非空 → 快照包含（且与 lastProbe 隔离）
  assert.deepEqual(entryOf.get('p/d').blockedReasons, { high: { code: 'X', message: 'm' } })
  entryOf.get('p/d').blockedReasons.high.code = 'MUTATED'
  assert.equal(lastProbe.models['p/d'].blockedReasons.high.code, 'X')
})

test('planProbe：probe/skip 各自保持 targets 顺序', () => {
  const lastProbe = {
    models: {
      'p/s1': { working: [], rejected: [], blocked: [], persisted: 'converged' },
      'p/s2': { working: [], rejected: [], blocked: [], persisted: 'written' },
    },
  }
  const plan = planProbe({
    targets: [
      { provider: 'p', model: 's1' },
      { provider: 'p', model: 'n1' },
      { provider: 'p', model: 's2' },
      { provider: 'p', model: 'n2' },
    ],
    lastProbe,
  })
  assert.deepEqual(plan.skip.map((row) => row.key), ['p/s1', 'p/s2'])
  assert.deepEqual(plan.probe.map((row) => row.key), ['p/n1', 'p/n2'])
})
