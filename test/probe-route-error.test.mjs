/**
 * MAINT-046 判别测试：/probe 路由对带非空 error 的结果不写 lastProbe。
 *
 * 背景：probeModelLevelsCore 在「无候选档位」时返回 {…, error: 'no candidate levels'}；
 * /probe 路由此前对任何结果无守卫地调用 recordLastProbe → 把
 * {working:[], rejected:[], blocked:[], persisted:'pending-apply'} 写进
 * llm-reasoning.lastProbe，已 converged 的条目被降级，增量计划（probe-plan）随后
 * 把该模型判为 pending-apply 重测。/probe/apply 已有同口径守卫（FEAT-009 R1 P1-1），
 * 本轮把 /probe 路由补齐；响应仍如实返回 result（含 error）。
 *
 * 场景构造沿用 probe-errors.test.mjs 的 err-1：候选底集 = 词汇表全量 7 档 ∪ 目录声明
 * ∪ 配置声明，恒非空——只有客户端 levels 过滤到不存在的等级才会「无候选档位」
 * （目录/配置均无该模型声明本身不触发）。夹具：harness.mjs 的 makeCtx/mount/callRoute。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeCtx, mount, callRoute, statusChunks } from './harness.mjs'
import { planProbe } from '../lib/probe-plan.js'

const PROBE = '/reasoning-level-stats/probe'

/** 既有 lastProbe 条目（已收敛定论）——本轮守卫要保护的对象。 */
const CONVERGED_LAST_PROBE = {
  t: 1,
  models: { 'p/m': { working: ['low'], rejected: [], blocked: [], persisted: 'converged' } },
}

/** 与 harness 的 probeEffortsMutates 同写法：筛出 path 恰为 ['lastProbe'] 的 mutate 调用。 */
function lastProbeWrites(state) {
  return state.mutateCalls.filter((c) => JSON.stringify(c.ops[0]?.path) === '["lastProbe"]')
}

test('(MAINT-046 正相) /probe 返回带 error 的「无候选档位」结果：不写 lastProbe，converged 条目保持 settled', async () => {
  const { ctx, state } = makeCtx({
    nsConfig: { enabled: false, statsPublic: true, lastProbe: CONVERGED_LAST_PROBE },
  })
  await mount(ctx)
  const r = await callRoute(state, PROBE, { provider: 'p', model: 'm', levels: ['nonexistent'] })
  assert.equal(r.code, 200)
  // 响应照常如实返回（含 error）——守卫只作用于持久化，不改响应面
  assert.equal(typeof r.payload.error, 'string')
  assert.notEqual(r.payload.error, '')
  assert.equal(r.payload.error, 'no candidate levels')
  assert.deepEqual(r.payload.working, [])
  // 守卫：带 error 的结果不是实测定论——零 lastProbe 写（否则 converged → pending-apply 降级）
  assert.equal(lastProbeWrites(state).length, 0, '带 error 的结果不得写 lastProbe')
  // 原 converged 条目原样保留 → 增量计划仍判 settled（沿用上次结果）
  assert.equal(state.nsConfig.lastProbe.models['p/m'].persisted, 'converged')
  const plan = planProbe({ targets: [{ provider: 'p', model: 'm' }], lastProbe: state.nsConfig.lastProbe })
  assert.equal(plan.probe.length, 0)
  assert.equal(plan.skip.length, 1)
  assert.equal(plan.skip[0].reason, 'settled')
  assert.equal(plan.skip[0].entry.persisted, 'converged')
})

test('(MAINT-046 负相) /probe 正常实测结果（无 error）：仍按 027-F3 写 lastProbe', async () => {
  const { ctx, state } = makeCtx({
    nsConfig: { enabled: false, statsPublic: true, lastProbe: CONVERGED_LAST_PROBE },
    resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low' }] } }),
    stream: (opts) => statusChunks({ kind: 'stop', failure: null })(opts),
  })
  await mount(ctx)
  const r = await callRoute(state, PROBE, { provider: 'p', model: 'm' })
  assert.equal(r.code, 200)
  assert.equal(r.payload.error, undefined, '正常实测结果不带 error')
  assert.ok(r.payload.working.length >= 1)
  // 模型不在 llm-pi-ai 配置 → 结局显式 skipped:not-in-pi-ai-config（027-F1 既有语义）
  assert.equal(r.payload.persisted, 'skipped:not-in-pi-ai-config')
  // 守卫只拦 error 行：正常结果照常写 lastProbe，条目与响应同源且不携带 error 字段
  const writes = lastProbeWrites(state)
  assert.equal(writes.length, 1, '正常实测结果必须写 lastProbe')
  assert.equal(writes[0].ns, 'llm-reasoning')
  const entry = writes[0].ops[0].value.models['p/m']
  assert.ok(entry !== undefined)
  assert.equal(entry.persisted, 'skipped:not-in-pi-ai-config')
  assert.deepEqual(entry.working.slice().sort(), r.payload.working.slice().sort())
  assert.equal(entry.error, undefined, 'lastProbe 条目不携带 error 字段')
})
