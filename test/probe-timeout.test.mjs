/**
 * 30s 超时（R1 §2 + MAINT-016/MAINT-017）。
 * PROBE_TIMEOUT_MS=30000 为常量，真实等待不可行，
 * 用两条可观测证据覆盖同一语义（无需产品代码可测性支持，见报告 §6）：
 *  1) probeLevelOnce 以 30000ms 挂载 AbortController 中止定时器
 *     （捕获 globalThis.setTimeout 调用，不做真实等待）；
 *  2) 触发定时器 → llm.stream 经 signal 被中止 → 分类为 blocked（而非 rejected），
 *     不写入黑名单（MAINT-013：探测路径任何拒绝都不入黑名单，只进结果列表）。
 *
 * MAINT-017 移除了 discovery 探测及其独立短超时 DISCOVERY_TIMEOUT_MS；
 * 本文件仅保留常规定时器 30000ms 超时测试。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeCtx, mount, callRoute, blacklistMutates } from './harness.mjs'

test('(timeout-1) probe：中止定时器以 30000ms 挂载；触发后 abort → blocked（不入黑名单）', async () => {
  const armed = []
  const origSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = (fn, ms, ...args) => {
    if (ms === 30000) armed.push({ fn, ms })
    return origSetTimeout(fn, ms, ...args)
  }
  try {
    const { ctx, state } = makeCtx({
      nsConfig: { enabled: false, statsPublic: true },
      resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low' }] } }),
      stream: (opts) => {
        // 常规探测挂起，等待 signal 中止
        return (async function* () {
          await new Promise((resolve, reject) => {
            if (opts.signal.aborted) { reject(new Error('This operation was aborted')); return }
            opts.signal.addEventListener('abort', () => reject(new Error('This operation was aborted')), { once: true })
          })
        })()
      },
    })
    await mount(ctx)
    const p = callRoute(state, '/reasoning-level-stats/probe', { provider: 'p', model: 'm' })
    // 等 handler 推进到 probeLevelOnce 的 setTimeout 调用点（微任务链，一个 setImmediate 即达）
    for (let i = 0; i < 20 && armed.length === 0; i++) await new Promise((resolve) => setImmediate(resolve))
    assert.ok(armed.length >= 1, 'expected an abort timer armed with 30000ms')
    assert.equal(armed[0].ms, 30000)
    // 触发中止（等价于 30s 到期）→ 流随即失败
    armed[0].fn()
    const r = await p
    assert.equal(r.code, 200)
    // 词汇表全量 7 档均为候选，全部被 timeout abort → blocked
    assert.equal(r.payload.blocked.length, 7) // off,minimal,low,medium,high,xhigh,max
    assert.deepEqual(r.payload.working, [])
    assert.deepEqual(r.payload.rejected, [])
    assert.equal(blacklistMutates(state).length, 0)
  } finally {
    globalThis.setTimeout = origSetTimeout
  }
})
