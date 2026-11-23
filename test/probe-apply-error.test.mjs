/**
 * FEAT-009 R1（P1-1）判别测试：失败探测行不得被 /probe/apply 固化。
 *
 * 背景（R0 审查 §4 P1-1）：客户端探测失败时会生成带 error 的空结果行并送入
 * /probe/apply；服务端若按 working: [] 处理，会把既有 lastProbe 条目（如
 * pending-apply / 已 convergent 条目）覆盖成 skipped:no-working，增量计划随后
 * 判定 settled，该模型从此不再被重测（只能手动「全量重探」）。
 * 修复后服务端守卫跳过带非空 error 的行：零 outcome、零声明写、零 lastProbe 写，
 * 原 persisted 保持 → 下次计划继续判为需重测。
 *
 * 夹具：store-harness 的 live store（mutate/replace 就地应用）——只有它才能真实
 * 观察 lastProbe 是否被改写；负相证明守卫只拦 error 行，正常空 working 语义不变。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mount, callRoute } from './harness.mjs'
import { makeStoreCtx, lastProbeMutates } from './store-harness.mjs'

const APPLY = '/reasoning-level-stats/probe/apply'
const PLAN = '/reasoning-level-stats/probe/plan'

/** 带既有 lastProbe 条目（pending-apply）且模型在 llm-pi-ai 配置内的 store。 */
function makeStore() {
  return {
    nsConfig: {
      enabled: false,
      statsPublic: true,
      lastProbe: {
        t: 1,
        models: { 'p/m': { working: ['low'], rejected: [], blocked: [], persisted: 'pending-apply' } },
      },
    },
    piAi: { providers: { p: { api: 'openai-completions', models: [{ id: 'm' }] } } },
    deepseek: undefined,
  }
}

async function mountStore(store) {
  const { ctx, state } = makeStoreCtx(store)
  await mount(ctx)
  return state
}

test('(R1/P1-1) 带 error 的失败探测行：零 outcome、零 lastProbe 写，增量计划仍判需重测', async () => {
  const store = makeStore()
  const state = await mountStore(store)
  const before = { mutate: lastProbeMutates(state).length, replace: state.replaceCalls.length }
  const r = await callRoute(state, APPLY, {
    results: [{ provider: 'p', model: 'm', error: '探测请求失败', working: [], rejected: [], blocked: [] }],
  })
  assert.equal(r.code, 200)
  assert.equal(r.payload.writes, 0, '失败行不得写入声明')
  assert.deepEqual(r.payload.outcomes, [], '失败行不得产生固化 outcome')
  assert.equal(lastProbeMutates(state).length, before.mutate, '失败行不得写 lastProbe（否则条目被降级为定论）')
  assert.equal(state.replaceCalls.length, before.replace, '失败行不得触发 llm-pi-ai 整节写')
  // 原持久化条目保持 pending-apply
  assert.equal(store.nsConfig.lastProbe.models['p/m'].persisted, 'pending-apply')
  // 下一次增量计划必须仍把该模型判为需重测
  const plan = await callRoute(state, PLAN, { targets: [{ provider: 'p', model: 'm' }] })
  assert.equal(plan.code, 200)
  const row = plan.payload.probe.find((entry) => entry.key === 'p/m')
  assert.ok(row !== undefined, '下次计划必须仍把该模型判为需重测')
  assert.equal(row.reason, 'pending-apply')
  assert.equal(plan.payload.skip.length, 0)
})

test('(R1/P1-1 负相) 无 error、working=[] 的 apply 仍按现语义产出 no-working-levels 并收口 lastProbe', async () => {
  const store = makeStore()
  const state = await mountStore(store)
  const r = await callRoute(state, APPLY, {
    results: [{ provider: 'p', model: 'm', working: [], rejected: [], blocked: [] }],
  })
  assert.equal(r.code, 200)
  assert.equal(r.payload.writes, 0)
  // 守卫只拦 error 行：正常空 working 仍走既有 no-working-levels 语义
  assert.deepEqual(r.payload.outcomes, [{ key: 'p/m', outcome: 'no-working-levels' }])
  const lp = lastProbeMutates(state)
  assert.equal(lp.length, 1, '正常空 working 行按既有语义收口 lastProbe')
  assert.equal(lp[0].ops[0].value.models['p/m'].persisted, 'skipped:no-working')
  // 对照：该模型随后被判 settled（既有语义，不是本轮守卫要改变的行为）
  const plan = await callRoute(state, PLAN, { targets: [{ provider: 'p', model: 'm' }] })
  assert.equal(plan.payload.probe.length, 0)
  assert.equal(plan.payload.skip[0].reason, 'settled')
})
