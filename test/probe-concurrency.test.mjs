/**
 * 并发边界（QA 硬门槛：并发类 ≥1 用例）：
 * probeModelLevels 以 PROBE_CONCURRENCY=3 并发探测，任意时刻在途探测 ≤ 3；
 * 并发 + 混合结束原因的分类矩阵（working/rejected/blocked）。
 * MAINT-013（0.7.1）：探测拒绝不入黑名单——rejected 仅作为该次探测结果返回。
 * MAINT-017（0.8.0）：候选集 = 词汇表全量 7 档，不再限定 GENERATED_LEVELS（6 档）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeCtx, mount, callRoute, blacklistMutates, getModelReasoningEfforts } from './harness.mjs'

test('(concurrency-1) probe：7 候选并发峰值 = 3；混合分类 working/rejected/blocked 正确', async () => {
  const trace = { active: 0, max: 0 }
  const reasons = {
    off: { kind: 'stop', failure: null },
    minimal: { kind: 'error', failure: { code: 'UNSUPPORTED_REASONING_EFFORT', message: 'no reasoning effort "minimal"' } },
    low: { kind: 'stop', failure: null },
    medium: { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'too many requests' } },
    high: { kind: 'error', failure: { code: 'UNSUPPORTED_REASONING_EFFORT', message: 'no reasoning effort "high"' } },
    xhigh: { kind: 'stop', failure: null },
    max: { kind: 'max-tokens', failure: null },
  }
  const { ctx, state } = makeCtx({
    nsConfig: { enabled: false, statsPublic: true },
    resolveModelInfo: async () => ({ reasoning: { efforts: Object.keys(reasons).map((id) => ({ id })) } }),
    stream: (opts) => (async function* () {
      trace.active += 1
      trace.max = Math.max(trace.max, trace.active)
      try {
        await new Promise((resolve) => setTimeout(resolve, 5))
        yield { type: 'finish', reason: reasons[opts.reasoningEffort] }
      } finally {
        trace.active -= 1
      }
    })(),
  })
  await mount(ctx)
  const r = await callRoute(state, '/reasoning-level-stats/probe', { provider: 'p', model: 'm' })
  assert.equal(r.code, 200)
  assert.equal(trace.max, 3, '并发峰值必须等于 PROBE_CONCURRENCY=3（不应多于也不少于）')
  // MAINT-017：候选包含词汇表全量 7 档（off,minimal,low,medium,high,xhigh,max）
  assert.deepEqual(r.payload.working, ['off', 'low', 'xhigh', 'max']) // 按 candidates 顺序
  assert.deepEqual(r.payload.rejected, ['minimal', 'high'])
  assert.deepEqual(r.payload.blocked, ['medium'])
  // MAINT-013：探测拒绝不入黑名单
  assert.equal(blacklistMutates(state).length, 0)
})

// ── MAINT-017 R1（R0 NEEDS_CHANGE 返工 —— F2/F5）────────────────────────────

test('(F2-R1) 同模型并发 /probe：per-model 互斥队列——在途流峰值 ≤ PROBE_CONCURRENCY', async () => {
  // 无互斥队列时，两个并发 /probe（同一 provider/model）各自跑 7 档 × 3 并发
  // → 在途流峰值可达 6；串行化后第二个探测等待第一个完整完成 → 峰值 ≤ 3。
  const trace = { active: 0, max: 0 }
  const { ctx, state } = makeCtx({
    nsConfig: { enabled: false, statsPublic: true },
    resolveModelInfo: async () => undefined,
    stream: (opts) => (async function* () {
      trace.active += 1
      trace.max = Math.max(trace.max, trace.active)
      try {
        await new Promise((resolve) => setTimeout(resolve, 25))
        yield { type: 'finish', reason: { kind: 'stop', failure: null } }
      } finally {
        trace.active -= 1
      }
    })(),
  })
  await mount(ctx)
  const [a, b] = await Promise.all([
    callRoute(state, '/reasoning-level-stats/probe', { provider: 'p', model: 'm' }),
    callRoute(state, '/reasoning-level-stats/probe', { provider: 'p', model: 'm' }),
  ])
  assert.equal(a.code, 200)
  assert.equal(b.code, 200)
  assert.equal(a.payload.working.length, 7)
  assert.equal(b.payload.working.length, 7)
  assert.ok(trace.max <= 3, `同模型并发探测必须串行化：在途流峰值 ${trace.max} ≤ 3`)
})

test('(F5-R1) 并发 /probe/apply（不同模型）：整节写串行化——两次固化结果都保留', async () => {
  // 两个并发 apply 各自对 pi-ai 整节 read-modify-write；replace 延迟拉宽窗口：
  // 无串行化时后写者用陈旧读覆盖先写者（m1 的固化丢失）。
  // 期望：两个模型的固化结果都保留（fresh 读 → 变更 → 写 原子性恢复）。
  const piAi = { providers: { gw: { api: 'openai-completions', models: [{ id: 'm1' }, { id: 'm2' }] } } }
  let replaceCount = 0
  const { ctx, state } = makeCtx({
    nsConfig: { enabled: false, statsPublic: true },
    piAiSection: piAi,
    replaceImpl: async () => {
      replaceCount += 1
      await new Promise((resolve) => setTimeout(resolve, replaceCount === 1 ? 10 : 25))
    },
  })
  await mount(ctx)
  const [r1, r2] = await Promise.all([
    callRoute(state, '/reasoning-level-stats/probe/apply', {
      results: [{ provider: 'gw', model: 'm1', working: ['low'], rejected: [], blocked: [] }],
    }),
    callRoute(state, '/reasoning-level-stats/probe/apply', {
      results: [{ provider: 'gw', model: 'm2', working: ['high'], rejected: [], blocked: [] }],
    }),
  ])
  assert.equal(r1.code, 200)
  assert.equal(r2.code, 200)
  assert.equal(r1.payload.writes, 1)
  assert.equal(r2.payload.writes, 1)
  assert.deepEqual(getModelReasoningEfforts(state, 'gw', 'm1'), { low: 'low' }, 'm1 固化不得被 m2 的陈旧读覆盖')
  assert.deepEqual(getModelReasoningEfforts(state, 'gw', 'm2'), { high: 'high' }, 'm2 固化必须生效')
})
