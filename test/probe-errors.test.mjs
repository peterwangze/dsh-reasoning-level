/**
 * err 分支（R1 §2 覆盖缺口）+ 空输入边界：
 *  - no candidate levels：levels 过滤后候选为空；
 *  - not-in-pi-ai-config / already-verified：apply 的 skipped 分支；
 *  - 空 results / 空 body（400）不崩溃；
 *  - R1 §2 提及的 /test 端点成功路径（此前无覆盖）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeCtx, mount, callRoute, statusChunks, blacklistMutates, probeEffortsMutates } from './harness.mjs'

test('(err-1) probe：candidates 被 levels 过滤为空 → error "no candidate levels"，零黑名单写入', async () => {
  const { ctx, state } = makeCtx({
    nsConfig: { enabled: false, statsPublic: true },
    resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low' }] } }),
  })
  await mount(ctx)
  const r = await callRoute(state, '/reasoning-level-stats/probe', { provider: 'p', model: 'm', levels: ['high'] })
  assert.equal(r.code, 200)
  assert.equal(r.payload.error, 'no candidate levels')
  assert.deepEqual(r.payload.working, [])
  assert.deepEqual(r.payload.rejected, [])
  assert.deepEqual(r.payload.blocked, [])
  assert.equal(blacklistMutates(state).length, 0)
})

test('(err-2) apply：结果不在 pi-ai 配置 → skipped not-in-pi-ai-config，零 replace/mutate', async () => {
  const { ctx, state } = makeCtx({
    nsConfig: { enabled: false, statsPublic: true },
    piAiSection: { providers: { gateway: { api: 'openai-completions', models: [{ id: 'm1' }] } } },
  })
  await mount(ctx)
  const r = await callRoute(state, '/reasoning-level-stats/probe/apply', {
    results: [{ key: 'nope/m1', provider: 'nope', model: 'm1', working: ['low'], rejected: [], blocked: [] }],
  })
  assert.equal(r.code, 200)
  assert.equal(r.payload.writes, 0)
  assert.deepEqual(r.payload.skipped, [{ key: 'nope/m1', reason: 'not-in-pi-ai-config' }])
  assert.equal(state.replaceCalls.length, 0)
  assert.equal(probeEffortsMutates(state).length, 0)
})

test('(err-3) apply：工作等级与既有生成形状声明一致 → skipped already-verified，零写入', async () => {
  const generated = { off: null, minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', max: 'max' }
  const { ctx, state } = makeCtx({
    nsConfig: { enabled: false, statsPublic: true },
    piAiSection: { providers: { gateway: { api: 'openai-completions', models: [{ id: 'm1', reasoningEfforts: generated }] } } },
  })
  await mount(ctx)
  const r = await callRoute(state, '/reasoning-level-stats/probe/apply', {
    results: [{ key: 'gateway/m1', provider: 'gateway', model: 'm1', working: ['off', 'minimal', 'low', 'medium', 'high', 'max'], rejected: [], blocked: [] }],
  })
  assert.equal(r.code, 200)
  assert.equal(r.payload.writes, 0)
  assert.deepEqual(r.payload.skipped, [{ key: 'gateway/m1', reason: 'already-verified' }])
  assert.equal(state.replaceCalls.length, 0)
  assert.equal(probeEffortsMutates(state).length, 0)
})

test('(err-4) apply：results 为空数组 → {writes:0, skipped:[]}，零副作用', async () => {
  const { ctx, state } = makeCtx({ nsConfig: { enabled: false, statsPublic: true } })
  await mount(ctx)
  const r = await callRoute(state, '/reasoning-level-stats/probe/apply', { results: [] })
  assert.equal(r.code, 200)
  assert.equal(r.payload.writes, 0)
  assert.deepEqual(r.payload.skipped, [])
  assert.equal(state.replaceCalls.length, 0)
  assert.equal(probeEffortsMutates(state).length, 0)
})

test('(err-5) probe/test：空 body（无 provider/model）→ 400 provider and model required', async () => {
  const { ctx, state } = makeCtx({ nsConfig: { enabled: false, statsPublic: true } })
  await mount(ctx)
  for (const path of ['/reasoning-level-stats/probe', '/reasoning-level-stats/test']) {
    const r = await callRoute(state, path, '')
    assert.equal(r.code, 400, path)
    assert.match(r.payload.error, /provider and model required/, path)
  }
})

test('(gap-6) /test 端点（R1 §2 缺口）：合法输入 → ok:true + finish:stop', async () => {
  const { ctx, state } = makeCtx({
    nsConfig: { enabled: false, statsPublic: true },
    stream: (opts) => statusChunks({ kind: 'stop', failure: null })(opts),
  })
  await mount(ctx)
  const r = await callRoute(state, '/reasoning-level-stats/test', { provider: 'p', model: 'm', level: 'low' })
  assert.equal(r.code, 200)
  assert.equal(r.payload.ok, true)
  assert.equal(r.payload.finish, 'stop')
  assert.equal(r.payload.level, 'low')
})
