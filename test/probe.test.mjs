/**
 * DEV-002 F8 最小回归测试：v0.7.0 一键探测/固化核心逻辑。
 *
 * 覆盖（对应 R0 报告 F8 建议用例 a-d）：
 *  (a) probeModelLevels 分类：ok / rejected(UNSUPPORTED_REASONING_EFFORT) / blocked(aborted)；
 *  (b) applyProbeResults：用户手写声明跳过、working 白名单、pin 台账；
 *  (c) persistBlacklist / hydrateBlacklist：幂等合并（去重、相同值不再写）；
 *  (d) F1 回归：probeEfforts 值 schema 显式 string|null，含 'disabled' 的 wire 值
 *      通过校验、非字符串被拒绝（旧版 z.union([...LEVELS, null]) 经
 *      Schema.from(null) → any() 直通，任意线值都能落盘——见 R1 §0.5）；
 *  (e) F2 回归：settings.replace 失败时返回 writes:0 + error、且不发出
 *      probeEfforts 持久化；重试成功时 replace 先于 mutate。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeCtx, mount, callRoute, statusChunks, blacklistMutates, probeEffortsMutates } from './harness.mjs'

const NS = 'llm-reasoning'

test('(a) probeModelLevels：ok/rejected/blocked 分类，拒绝等级入黑名单并持久化', async () => {
  const reasons = {
    low: { kind: 'stop', failure: null },
    high: { kind: 'error', failure: { code: 'UNSUPPORTED_REASONING_EFFORT', message: 'gateway does not support reasoning effort "high"' } },
    medium: { kind: 'aborted', failure: null },
  }
  const { ctx, state } = makeCtx({
    nsConfig: { enabled: false, statsPublic: true },
    resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low' }, { id: 'high' }, { id: 'medium' }] } }),
    stream: (opts) => statusChunks(reasons[opts.reasoningEffort])(opts),
  })
  await mount(ctx)
  const r = await callRoute(state, '/reasoning-level-stats/probe', { provider: 'p', model: 'm' })
  assert.equal(r.code, 200)
  assert.equal(r.payload.working.join(','), 'low')
  assert.equal(r.payload.rejected.join(','), 'high')
  assert.equal(r.payload.blocked.join(','), 'medium')
  assert.equal(r.payload.key, 'p/m')
  // 拒绝等级 -> markRejected -> persistBlacklist（settings.mutate set probeBlacklist）
  const bl = blacklistMutates(state)
  assert.equal(bl.length, 1)
  assert.deepEqual(bl[0].ops[0].path, ['probeBlacklist'])
  assert.deepEqual(bl[0].ops[0].value, { 'p/m': ['high'] })
})

test('(b) applyProbeResults：用户手写声明跳过，不写回、不 replace', async () => {
  const piAi = { providers: { gateway: { api: 'openai-completions', models: [{ id: 'm1', reasoningEfforts: { low: 'low' } }] } } }
  const { ctx, state } = makeCtx({
    nsConfig: { enabled: false, statsPublic: true },
    piAiSection: piAi,
  })
  await mount(ctx)
  const r = await callRoute(state, '/reasoning-level-stats/probe/apply', {
    results: [{ provider: 'gateway', model: 'm1', working: ['off', 'low'], rejected: [], blocked: [] }],
  })
  assert.equal(r.code, 200)
  assert.equal(r.payload.writes, 0)
  assert.equal(r.payload.skipped.length, 1)
  assert.equal(r.payload.skipped[0].reason, 'user-declared')
  assert.equal(state.replaceCalls.length, 0)
  assert.equal(probeEffortsMutates(state).length, 0)
})

test('(b) applyProbeResults：zai 路由 working 白名单固化 + pin 持久化（disabled wire 值）', async () => {
  const piAi = { providers: { zai: { api: 'openai-completions', models: [{ id: 'm2' }] } } }
  const { ctx, state } = makeCtx({
    nsConfig: { enabled: false, statsPublic: true },
    piAiSection: piAi,
  })
  await mount(ctx)
  const r = await callRoute(state, '/reasoning-level-stats/probe/apply', {
    results: [{ provider: 'zai', model: 'm2', working: ['off', 'low', 'xhigh'], rejected: ['high'], blocked: [] }],
  })
  assert.equal(r.code, 200)
  assert.equal(r.payload.writes, 1)
  // working 白名单：仅 GENERATED_LEVELS ∩ working 且有生成线值的档
  // （off='disabled'、low='low'；xhigh 无生成线值被滤掉；high 被拒绝不入固化）
  assert.deepEqual(state.replaceCalls[0].value.providers.zai.models[0].reasoningEfforts, { off: 'disabled', low: 'low' })
  // pin 持久化：probeEfforts 写入（T1 注释修正——按 R1 §0.5：旧 schema 在本机
  // schemastery 3.18.1 下经 Schema.from(null)→any() 直通，'disabled' 实际能落盘，
  // 代价是线值零校验；并非"校验失败静默不落盘"）
  const pe = probeEffortsMutates(state)
  assert.equal(pe.length, 1)
  assert.deepEqual(pe[0].ops[0].value, { 'zai/m2': { off: 'disabled', low: 'low' } })
  // F1：schema 接受含 'disabled' 的 probeEfforts（用真实注册的 Config schema 校验）
  const schema = state.schemas.get(NS)
  assert.ok(schema, 'Config schema must be registered')
  const parsed = schema({ probeEfforts: { 'zai/m2': { off: 'disabled', low: 'low' } } })
  assert.deepEqual(parsed.probeEfforts, { 'zai/m2': { off: 'disabled', low: 'low' } })
})

test('(d) F1 回归：probeEfforts 值 schema = string|null（接受 disabled/null，拒绝非字符串）', async () => {
  const { ctx, state } = makeCtx({ nsConfig: { enabled: false, statsPublic: true } })
  await mount(ctx)
  const schema = state.schemas.get(NS)
  const parsed = schema({
    probeEfforts: {
      'zai/m2': { off: 'disabled', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', max: 'max' },
      'openai/m3': { off: null, low: 'low' },
    },
  })
  assert.deepEqual(parsed.probeEfforts['zai/m2'], { off: 'disabled', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', max: 'max' })
  assert.equal(parsed.probeEfforts['openai/m3'].off, null)
  // 值 schema 明确为 string|null：非字符串值被拒绝（旧 union 的 null 成员经
  // Schema.from(null) 编译为 any()，任意值都会通过——线值完全未校验）
  assert.throws(() => schema({ probeEfforts: { 'zai/m2': { off: 123 } } }))
})

test('(c) hydrateBlacklist + persistBlacklist：幂等合并（去重、相同值不再写）', async () => {
  const { ctx, state } = makeCtx({
    nsConfig: { enabled: false, statsPublic: true, probeBlacklist: { 'a/b': ['low'] } },
    resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'high' }] } }),
    stream: (opts) => statusChunks({ kind: 'error', failure: { code: 'UNSUPPORTED_REASONING_EFFORT', message: 'no reasoning effort "high"' } })(opts),
  })
  await mount(ctx)
  const r1 = await callRoute(state, '/reasoning-level-stats/probe', { provider: 'a', model: 'b' })
  assert.equal(r1.payload.rejected.join(','), 'high')
  // hydrate（启动恢复 ['low']）与实测拒绝 'high' 合并持久化，无重复
  const bl = blacklistMutates(state)
  assert.equal(bl.length, 1)
  assert.deepEqual(bl[0].ops[0].value, { 'a/b': ['high', 'low'] })
  // 再次拒绝同一等级：sets 去重，不重复持久化（幂等）
  await callRoute(state, '/reasoning-level-stats/probe', { provider: 'a', model: 'b' })
  assert.equal(blacklistMutates(state).length, 1)
})

test('(e) F2 回归：replace 失败不产生 pin 分叉；重试成功时 replace 先于 probeEfforts 持久化', async () => {
  let fail = true
  const piAi = { providers: { zai: { api: 'openai-completions', models: [{ id: 'm3' }] } } }
  const { ctx, state } = makeCtx({
    nsConfig: { enabled: false, statsPublic: true },
    piAiSection: piAi,
    replaceImpl: async () => {
      if (fail) throw new Error('disk full')
    },
  })
  await mount(ctx)
  const results = [{ provider: 'zai', model: 'm3', working: ['off', 'low'], rejected: [], blocked: [] }]
  const r1 = await callRoute(state, '/reasoning-level-stats/probe/apply', { results })
  assert.equal(r1.code, 200)
  assert.equal(r1.payload.writes, 0)
  assert.ok(r1.payload.error.includes('disk full'))
  // 失败路径：不发出 probeEfforts 持久化（内存台账未落、磁盘未改，无分叉）
  assert.equal(probeEffortsMutates(state).length, 0)
  // 重试成功：出本次写入事件顺序为 replace -> mutate（先落盘再持久化台账）
  fail = false
  const r2 = await callRoute(state, '/reasoning-level-stats/probe/apply', { results })
  assert.equal(r2.payload.writes, 1)
  const order = state.events.slice(-2)
  assert.deepEqual(order, ['replace:llm-pi-ai', 'mutate:' + NS])
})
