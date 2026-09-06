/**
 * MAINT-027 判别测试（RCA docs/retro/rca-MAINT-027-028.md §5.1；真实 lib/index.js
 * + store-harness 持久面，node --test 无浏览器依赖）。
 *
 * 判别维度（修复前必须 RED 的断言逐条标注；现状 GREEN 防倒退断言同样标注）：
 *  (a) 全 7 档可用模型探测：
 *      - no-change 收敛路径补写 pin（probeEfforts 落盘）—— 027-F2 修复前 RED（MAINT-019 P3-1）
 *      - /probe 响应含每模型持久化结局 persisted —— 027-F1 修复前 RED（MAINT-019 P2-2 配套）
 *      - 能力声明 7 键（含 xhigh）在盘 —— 现状 GREEN（防倒退）
 *  (b) 部分档位可用（xhigh 被拒）：收敛替换主路径 pin 落盘 —— 现状 GREEN（防修复扰动
 *      收敛主路径）；persisted='converged' —— 027-F1 修复前 RED
 *  (c) 探测目标不在 llm-pi-ai 配置：响应结局显式 skipped:not-in-pi-ai-config ——
 *      027-F1 修复前 RED；lastProbe 记录该结局 —— 027-F3 修复前 RED
 *  (d) lastProbe 持久回显：/probe 收口写 llm-reasoning.lastProbe（时间戳+working/
 *      rejected/blocked/persisted）；/reasoning-level-stats 带回；/probe/apply 收口
 *      按结局更新（written）；响应含 per-model outcomes —— 027-F3 修复前 RED
 *  (e) apply 对「探测已收敛/已一致」的模型：writes 如实为 0 + outcomes
 *      already-verified + lastProbe 不降级（保留 converged/no-change 语义）——
 *      027-F1/F3 修复前 RED（「固化 N 处恒 0」措辞诚实化的服务端事实源）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mount, callRoute, validatingStream, probeEffortsMutates, getModelReasoningEfforts } from './harness.mjs'
import { makeStoreCtx, lastProbeMutates } from './store-harness.mjs'

const PROBE = '/reasoning-level-stats/probe'
const APPLY = '/reasoning-level-stats/probe/apply'
const STATS = '/reasoning-level-stats'

const clone = (v) => JSON.parse(JSON.stringify(v))
const FULL7 = { off: null, minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' }
const REJECT = (level) => ({ kind: 'error', failure: { code: 'UNSUPPORTED_REASONING_EFFORT', message: `reasoning effort "${level}" is not supported` } })

/** 挂载一个 store 上下文并返回 state（stream 桩按需注入）。 */
async function mountStore(store, stream) {
  let state
  const made = makeStoreCtx(store, { stream: stream === undefined ? undefined : validatingStream(() => state, stream) })
  state = made.state
  await mount(made.ctx)
  return state
}

test('(a) 全 7 档可用：no-change 收敛补写 pin（027-F2，修复前 RED）+ 响应携带持久化结局（027-F1，修复前 RED）+ 声明 7 键在盘（现状 GREEN）', async () => {
  const store = {
    nsConfig: { enabled: false, statsPublic: true },
    piAi: { providers: { 'glm-local': { api: 'openai-completions', models: [{ id: 'glm-5.3' }] } } },
    deepseek: undefined,
  }
  const state = await mountStore(store, {})
  const r = await callRoute(state, PROBE, { provider: 'glm-local', model: 'glm-5.3' })
  assert.equal(r.code, 200)
  assert.equal(r.payload.working.length, 7)
  // 现状 GREEN（防倒退）：能力声明 7 键（含 xhigh）在盘
  const decl = getModelReasoningEfforts(state, 'glm-local', 'glm-5.3')
  assert.equal(Object.keys(decl).length, 7)
  assert.equal(decl.xhigh, 'xhigh')
  // 027-F2（修复前 RED）：no-change 路径必须补写 pin（probeEfforts 落盘，值 = 最终声明）
  const pe = probeEffortsMutates(state)
  assert.ok(pe.length >= 1, 'no-change 收敛必须补写 probeEfforts pin（MAINT-019 P3-1 / 027-F2）')
  assert.deepEqual(pe[pe.length - 1].ops[0].value['glm-local/glm-5.3'], decl)
  // 027-F1（修复前 RED）：/probe 响应含每模型持久化结局
  assert.equal(r.payload.persisted, 'no-change-already-correct', '全档可用 + 声明已收敛 → no-change-already-correct')
})

test('(b) 部分档位可用：收敛替换主路径 pin 落盘（现状 GREEN）+ persisted=converged（027-F1，修复前 RED）', async () => {
  const store = {
    nsConfig: { enabled: false, statsPublic: true },
    piAi: { providers: { gw: { api: 'openai-completions', models: [{ id: 'm1' }] } } },
    deepseek: undefined,
  }
  const state = await mountStore(store, { xhigh: REJECT('xhigh') })
  const r = await callRoute(state, PROBE, { provider: 'gw', model: 'm1' })
  assert.equal(r.code, 200)
  assert.equal(r.payload.working.length, 6)
  assert.deepEqual(r.payload.rejected, ['xhigh'])
  // 现状 GREEN（防倒退）：收敛替换主路径 pin 落盘 + 声明收敛为 working 集
  const pe = probeEffortsMutates(state)
  assert.ok(pe.length >= 1, '收敛替换主路径 pin 落盘（既有行为，防修复扰动）')
  const decl = getModelReasoningEfforts(state, 'gw', 'm1')
  assert.equal(Object.keys(decl).length, 6)
  assert.equal(decl.xhigh, undefined)
  assert.deepEqual(pe[pe.length - 1].ops[0].value['gw/m1'], decl)
  // 027-F1（修复前 RED）
  assert.equal(r.payload.persisted, 'converged')
})

test('(c) 目标不在 llm-pi-ai 配置：结局显式 skipped:not-in-pi-ai-config（027-F1，修复前 RED）+ lastProbe 记录（027-F3，修复前 RED）+ 零 pin', async () => {
  const store = {
    nsConfig: { enabled: false, statsPublic: true },
    piAi: { providers: { 'glm-local': { api: 'openai-completions', models: [{ id: 'glm-5.3' }] } } },
    deepseek: undefined,
  }
  const state = await mountStore(store, {})
  const r = await callRoute(state, PROBE, { provider: 'other-provider', model: 'm9' })
  assert.equal(r.code, 200)
  assert.ok(r.payload.working.length >= 1)
  // 027-F1（修复前 RED）：越界目标结局显式化，不再静默
  assert.equal(r.payload.persisted, 'skipped:not-in-pi-ai-config')
  // 零持久化：不写 pin
  assert.equal(probeEffortsMutates(state).length, 0)
  // 027-F3（修复前 RED）：lastProbe 记录该结局（结果仅展示，未写入）
  const lp = lastProbeMutates(state)
  assert.ok(lp.length >= 1, '/probe 收口必须写入 lastProbe（含越界目标）')
  assert.equal(lp[lp.length - 1].ops[0].value.models['other-provider/m9'].persisted, 'skipped:not-in-pi-ai-config')
})

test('(d) lastProbe 持久回显：/probe 收口写入 + stats 端点带回 + /probe/apply 收口按结局更新（027-F3，修复前 RED）', async () => {
  // 种子：模型已有历史探测固化的全量 7 键声明；本次实测 xhigh 被拒 → 声明与实测不一致
  // → 探测阶段 persisted=pending-apply → apply 替换写入 → lastProbe 更新为 written
  const store = {
    nsConfig: { enabled: false, statsPublic: true },
    piAi: { providers: { gw: { api: 'openai-completions', models: [{ id: 'm1', reasoningEfforts: clone(FULL7) }] } } },
    deepseek: undefined,
  }
  const state = await mountStore(store, { xhigh: REJECT('xhigh') })
  const r = await callRoute(state, PROBE, { provider: 'gw', model: 'm1' })
  assert.equal(r.code, 200)
  assert.equal(r.payload.working.length, 6)
  // 027-F1（修复前 RED）：声明与实测不一致且探测不改声明 → 待固化
  assert.equal(r.payload.persisted, 'pending-apply')
  // 027-F3（修复前 RED）：lastProbe = { t, models['gw/m1'] = {working, rejected, blocked, persisted} }
  const lp1 = lastProbeMutates(state)
  assert.ok(lp1.length >= 1, '/probe 收口必须写入 lastProbe')
  const entry1 = lp1[lp1.length - 1].ops[0].value
  assert.equal(typeof entry1.t, 'number')
  assert.equal(entry1.models['gw/m1'].persisted, 'pending-apply')
  assert.deepEqual(entry1.models['gw/m1'].working.sort(), r.payload.working.slice().sort())
  assert.deepEqual(entry1.models['gw/m1'].rejected, ['xhigh'])
  // 027-F3（修复前 RED）：/reasoning-level-stats 带回 lastProbe（挂载回显数据源）
  const stats1 = await callRoute(state, STATS, {})
  assert.ok(stats1.payload.lastProbe !== undefined, 'stats 端点必须带回 lastProbe')
  assert.equal(stats1.payload.lastProbe.models['gw/m1'].persisted, 'pending-apply')
  // /probe/apply 收口：替换写入 + per-model outcomes + lastProbe 更新
  const a = await callRoute(state, APPLY, {
    results: [{ key: 'gw/m1', provider: 'gw', model: 'm1', working: r.payload.working, rejected: ['xhigh'], blocked: [] }],
  })
  assert.equal(a.code, 200)
  assert.equal(a.payload.writes, 1)
  // 027-F3（修复前 RED）：apply 响应含 per-model 结局
  const oc = (a.payload.outcomes ?? []).find((o) => o.key === 'gw/m1')
  assert.ok(oc !== undefined, 'apply 响应必须含 per-model outcomes')
  assert.equal(oc.outcome, 'written')
  // lastProbe 收口更新为 written
  const lp2 = lastProbeMutates(state)
  const entry2 = lp2[lp2.length - 1].ops[0].value
  assert.equal(entry2.models['gw/m1'].persisted, 'written')
  const stats2 = await callRoute(state, STATS, {})
  assert.equal(stats2.payload.lastProbe.models['gw/m1'].persisted, 'written')
  // 声明收敛为 6 键
  const decl = getModelReasoningEfforts(state, 'gw', 'm1')
  assert.equal(Object.keys(decl).length, 6)
})

test('(e) apply 对已一致模型：writes 如实 0 + outcomes already-verified + lastProbe 不降级（027-F1/F3，修复前 RED）', async () => {
  // 种子：模型无声明 → 探测全档可用 → no-change 收敛（补 pin）→ apply 见已一致
  const store = {
    nsConfig: { enabled: false, statsPublic: true },
    piAi: { providers: { 'glm-local': { api: 'openai-completions', models: [{ id: 'glm-5.3' }] } } },
    deepseek: undefined,
  }
  const state = await mountStore(store, {})
  const r = await callRoute(state, PROBE, { provider: 'glm-local', model: 'glm-5.3' })
  assert.equal(r.payload.persisted, 'no-change-already-correct')
  const a = await callRoute(state, APPLY, {
    results: [{ key: 'glm-local/glm-5.3', provider: 'glm-local', model: 'glm-5.3', working: r.payload.working, rejected: [], blocked: [] }],
  })
  assert.equal(a.code, 200)
  // writes 如实为 0（声明已与实测一致——服务端事实源；「固化 N 处恒 0」由客户端按结局措辞诚实化）
  assert.equal(a.payload.writes, 0)
  // 027-F3（修复前 RED）：per-model outcome = already-verified（而非笼统 skipped）
  const oc = (a.payload.outcomes ?? []).find((o) => o.key === 'glm-local/glm-5.3')
  assert.ok(oc !== undefined, 'apply 响应必须含 per-model outcomes（already-verified 语义）')
  assert.equal(oc.outcome, 'already-verified')
  // lastProbe 不降级：保留探测阶段结局（no-change-already-correct），apply 确认不改写
  const lp = lastProbeMutates(state)
  const entry = lp[lp.length - 1].ops[0].value
  assert.equal(entry.models['glm-local/glm-5.3'].persisted, 'no-change-already-correct')
})
