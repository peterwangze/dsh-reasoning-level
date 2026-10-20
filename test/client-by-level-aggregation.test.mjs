/**
 * FEAT-005 判别测试：服务端 per-level 聚合（设计 §6.1 / §10.4 / 验收 6）。
 *
 * 覆盖（任一被破坏即红）：
 *  ① 同一模型两个等级 → byLevel 两桶，token 各自归桶（不是混在一起）；
 *  ② 不变量：Σ byLevel.calls === Σ efforts 各值 === agg.calls（同键 add 点单源），
 *     且模型级 token/耗时合计 === 各桶之和；
 *  ③ 旧快照（v0.8.1 及以前，无 byLevel）hydrate → byLevel={} 不抛错、旧字段零漂移；
 *  ④ 入口无显式等级 → `(默认)` 桶存在（与 efforts 的 `(默认)` 键同源）；
 *  ⑤ wire 受控键：快照里的词表外等级键必须在 stats 出口被丢弃（防脏键污染）；
 *  ⑥ 落盘：persistStats 把 byLevel 一并写入统计文件（A3——否则升级后 per-level
 *     数据在重启时丢失）。
 *
 * 每个用例使用独立临时 $DSH_HOME（MAINT-039 测试隔离纪律）：统计持久化文件是
 * boot hydrate 的输入，共享 home 会让用例互相污染。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeCtx, mount, callRoute } from './harness.mjs'

const STATS = '/reasoning-level-stats'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 独立临时 DSH_HOME（统计持久化路径 = $DSH_HOME/storages/reasoning-level-stats.json）。 */
async function withTempHome(fn) {
  const previous = process.env.DSH_HOME
  const home = mkdtempSync(join(tmpdir(), 'dsh-rl-bylevel-'))
  process.env.DSH_HOME = home
  try {
    return await fn(home)
  } finally {
    process.env.DSH_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
}

/** 一次带 usage 的调用：rt/ot 明确区分等级，便于断言各自归桶。 */
function usageChunks(reasoningTokens, outputTokens) {
  return [
    { type: 'usage', usage: { reasoningTokens, outputTokens, inputTokens: 3 } },
    { type: 'finish', reason: { kind: 'stop', failure: null } },
  ]
}

/** 驱动真实 llm/stream waterfall（hook 内 beginRecord/settleRecord 即被测路径）。 */
async function drainCall(state, options, chunks) {
  const onStream = state.handlers.get('llm/stream')
  assert.ok(typeof onStream === 'function', 'llm/stream handler must be registered')
  const stream = onStream(
    { messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }], ...options },
    () => (async function* () { for (const chunk of chunks) yield chunk })(),
  )
  for await (const _chunk of stream) { /* drain：finish 触发 settleRecord */ }
}

test('(bylevel-1) 同一模型两个等级 → byLevel 两个桶（token 各自归桶）+ 落盘携带 byLevel（FEAT-005）', async () => {
  await withTempHome(async (home) => {
    const { ctx, state } = makeCtx({ nsConfig: { enabled: false, statsPublic: true } })
    await mount(ctx)
    await drainCall(state, { provider: 'p', model: 'm', reasoningEffort: 'high' }, usageChunks(6, 12))
    await drainCall(state, { provider: 'p', model: 'm', reasoningEffort: 'max' }, usageChunks(10, 22))

    const { payload } = await callRoute(state, STATS, {})
    const agg = payload.models['p/m']
    assert.deepEqual(Object.keys(agg.byLevel).sort(), ['high', 'max'], '同一模型两个等级必须形成两个 byLevel 桶')
    assert.equal(agg.byLevel.high.calls, 1)
    assert.equal(agg.byLevel.max.calls, 1)
    assert.equal(agg.byLevel.high.reasoningTokens, 6, 'high 桶只累计 high 档的思考 tokens')
    assert.equal(agg.byLevel.max.reasoningTokens, 10, 'max 桶只累计 max 档的思考 tokens')
    assert.equal(agg.byLevel.high.outputTokens, 12)
    assert.equal(agg.byLevel.max.outputTokens, 22)
    // 旧字段语义不变（红线 2）：模型级合计 = 两桶之和
    assert.equal(agg.calls, 2)
    assert.equal(agg.efforts.high, 1)
    assert.equal(agg.efforts.max, 1)
    assert.equal(agg.reasoningTokens, 16)
    assert.equal(agg.outputTokens, 34)

    // A3 落盘：persistStats 的 5s debounce 到期后统计文件必须含 byLevel
    // （重试读取吸收并发负载下的 debounce 抖动；上限 ~8s，不引入硬等待假设）
    const statsFile = join(home, 'storages', 'reasoning-level-stats.json')
    let saved
    for (let attempt = 0; attempt < 30; attempt++) {
      await sleep(attempt === 0 ? 5200 : 100)
      try {
        const parsed = JSON.parse(readFileSync(statsFile, 'utf8'))
        if (parsed.models?.['p/m']?.byLevel !== undefined) { saved = parsed; break }
      } catch (error) { /* 文件尚未落盘 → 继续等 */ }
    }
    assert.ok(saved !== undefined, 'persistStats 必须落盘 byLevel（升级重启后 per-level 数据不丢）')
    assert.equal(saved.models['p/m'].byLevel.high.calls, 1)
    assert.equal(saved.models['p/m'].byLevel.max.reasoningTokens, 10)
  })
})

test('(bylevel-2) 不变量：Σ byLevel.calls === Σ efforts === agg.calls，且合计字段 = 各桶之和', async () => {
  await withTempHome(async () => {
    const { ctx, state } = makeCtx({ nsConfig: { enabled: false, statsPublic: true } })
    await mount(ctx)
    await drainCall(state, { provider: 'p', model: 'm', reasoningEffort: 'high' }, usageChunks(6, 12))
    await drainCall(state, { provider: 'p', model: 'm', reasoningEffort: 'high' }, usageChunks(4, 8))
    await drainCall(state, { provider: 'p', model: 'm', reasoningEffort: 'max' }, usageChunks(10, 22))
    await drainCall(state, { provider: 'p', model: 'm' }, usageChunks(2, 4)) // (默认) 桶

    const { payload } = await callRoute(state, STATS, {})
    const agg = payload.models['p/m']
    const byLevelSum = Object.values(agg.byLevel).reduce((sum, bucket) => sum + bucket.calls, 0)
    const effortsSum = Object.values(agg.efforts).reduce((sum, count) => sum + count, 0)
    assert.equal(byLevelSum, effortsSum, 'byLevel 与 efforts 必须同源计数（Σ byLevel.calls === Σ efforts）')
    assert.equal(effortsSum, agg.calls, 'Σ efforts === agg.calls（旧字段语义零变更）')
    assert.equal(agg.calls, 4)
    assert.equal(agg.byLevel.high.calls, 2)
    for (const field of ['reasoningTokens', 'outputTokens', 'reasoningChars', 'durationMs', 'errors']) {
      const bucketSum = Object.values(agg.byLevel).reduce((sum, bucket) => sum + bucket[field], 0)
      assert.equal(agg[field], bucketSum, `模型级 ${field} 必须等于各等级桶之和`)
    }
  })
})

test('(bylevel-3) 旧快照（无 byLevel）hydrate → byLevel={} 不崩、旧字段零漂移（设计 §10.4）', async () => {
  await withTempHome(async (home) => {
    mkdirSync(join(home, 'storages'), { recursive: true })
    // v0.8.1 形状：只有模型级合计，没有 per-level 拆分
    const legacy = {
      totalCalls: 5,
      models: {
        'legacy/m1': {
          calls: 5,
          efforts: { high: 5 },
          reasoningTokens: 10,
          outputTokens: 20,
          reasoningChars: 0,
          durationMs: 100,
          errors: 0,
        },
      },
    }
    writeFileSync(join(home, 'storages', 'reasoning-level-stats.json'), JSON.stringify(legacy), 'utf8')
    const { ctx, state } = makeCtx({ nsConfig: { enabled: false, statsPublic: true } })
    await mount(ctx)
    const response = await callRoute(state, STATS, {})
    assert.equal(response.code, 200, '旧快照 hydrate 不得让 stats 端点抛错')
    const agg = response.payload.models['legacy/m1']
    assert.deepEqual(agg.byLevel, {}, '旧快照无 byLevel → 初始化为 {}（不得崩、不得编造历史 per-level 数据）')
    // 红线 2：既有字段形状与语义零变更
    assert.equal(agg.calls, 5)
    assert.deepEqual(agg.efforts, { high: 5 })
    assert.equal(agg.reasoningTokens, 10)
    assert.equal(agg.outputTokens, 20)
    assert.equal(agg.durationMs, 100)
    assert.equal(agg.errRate, 0)
    assert.equal(response.payload.totalCalls, 5)
  })
})

test('(bylevel-4) (默认) 桶存在——入口无显式等级（与 efforts 的 (默认) 键同源）', async () => {
  await withTempHome(async () => {
    const { ctx, state } = makeCtx({ nsConfig: { enabled: false, statsPublic: true } })
    await mount(ctx)
    await drainCall(state, { provider: 'p', model: 'm' }, usageChunks(2, 4))
    const { payload } = await callRoute(state, STATS, {})
    const agg = payload.models['p/m']
    assert.equal(agg.efforts['(默认)'], 1)
    assert.ok(agg.byLevel['(默认)'] !== undefined, '(默认) 桶必须存在（无显式等级调用的 per-level 归集）')
    assert.equal(agg.byLevel['(默认)'].calls, 1)
    assert.equal(agg.byLevel['(默认)'].reasoningTokens, 2)
  })
})

test('(bylevel-5) wire 受控键：词表外等级桶保留在内部/盘上但不得出现在 stats 出口', async () => {
  await withTempHome(async (home) => {
    mkdirSync(join(home, 'storages'), { recursive: true })
    // 模拟 MAINT-014 的 qwen custom/ultra 类非标准档 + 受控档并存
    const seeded = {
      totalCalls: 2,
      models: {
        'qwen/m1': {
          calls: 2,
          efforts: { high: 1, ultra: 1 },
          byLevel: {
            high: { calls: 1, reasoningTokens: 1, outputTokens: 2, reasoningChars: 0, durationMs: 10, errors: 0 },
            ultra: { calls: 1, reasoningTokens: 3, outputTokens: 4, reasoningChars: 0, durationMs: 20, errors: 0 },
          },
          reasoningTokens: 4,
          outputTokens: 6,
          reasoningChars: 0,
          durationMs: 30,
          errors: 0,
        },
      },
    }
    writeFileSync(join(home, 'storages', 'reasoning-level-stats.json'), JSON.stringify(seeded), 'utf8')
    const { ctx, state } = makeCtx({ nsConfig: { enabled: false, statsPublic: true } })
    await mount(ctx)
    const { payload } = await callRoute(state, STATS, {})
    const byLevel = payload.models['qwen/m1'].byLevel
    assert.ok(byLevel.high !== undefined, '受控等级桶必须透出')
    assert.equal(byLevel.ultra, undefined, '未在 LEVELS/(默认) 内的键必须从 wire 丢弃（防脏键污染）')
    // 旧字段 efforts 形状不变（红线 2：只新增字段，不改旧字段语义）
    assert.deepEqual(payload.models['qwen/m1'].efforts, { high: 1, ultra: 1 })
  })
})
