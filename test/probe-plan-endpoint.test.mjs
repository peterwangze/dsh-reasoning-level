/**
 * FEAT-009 计划端点判别测试：POST /reasoning-level-stats/probe/plan。
 *
 * 真实 lib/index.js apply + harness 路由投递（与 /probe 同门控/同解析路径）：
 *  - 混合计划：定论 skip（settled）/ blocked 重测 / 从未探测重测，total 对账；
 *  - force:true → 全部 probe（reason=forced）；
 *  - 非回环 Host + statsPublic:false → 403（与 /probe 同门控）；
 *  - 空 body → 空计划（targets 缺省视为 []）；
 *  - 计划端点纯只读：零 llm.stream 调用、零设置写；
 *  - 模型后加入 llm-pi-ai 配置：skipped:not-in-pi-ai-config → config-changed 重测。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeCtx, mount, callRoute } from './harness.mjs'

const PLAN = '/reasoning-level-stats/probe/plan'

const LAST_PROBE = {
  t: 1,
  models: {
    'p/m1': { working: ['low'], rejected: [], blocked: [], persisted: 'converged' },
    'p/m2': { working: [], rejected: [], blocked: ['high'], persisted: 'pending-apply' },
  },
}

test('plan-1 混合计划：m1 skip（settled）/ m2 probe（blocked-levels）/ m3 probe（never-probed），total=3', async () => {
  const { ctx, state } = makeCtx({ nsConfig: { enabled: false, statsPublic: true, lastProbe: LAST_PROBE } })
  await mount(ctx)
  assert.ok(state.routes.has(PLAN), 'probe/plan 路由必须已注册')
  const r = await callRoute(state, PLAN, {
    targets: [{ provider: 'p', model: 'm1' }, { provider: 'p', model: 'm2' }, { provider: 'p', model: 'm3' }],
    force: false,
  })
  assert.equal(r.code, 200)
  assert.equal(r.payload.total, 3)
  assert.equal(r.payload.force, false)
  // m1：上次定论 → skip，携带 sanitize 快照
  const m1 = r.payload.skip.find((row) => row.key === 'p/m1')
  assert.ok(m1 !== undefined, 'm1 必须在 skip（settled）')
  assert.equal(m1.reason, 'settled')
  assert.deepEqual(m1.entry, { working: ['low'], rejected: [], blocked: [], persisted: 'converged' })
  // m2：blocked 非空 → 重测
  const m2 = r.payload.probe.find((row) => row.key === 'p/m2')
  assert.ok(m2 !== undefined, 'm2 必须在 probe（blocked-levels）')
  assert.equal(m2.reason, 'blocked-levels')
  // m3：从未探测 → 重测
  const m3 = r.payload.probe.find((row) => row.key === 'p/m3')
  assert.ok(m3 !== undefined, 'm3 必须在 probe（never-probed）')
  assert.equal(m3.reason, 'never-probed')
  // probe 保持 targets 顺序
  assert.deepEqual(r.payload.probe.map((row) => row.key), ['p/m2', 'p/m3'])
})

test('plan-2 force:true → 全部 probe（reason=forced），skip 为空', async () => {
  const { ctx, state } = makeCtx({ nsConfig: { enabled: false, statsPublic: true, lastProbe: LAST_PROBE } })
  await mount(ctx)
  const r = await callRoute(state, PLAN, {
    targets: [{ provider: 'p', model: 'm1' }, { provider: 'p', model: 'm2' }, { provider: 'p', model: 'm3' }],
    force: true,
  })
  assert.equal(r.code, 200)
  assert.equal(r.payload.force, true)
  assert.equal(r.payload.skip.length, 0)
  assert.equal(r.payload.total, 3)
  assert.deepEqual(r.payload.probe.map((row) => [row.key, row.reason]), [
    ['p/m1', 'forced'],
    ['p/m2', 'forced'],
    ['p/m3', 'forced'],
  ])
})

test('plan-3 非回环 Host + statsPublic:false → 403（与 /probe 同门控）', async () => {
  const { ctx, state } = makeCtx({ nsConfig: { enabled: false, statsPublic: false, lastProbe: LAST_PROBE } })
  await mount(ctx)
  const r = await callRoute(state, PLAN, { targets: [{ provider: 'p', model: 'm1' }] }, 'example.com')
  assert.equal(r.code, 403)
  assert.equal(r.payload.text, 'forbidden')
})

test('plan-4 空 body → 空计划（targets 缺省视为 []）', async () => {
  const { ctx, state } = makeCtx({ nsConfig: { enabled: false, statsPublic: true, lastProbe: LAST_PROBE } })
  await mount(ctx)
  for (const body of [{}, '']) {
    const r = await callRoute(state, PLAN, body)
    assert.equal(r.code, 200)
    assert.deepEqual(r.payload, { probe: [], skip: [], total: 0, force: false })
  }
})

test('plan-5 计划端点纯只读：零 llm.stream 调用、零设置写', async () => {
  let streamCalls = 0
  const { ctx, state } = makeCtx({
    nsConfig: { enabled: false, statsPublic: true, lastProbe: LAST_PROBE },
    // 调用即计数（不依赖是否迭代流），确保「零实测」断言覆盖任何 stream 调用点。
    stream: () => {
      streamCalls += 1
      return (async function* () {})()
    },
  })
  await mount(ctx)
  const before = { mutate: state.mutateCalls.length, replace: state.replaceCalls.length }
  const r = await callRoute(state, PLAN, {
    targets: [{ provider: 'p', model: 'm1' }, { provider: 'p', model: 'm2' }, { provider: 'p', model: 'm3' }],
    force: true,
  })
  assert.equal(r.code, 200)
  assert.equal(streamCalls, 0, '计划端点不得发起任何实测请求')
  assert.equal(state.mutateCalls.length, before.mutate, '计划端点不得写设置（mutate）')
  assert.equal(state.replaceCalls.length, before.replace, '计划端点不得写设置（replace）')
})

test('plan-6 模型后加入 llm-pi-ai 配置：skipped:not-in-pi-ai-config → probe（config-changed），未加入仍 skip', async () => {
  const lastProbe = {
    t: 2,
    models: {
      'p/added': { working: [], rejected: [], blocked: [], persisted: 'skipped:not-in-pi-ai-config' },
      'p/absent': { working: [], rejected: [], blocked: [], persisted: 'skipped:not-in-pi-ai-config' },
    },
  }
  const piAiSection = { providers: { p: { api: 'openai-completions', models: [{ id: 'added' }] } } }
  const { ctx, state } = makeCtx({ nsConfig: { enabled: false, statsPublic: true, lastProbe }, piAiSection })
  await mount(ctx)
  const r = await callRoute(state, PLAN, {
    targets: [{ provider: 'p', model: 'added' }, { provider: 'p', model: 'absent' }],
  })
  assert.equal(r.code, 200)
  const added = r.payload.probe.find((row) => row.key === 'p/added')
  assert.ok(added !== undefined, '已加入 pi-ai 配置的模型必须重测（R1/P2-1）')
  assert.equal(added.reason, 'config-changed')
  const absent = r.payload.skip.find((row) => row.key === 'p/absent')
  assert.ok(absent !== undefined, '未加入配置的模型仍沿用上次定论')
  assert.equal(absent.reason, 'settled')
})
