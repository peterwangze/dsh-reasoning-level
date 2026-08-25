/**
 * 并发边界（QA 硬门槛：并发类 ≥1 用例）：
 * probeModelLevels 以 PROBE_CONCURRENCY=3 并发探测，任意时刻在途探测 ≤ 3；
 * 并发 + 混合结束原因的分类矩阵（working/rejected/blocked）。
 * MAINT-013（0.7.1）：探测拒绝不入黑名单——rejected 仅作为该次探测结果返回。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeCtx, mount, callRoute, blacklistMutates } from './harness.mjs'

test('(concurrency-1) probe：6 候选并发峰值 = 3；混合分类 working/rejected/blocked 正确', async () => {
  const trace = { active: 0, max: 0 }
  const reasons = {
    low: { kind: 'stop', failure: null },
    high: { kind: 'error', failure: { code: 'UNSUPPORTED_REASONING_EFFORT', message: 'no reasoning effort "high"' } },
    medium: { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'too many requests' } },
    off: { kind: 'stop', failure: null },
    max: { kind: 'max-tokens', failure: null },
    minimal: { kind: 'error', failure: { code: 'UNSUPPORTED_REASONING_EFFORT', message: 'no reasoning effort "minimal"' } },
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
  assert.deepEqual(r.payload.working, ['low', 'off', 'max']) // 按 candidates 顺序
  assert.deepEqual(r.payload.rejected, ['high', 'minimal'])
  assert.deepEqual(r.payload.blocked, ['medium'])
  // MAINT-013：探测拒绝不入黑名单——rejected 仅作为该次探测结果，零持久化、零内存写入
  assert.equal(blacklistMutates(state).length, 0)
})
