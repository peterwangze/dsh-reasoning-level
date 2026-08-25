/**
 * 30s 超时 & discovery 独立短超时（R1 §2 + MAINT-016）。
 * PROBE_TIMEOUT_MS=30000、DISCOVERY_TIMEOUT_MS=5000 为常量，真实等待不可行，
 * 用两条可观测证据覆盖同一语义（无需产品代码可测性支持，见报告 §6）：
 *  1) probeLevelOnce 以 30000ms 挂载 AbortController 中止定时器
 *     （捕获 globalThis.setTimeout 调用，不做真实等待）；
 *  2) 触发定时器 → llm.stream 经 signal 被中止 → 分类为 blocked（而非 rejected），
 *     不写入黑名单（MAINT-013：探测路径任何拒绝都不入黑名单，只进结果列表）。
 *  3) discovery 探测以 5000ms 独立短超时运行；超时后返回 undefined → 候选不受影响。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeCtx, mount, callRoute, blacklistMutates } from './harness.mjs'

test('(timeout-1) probe：中止定时器以 30000ms 挂载；触发后 abort → blocked（不入黑名单）', async () => {
  // MAINT-016: discovery 使用独立短超时 5000ms，本测试仅关注常规探测 30000ms 超时行为。
  // discovery 探测快速完成，不干扰常规探测的 30000ms 超时验证。
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
        if (opts.reasoningEffort === '__dsh_discovery__') {
          // discovery 快速完成（不阻塞常规探测超时测试）
          return (async function* () {
            yield { type: 'finish', reason: { kind: 'error', failure: { code: 'UNSUPPORTED_REASONING_EFFORT', message: 'no' } } }
          })()
        }
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
    assert.deepEqual(r.payload.blocked, ['low'])
    assert.deepEqual(r.payload.working, [])
    assert.deepEqual(r.payload.rejected, [])
    assert.equal(blacklistMutates(state).length, 0)
  } finally {
    globalThis.setTimeout = origSetTimeout
  }
})

// ── MAINT-016：discovery 独立短超时 ──────────────────────────────────────────

test('MAINT-016: discovery 探测以 5000ms 短超时挂载（不同于常规 30000ms）', async () => {
  const arms = []
  const origSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = (fn, ms, ...args) => {
    arms.push({ ms, fn })
    return origSetTimeout(fn, ms, ...args)
  }
  try {
    const { ctx, state } = makeCtx({
      nsConfig: { enabled: false, statsPublic: true },
      resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low' }] } }),
      stream: (opts) => (async function* () {
        await new Promise((resolve, reject) => {
          if (opts.signal.aborted) { reject(new Error('aborted')); return }
          opts.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
      })(),
    })
    await mount(ctx)
    const p = callRoute(state, '/reasoning-level-stats/probe', { provider: 'p', model: 'm' })
    // 先等待 discovery 的 5000ms 定时器被注册（在 Promise.all 内 discoverLevelsFromRejection 调用中）
    for (let i = 0; i < 50 && arms.filter(a => a.ms === 5000).length === 0; i++) await new Promise((resolve) => setImmediate(resolve))
    const discArms = arms.filter(a => a.ms === 5000)
    assert.ok(discArms.length >= 1, `expected discovery timer with 5000ms, got ${discArms.length} arm(s): ${JSON.stringify(arms)}`)
    // 触发 discovery 超时 → 让 Promise.all 完成 → workers 开始（此时才注册 30000ms 定时器）
    discArms[0].fn()
    // 等待 workers 的 30000ms 定时器被注册
    for (let i = 0; i < 50 && arms.filter(a => a.ms === 30000).length === 0; i++) await new Promise((resolve) => setImmediate(resolve))
    const regArms = arms.filter(a => a.ms === 30000)
    assert.ok(regArms.length >= 1, `expected regular timer with 30000ms, got ${regArms.length} arm(s)`)
    // 清理：触发常规定时器
    for (const a of regArms) a.fn()
    await p
  } finally {
    globalThis.setTimeout = origSetTimeout
  }
})

test('MAINT-016: discovery 超时→undefined→候选来自目录声明，探测不阻塞', async () => {
  // discovery 请求挂起，常规探测正常返回 stop
  const arms = []
  const origSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = (fn, ms, ...args) => {
    arms.push({ ms, fn })
    return origSetTimeout(fn, ms, ...args)
  }
  try {
    let discAborted = false
    const { ctx, state } = makeCtx({
      nsConfig: { enabled: false, statsPublic: true },
      resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'off' }, { id: 'low' }, { id: 'high' }] } }),
      stream: (opts) => {
        if (opts.reasoningEffort === '__dsh_discovery__') {
          // discovery 流等待 abort（模拟网关挂起后被超时中止）
          return (async function* () {
            await new Promise((resolve, reject) => {
              if (opts.signal.aborted) { discAborted = true; reject(new Error('aborted')); return }
              opts.signal.addEventListener('abort', () => { discAborted = true; reject(new Error('aborted')) }, { once: true })
            })
          })()
        }
        // 常规探测立即成功
        return (async function* () {
          yield { type: 'finish', reason: { kind: 'stop', failure: null } }
        })()
      },
    })
    await mount(ctx)
    const p = callRoute(state, '/reasoning-level-stats/probe', { provider: 'p', model: 'm' })
    // 等待 discovery 定时器（5000ms）被注册
    for (let i = 0; i < 50 && arms.filter(a => a.ms === 5000).length === 0; i++) await new Promise((resolve) => setImmediate(resolve))
    const discArm = arms.find(a => a.ms === 5000)
    assert.ok(discArm, 'discovery timer (5000ms) must be armed')
    discArm.fn() // 触发 discovery 超时 → discovery probe 被 abort → discoverLevelsFromRejection 返回 undefined
    // 等待 discovery abort 处理完成 → Promise.all 可 resolve
    for (let i = 0; i < 20 && !discAborted; i++) await new Promise((resolve) => setImmediate(resolve))
    assert.ok(discAborted, 'discovery stream must have been aborted')
    // Promise.all 已 resolve → 候选已组装 → workers 开始运行常规探测（立即成功）
    // 不需要触发 30000ms 定时器：常规 probe 立即 yield finish，workers 完成时 clearTimeout 已清除定时器
    const r = await p
    assert.equal(r.code, 200)
    // 候选来自目录声明（off, low, high），不被 discovery 超时阻塞
    assert.deepEqual(r.payload.working.sort(), ['high', 'low', 'off'])
    assert.equal(r.payload.error, undefined)
    assert.equal(blacklistMutates(state).length, 0)
  } finally {
    globalThis.setTimeout = origSetTimeout
  }
})

test('MAINT-016: discovery 超时→undefined→生成集 fallback 仍正常', async () => {
  // 无目录声明、无配置声明，discovery 挂起超时 → fallback 到 GENERATED_LEVELS
  const arms = []
  const origSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = (fn, ms, ...args) => {
    arms.push({ ms, fn })
    return origSetTimeout(fn, ms, ...args)
  }
  try {
    let discAborted = false
    const { ctx, state } = makeCtx({
      nsConfig: { enabled: false, statsPublic: true },
      resolveModelInfo: async () => undefined, // 无目录声明
      stream: (opts) => {
        if (opts.reasoningEffort === '__dsh_discovery__') {
          return (async function* () {
            await new Promise((resolve, reject) => {
              if (opts.signal.aborted) { discAborted = true; reject(new Error('aborted')); return }
              opts.signal.addEventListener('abort', () => { discAborted = true; reject(new Error('aborted')) }, { once: true })
            })
          })()
        }
        return (async function* () {
          yield { type: 'finish', reason: { kind: 'stop', failure: null } }
        })()
      },
    })
    await mount(ctx)
    const p = callRoute(state, '/reasoning-level-stats/probe', { provider: 'p', model: 'm' })
    for (let i = 0; i < 50 && arms.filter(a => a.ms === 5000).length === 0; i++) await new Promise((resolve) => setImmediate(resolve))
    const discArm = arms.find(a => a.ms === 5000)
    assert.ok(discArm, 'discovery timer must be armed')
    discArm.fn()
    for (let i = 0; i < 20 && !discAborted; i++) await new Promise((resolve) => setImmediate(resolve))
    const r = await p
    assert.equal(r.code, 200)
    // 回退到生成集：标准档
    assert.ok(r.payload.working.length >= 3, 'must have fallback candidates from GENERATED_LEVELS')
    assert.equal(r.payload.error, undefined)
  } finally {
    globalThis.setTimeout = origSetTimeout
  }
})
