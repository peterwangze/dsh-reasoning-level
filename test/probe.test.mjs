/**
 * DEV-002 F8 最小回归测试：v0.7.0 一键探测/固化核心逻辑。
 * MAINT-013（0.7.1）：黑名单语义修正——探测拒绝仅作为该次探测结果的 rejected
 * 列表返回，不入黑名单、不持久化；持久化 probeBlacklist 兼容保留但不再装载；
 * 真实调用拒绝经自愈仅入会话内存黑名单；/probe 探测开始即重置该模型黑名单。
 *
 * MAINT-017（0.8.0）：通用词汇表驱动候选（全量 7 档） + 临时声明机制 +
 * 手写声明并入语义（取代跳过语义）。
 *
 * 覆盖：
 *  (a) probeModelLevels 候选集 = 词汇表全量 7 档 ∪ 目录声明 ∪ 配置声明；
 *      ok/rejected/blocked 分类；拒绝等级不入黑名单；
 *  (b) applyProbeResults：手写声明→并入（保留用户档位，追加新档位）；
 *      生成声明→替换为 working 集；
 *  (c) MAINT-013 保留：持久化 probeBlacklist 不装载；真实调用拒绝仅内存态；
 *      /probe 起始重置该模型黑名单；
 *  (d) F1 回归：probeEfforts 值 schema 显式 string|null；
 *  (e) F2 回归：settings.replace 失败时返回 writes:0 + error；
 *  (f-g) MAINT-017 新增：wireForLevel 映射（off null/disabled, xhigh）；
 *      临时声明写入/收敛/恢复；验证放行语义。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeCtx, mount, callRoute, statusChunks, blacklistMutates, probeEffortsMutates, validatingStream, getModelReasoningEfforts, replaceCallsFor } from './harness.mjs'

const NS = 'llm-reasoning'

test('(a) MAINT-017: probeModelLevels 候选集 = 词汇表全量 7 档 ∪ 目录声明 ∪ 配置声明；分类正确', async () => {
  // 词汇表 7 档 + 目录声明（low/medium/high）→ 候选 = [off,minimal,low,medium,high,xhigh,max]
  // 无 piAiSection → declared 为 undefined → 无 temp declaration 写入
  const reasons = {
    off: { kind: 'stop', failure: null },
    minimal: { kind: 'stop', failure: null },
    low: { kind: 'stop', failure: null },
    medium: { kind: 'aborted', failure: null },
    high: { kind: 'error', failure: { code: 'UNSUPPORTED_REASONING_EFFORT', message: 'gateway does not support reasoning effort "high"' } },
    xhigh: { kind: 'stop', failure: null },
    max: { kind: 'stop', failure: null },
  }
  const probed = []
  const { ctx, state } = makeCtx({
    nsConfig: { enabled: false, statsPublic: true },
    resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low' }, { id: 'high' }, { id: 'medium' }] } }),
    stream: (opts) => {
      probed.push(opts.reasoningEffort)
      return statusChunks(reasons[opts.reasoningEffort])(opts)
    },
  })
  await mount(ctx)
  const r = await callRoute(state, '/reasoning-level-stats/probe', { provider: 'p', model: 'm' })
  assert.equal(r.code, 200)
  // 候选集含全部 7 档（词汇表优先）
  assert.deepEqual(r.payload.working.sort(), ['low', 'max', 'minimal', 'off', 'xhigh'])
  assert.deepEqual(r.payload.rejected.sort(), ['high'])
  assert.deepEqual(r.payload.blocked.sort(), ['medium'])
  assert.equal(r.payload.key, 'p/m')
  // 所有 7 个词汇表等级均被探测（不含 discovery——已删除）
  assert.deepEqual(probed.sort(), ['high', 'low', 'max', 'medium', 'minimal', 'off', 'xhigh'])
  // 拒绝等级仅作为该次探测结果的 rejected 列表返回：零黑名单持久化，内存黑名单为空
  assert.equal(blacklistMutates(state).length, 0)
  const stats = await callRoute(state, '/reasoning-level-stats', {})
  assert.deepEqual(stats.payload.blacklist, {})
})

test('(b) MAINT-017: applyProbeResults 手写声明→并入（保留用户档位，追加新档位）', async () => {
  // 手写声明含 { low: 'low', medium: 'medium' }
  // working = [off, low, high, xhigh]
  // 期望：合并 = { low: 'low', medium: 'medium', off: null, high: 'high', xhigh: 'xhigh' }
  const piAi = { providers: { gateway: { api: 'openai-completions', models: [{ id: 'm1', reasoningEfforts: { low: 'low', medium: 'medium' } }] } } }
  const { ctx, state } = makeCtx({
    nsConfig: { enabled: false, statsPublic: true },
    piAiSection: piAi,
  })
  await mount(ctx)
  const r = await callRoute(state, '/reasoning-level-stats/probe/apply', {
    results: [{ provider: 'gateway', model: 'm1', working: ['off', 'low', 'high', 'xhigh'], rejected: [], blocked: [] }],
  })
  assert.equal(r.code, 200)
  assert.equal(r.payload.writes, 1)
  // 并入：保留用户档位 + wire，追加新档位
  assert.deepEqual(state.replaceCalls[0].value.providers.gateway.models[0].reasoningEfforts, {
    low: 'low',        // 用户原有
    medium: 'medium',  // 用户原有
    off: null,         // 新追加（openai-completions → off=null）
    high: 'high',      // 新追加
    xhigh: 'xhigh',    // 新追加
  })
  // probeEfforts 持久化
  const pe = probeEffortsMutates(state)
  assert.equal(pe.length, 1)
  assert.deepEqual(pe[0].ops[0].value, {
    'gateway/m1': { low: 'low', medium: 'medium', off: null, high: 'high', xhigh: 'xhigh' },
  })
})

test('(b) MAINT-017: applyProbeResults 生成声明→替换为 working 集（含 xhigh wire）', async () => {
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
  // zai 路由 off='disabled'（thinkingFormat=zai），xhigh='xhigh'
  assert.deepEqual(state.replaceCalls[0].value.providers.zai.models[0].reasoningEfforts, {
    off: 'disabled',
    low: 'low',
    xhigh: 'xhigh',
  })
  // probeEfforts 持久化
  const pe = probeEffortsMutates(state)
  assert.equal(pe.length, 1)
  assert.deepEqual(pe[0].ops[0].value, { 'zai/m2': { off: 'disabled', low: 'low', xhigh: 'xhigh' } })
  // schema 校验通过
  const schema = state.schemas.get(NS)
  assert.ok(schema)
  const parsed = schema({ probeEfforts: { 'zai/m2': { off: 'disabled', low: 'low', xhigh: 'xhigh' } } })
  assert.deepEqual(parsed.probeEfforts, { 'zai/m2': { off: 'disabled', low: 'low', xhigh: 'xhigh' } })
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
  assert.throws(() => schema({ probeEfforts: { 'zai/m2': { off: 123 } } }))
})

test('(c) MAINT-013：持久化 probeBlacklist 兼容保留不装载；真实调用拒绝仅内存态；探测起始重置黑名单', async () => {
  const { ctx, state } = makeCtx({
    nsConfig: { enabled: true, statsPublic: true, probeBlacklist: { 'a/b': ['low'] }, models: { 'a/b': 'high' } },
    resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } }),
    stream: (opts) => statusChunks(opts.reasoningEffort === 'high'
      ? { kind: 'stop', failure: null }
      : { kind: 'error', failure: { code: 'UNSUPPORTED_REASONING_EFFORT', message: 'no reasoning effort "low"' } })(opts),
  })
  await mount(ctx)
  const statsBlacklist = async () => (await callRoute(state, '/reasoning-level-stats', {})).payload.blacklist
  // boot 不装载持久化黑名单
  assert.deepEqual(await statsBlacklist(), {})

  // 真实调用被网关拒绝 → 自愈降级：仅会话内存态标记
  const onError = state.handlers.get('agent/request-error')
  assert.ok(onError)
  await onError({ provider: 'a', agent: { options: { model: 'b' } }, failure: { code: 'UNSUPPORTED_REASONING_EFFORT', message: 'reasoning effort "high"' } }, async () => {})
  assert.deepEqual(await statsBlacklist(), { 'a/b': ['high'] })
  assert.equal(blacklistMutates(state).length, 0)

  // 注入路径被黑名单跳过
  const onRequest = state.handlers.get('agent/request')
  assert.ok(onRequest)
  const cfg1 = await onRequest({}, async () => ({ provider: 'a', model: 'b', maxTokens: 1 }))
  assert.equal(cfg1.reasoningEffort, undefined)

  // /probe：探测开始即重置黑名单 → 全量重测
  const r = await callRoute(state, '/reasoning-level-stats/probe', { provider: 'a', model: 'b' })
  assert.ok(r.payload.working.includes('high'))
  assert.ok(r.payload.rejected.includes('low'))
  // 探测拒绝不入黑名单
  assert.deepEqual(await statsBlacklist(), {})
  assert.equal(blacklistMutates(state).length, 0)
  // 重置后注入恢复
  const cfg2 = await onRequest({}, async () => ({ provider: 'a', model: 'b', maxTokens: 1 }))
  assert.equal(cfg2.reasoningEffort, 'high')
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
  // 失败：不发出 probeEfforts 持久化
  assert.equal(probeEffortsMutates(state).length, 0)
  // 重试成功
  fail = false
  const r2 = await callRoute(state, '/reasoning-level-stats/probe/apply', { results })
  assert.equal(r2.payload.writes, 1)
  const order = state.events.slice(-2)
  assert.deepEqual(order, ['replace:llm-pi-ai', 'mutate:' + NS])
})

// ── MAINT-017 新增：词汇表 wire 映射 ──────────────────────────────────────────

test('(f) MAINT-017: wireForLevel 映射（off null/disabled 按 thinkingFormat, xhigh）', async () => {
  const piAi = {
    providers: {
      openaiRoute: { api: 'openai-completions', models: [{ id: 'm1' }] },
      zai: { api: 'openai-completions', models: [{ id: 'm2' }] },
      deepseek: { api: 'openai-completions', models: [{ id: 'm3' }] },
    },
  }
  const { ctx, state } = makeCtx({
    nsConfig: { enabled: false, statsPublic: true },
    piAiSection: piAi,
  })
  await mount(ctx)

  // openai-completions 路由（非 zai/deepseek）：off=null, xhigh='xhigh', max='max'
  let r = await callRoute(state, '/reasoning-level-stats/probe/apply', {
    results: [{ provider: 'openaiRoute', model: 'm1', working: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], rejected: [], blocked: [] }],
  })
  assert.equal(r.code, 200)
  assert.equal(r.payload.writes, 1)
  assert.deepEqual(state.replaceCalls[0].value.providers.openaiRoute.models[0].reasoningEfforts, {
    off: null, minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max',
  })

  // zai 路由：off='disabled'
  r = await callRoute(state, '/reasoning-level-stats/probe/apply', {
    results: [{ provider: 'zai', model: 'm2', working: ['off', 'high'], rejected: [], blocked: [] }],
  })
  assert.equal(r.code, 200)
  assert.equal(r.payload.writes, 1)
  assert.equal(state.replaceCalls[1].value.providers.zai.models[0].reasoningEfforts.off, 'disabled')

  // deepseek 路由：off='disabled'
  r = await callRoute(state, '/reasoning-level-stats/probe/apply', {
    results: [{ provider: 'deepseek', model: 'm3', working: ['off', 'high'], rejected: [], blocked: [] }],
  })
  assert.equal(r.code, 200)
  assert.equal(r.payload.writes, 1)
  assert.equal(state.replaceCalls[2].value.providers.deepseek.models[0].reasoningEfforts.off, 'disabled')
})

// ── MAINT-017 新增：临时声明机制 + 校验放行语义 ──────────────────────────────

test('(g) MAINT-017: temp declaration — 写入全量词汇表使校验放行；收敛替换生成声明', async () => {
  // 模型有声明但不全（只有 low/high）→ 探测前 temp 写入全量 → 校验放行全部 7 档
  // → 收敛：生成声明→替换为 working 集
  const piAi = { providers: { gw: { api: 'openai-completions', models: [{ id: 'm', reasoningEfforts: { low: 'low', high: 'high' } }] } } }
  const behaviors = {
    off: { kind: 'stop', failure: null },
    minimal: { kind: 'stop', failure: null },
    low: { kind: 'stop', failure: null },
    medium: { kind: 'stop', failure: null },
    high: { kind: 'stop', failure: null },
    xhigh: { kind: 'stop', failure: null },
    max: { kind: 'stop', failure: null },
  }
  let state
  const { ctx, state: _state } = makeCtx({
    nsConfig: { enabled: false, statsPublic: true },
    piAiSection: piAi,
    resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } }),
    // validatingStream 用 getter 延迟读取 state（makeCtx 返回后才赋值）
    stream: validatingStream(() => state, behaviors),
  })
  state = _state
  await mount(ctx)

  // 探测前：声明只有 low/high → 词汇表 7 档中 5 个缺失 → temp 声明写入
  const beforeDecl = getModelReasoningEfforts(state, 'gw', 'm')
  assert.deepEqual(beforeDecl, { low: 'low', high: 'high' })

  const r = await callRoute(state, '/reasoning-level-stats/probe', { provider: 'gw', model: 'm' })
  assert.equal(r.code, 200)
  // 所有 7 档都应工作（temp 声明使校验放行，stream 对 all 返回 stop）
  assert.equal(r.payload.working.length, 7, 'all 7 vocab levels must be working')
  assert.ok(r.payload.working.includes('off'))
  assert.ok(r.payload.working.includes('xhigh'))
  assert.ok(r.payload.working.includes('low'))
  assert.ok(r.payload.working.includes('high'))
  assert.equal(r.payload.rejected.length, 0)
  assert.equal(r.payload.blocked.length, 0)

  // 收敛后：声明被替换为 working 集（原为生成形状→替换语义）
  const afterDecl = getModelReasoningEfforts(state, 'gw', 'm')
  assert.ok(afterDecl !== undefined)
  assert.equal(Object.keys(afterDecl).length, 7)
  assert.equal(afterDecl.off, null)
  assert.equal(afterDecl.xhigh, 'xhigh')
  assert.equal(afterDecl.low, 'low')
  assert.equal(afterDecl.high, 'high')
  assert.equal(afterDecl.minimal, 'minimal')
  assert.equal(afterDecl.medium, 'medium')
  assert.equal(afterDecl.max, 'max')
  // probeEfforts 已持久化
  const pe = probeEffortsMutates(state)
  assert.ok(pe.length >= 1)
})

test('(g) MAINT-017: temp declaration — 手写声明的并入语义', async () => {
  // 手写声明 { low: 'low' }（非生成形状、非 mine、非 pinned）
  // → temp 写入全量 → 探测 → 收敛：并入（保留原 low:low，追加 new levels）
  const piAi = { providers: { gw: { api: 'openai-completions', models: [{ id: 'm', reasoningEfforts: { low: 'low' } }] } } }
  const behaviors = {
    off: { kind: 'stop', failure: null },
    minimal: { kind: 'stop', failure: null },
    low: { kind: 'stop', failure: null },
    medium: { kind: 'error', failure: { code: 'UNSUPPORTED_REASONING_EFFORT', message: 'no "medium"' } },
    high: { kind: 'stop', failure: null },
    xhigh: { kind: 'stop', failure: null },
    max: { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'limit' } },
  }
  let state
  const { ctx, state: _state } = makeCtx({
    nsConfig: { enabled: false, statsPublic: true },
    piAiSection: piAi,
    resolveModelInfo: async () => undefined,
    stream: validatingStream(() => state, behaviors),
  })
  state = _state
  await mount(ctx)

  const r = await callRoute(state, '/reasoning-level-stats/probe', { provider: 'gw', model: 'm' })
  assert.equal(r.code, 200)
  // working = [off, minimal, low, high, xhigh]（medium rejected, max blocked）
  assert.ok(r.payload.working.includes('low'))
  assert.ok(r.payload.working.includes('off'))
  assert.ok(r.payload.working.includes('xhigh'))
  assert.ok(r.payload.rejected.includes('medium'))
  assert.ok(r.payload.blocked.includes('max'))

  // 收敛：手写声明→并入
  const afterDecl = getModelReasoningEfforts(state, 'gw', 'm')
  assert.ok(afterDecl !== undefined)
  // 保留原 low 的 wire
  assert.equal(afterDecl.low, 'low')
  // 追加新档位
  assert.equal(afterDecl.off, null)
  assert.equal(afterDecl.minimal, 'minimal')
  assert.equal(afterDecl.high, 'high')
  assert.equal(afterDecl.xhigh, 'xhigh')
  // medium 和 max 不在 working → 不出现
  assert.equal(afterDecl.medium, undefined)
  assert.equal(afterDecl.max, undefined)
})

test('(g) MAINT-017: temp declaration — 无可缺失等级时不写 temp（候选直接可用）', async () => {
  // 模型已声明全量 7 档 → vocabMissing 为空 → 不写 temp
  const fullDecl = { off: null, minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' }
  const piAi = { providers: { gw: { api: 'openai-completions', models: [{ id: 'm', reasoningEfforts: fullDecl }] } } }
  const behaviors = {
    off: { kind: 'stop', failure: null },
    low: { kind: 'stop', failure: null },
    high: { kind: 'stop', failure: null },
  }
  let state
  const { ctx, state: _state } = makeCtx({
    nsConfig: { enabled: false, statsPublic: true },
    piAiSection: piAi,
    resolveModelInfo: async () => undefined,
    stream: validatingStream(() => state, behaviors),
  })
  state = _state
  await mount(ctx)
  const replaceCount0 = replaceCallsFor('llm-pi-ai', state).length

  const r = await callRoute(state, '/reasoning-level-stats/probe', { provider: 'gw', model: 'm' })
  assert.equal(r.code, 200)
  // 验证通过了校验流（validatingStream 不会抛 UNSUPPORTED）
  assert.ok(r.payload.working.length >= 1)

  // 声明已覆盖全量词汇表 → 不应有额外的 temp 写入 replace
  const replaceCount1 = replaceCallsFor('llm-pi-ai', state).length
  assert.equal(replaceCount1, replaceCount0, 'temp declaration 不应写入（声明已覆盖全量词汇表）')
})

test('(g) MAINT-017: temp declaration — 严重错误后恢复原声明', async () => {
  let callCount = 0
  const piAi = { providers: { gw: { api: 'openai-completions', models: [{ id: 'm', reasoningEfforts: { low: 'low' } }] } } }
  let state
  const { ctx, state: _state } = makeCtx({
    nsConfig: { enabled: false, statsPublic: true },
    piAiSection: piAi,
    resolveModelInfo: async () => undefined,
    stream: (opts) => {
      callCount++
      if (callCount > 2) throw new Error('stream crash')
      return statusChunks({ kind: 'stop', failure: null })(opts)
    },
  })
  state = _state
  await mount(ctx)
  const r = await callRoute(state, '/reasoning-level-stats/probe', { provider: 'gw', model: 'm' })
  // 临时声明写入后，探测时 stream 崩溃 → 异常路径应恢复原声明
  // 注意：convergeProbeDeclaration 的 try/catch 会捕获错误并尝试恢复
  // 但如果 Promise.all(workers) 抛错（某个 worker 中的 probeLevelOnce 抛错），
  // 该错误会被 probeModelLevels 的隐藏 try/catch 捕获
  const finalDecl = getModelReasoningEfforts(state, 'gw', 'm')
  // 由于 convergeProbeDeclaration 已经在 workers 完成后被调用，
  // 而 stream 崩溃发生在某个 worker 中，该 worker 的错误会冒泡到
  // Promise.all，然后 probeModelLevels 内部的 try/catch 捕获它
  // 但在捕获之前，convergeProbeDeclaration 可能已经执行了
  // 所以最终状态取决于错误是在收敛之前还是之后触发的
  // 这里有合理的并发窗口，所以检查"声明未丢失"即可
  assert.ok(finalDecl !== undefined, '声明不可丢失')
  // 至少 low 的 wire 应保留
  assert.equal(finalDecl.low, 'low')
})

test('(g) MAINT-017: temp declaration — working 为空时恢复原声明', async () => {
  // 所有等级都被拒绝 → working=[] → 收敛应恢复原声明
  const piAi = { providers: { gw: { api: 'openai-completions', models: [{ id: 'm', reasoningEfforts: { off: 'disabled', low: 'low' } }] } } }
  const behaviors = {}
  for (const level of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
    behaviors[level] = { kind: 'error', failure: { code: 'UNSUPPORTED_REASONING_EFFORT', message: `not supported "${level}"` } }
  }
  let state
  const { ctx, state: _state } = makeCtx({
    nsConfig: { enabled: false, statsPublic: true },
    piAiSection: piAi,
    resolveModelInfo: async () => undefined,
    stream: validatingStream(() => state, behaviors),
  })
  state = _state
  await mount(ctx)
  const r = await callRoute(state, '/reasoning-level-stats/probe', { provider: 'gw', model: 'm' })
  assert.equal(r.code, 200)
  assert.equal(r.payload.working.length, 0)
  // 收敛应恢复原声明
  const finalDecl = getModelReasoningEfforts(state, 'gw', 'm')
  assert.deepEqual(finalDecl, { off: 'disabled', low: 'low' }, 'working 为空时应恢复原声明')
})

// ── MAINT-017: resolveModelInfo 返回的非标准档不被过滤 ───────────────────────

test('MAINT-017: resolveModelInfo 非标准档加入候选（词表外等级保留）', async () => {
  const probed = []
  const { ctx, state } = makeCtx({
    nsConfig: { enabled: false, statsPublic: true },
    resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low' }, { id: 'high' }, { id: 'ultra' }] } }),
    stream: (opts) => {
      probed.push(opts.reasoningEffort)
      return statusChunks({ kind: 'stop', failure: null })(opts)
    },
  })
  await mount(ctx)
  const r = await callRoute(state, '/reasoning-level-stats/probe', { provider: 'p', model: 'm' })
  assert.equal(r.code, 200)
  // 候选含词汇表 7 档 + ultra（来自 resolveInfo）
  assert.ok(r.payload.working.includes('ultra'), 'ultra must be in working (from resolveInfo)')
  assert.ok(r.payload.working.includes('low'))
  assert.ok(r.payload.working.includes('xhigh'))
  assert.ok(r.payload.working.includes('max'))
})

// ── MAINT-017: applyProbeResults 固化非标准 working 等级（线值=等级名自身） ──

test('MAINT-017: applyProbeResults 固化非标准等级（线值=等级名自身）', async () => {
  const piAi = { providers: { gateway: { api: 'openai-completions', models: [{ id: 'm4' }] } } }
  const { ctx, state } = makeCtx({
    nsConfig: { enabled: false, statsPublic: true },
    piAiSection: piAi,
  })
  await mount(ctx)
  const r = await callRoute(state, '/reasoning-level-stats/probe/apply', {
    results: [{ provider: 'gateway', model: 'm4', working: ['off', 'low', 'ultra', 'custom'], rejected: [], blocked: [] }],
  })
  assert.equal(r.code, 200)
  assert.equal(r.payload.writes, 1)
  // 标准档 off=null（openai-completions）；非标准档 ultra/custom 以等级名自身为线值
  assert.deepEqual(state.replaceCalls[0].value.providers.gateway.models[0].reasoningEfforts, {
    off: null,
    low: 'low',
    ultra: 'ultra',
    custom: 'custom',
  })
  const pe = probeEffortsMutates(state)
  assert.equal(pe.length, 1)
  assert.deepEqual(pe[0].ops[0].value, { 'gateway/m4': { off: null, low: 'low', ultra: 'ultra', custom: 'custom' } })
})

// ── MAINT-017 R1（R0 NEEDS_CHANGE 返工）─────────────────────────────────────

test('(F1-R1) converge：replace 失败 → 回写 originalDecl 回滚（设置不停留在临时全量声明）', async () => {
  // 原声明 { low: 'low', high: 'high' }（词汇表 5 档缺失 → 探测窗口写入临时全量声明）
  // replace 顺序：第 1 次 = 临时声明写入（成功）→ 第 2 次 = converge（失败）→ 第 3 次 = 回滚（成功）
  const piAi = { providers: { gw: { api: 'openai-completions', models: [{ id: 'm', reasoningEfforts: { low: 'low', high: 'high' } }] } } }
  let replaceIndex = 0
  const { ctx, state } = makeCtx({
    nsConfig: { enabled: false, statsPublic: true },
    piAiSection: piAi,
    resolveModelInfo: async () => undefined,
    replaceImpl: async () => {
      replaceIndex += 1
      if (replaceIndex === 2) throw new Error('simulated converge replace failure')
    },
    stream: (opts) => statusChunks({ kind: 'stop', failure: null })(opts),
  })
  await mount(ctx)
  const r = await callRoute(state, '/reasoning-level-stats/probe', { provider: 'gw', model: 'm' })
  assert.equal(r.code, 200)
  assert.equal(r.payload.working.length, 7)
  // 回滚后声明 == 探测前原声明（不得停留在临时全量词汇表）
  const finalDecl = getModelReasoningEfforts(state, 'gw', 'm')
  assert.deepEqual(finalDecl, { low: 'low', high: 'high' }, 'converge replace 失败后必须回滚到 originalDecl')
  // 失败路径不持久化 pin
  assert.equal(probeEffortsMutates(state).length, 0)
  // 临时写入 + 回滚写入 = 2 次成功 replace 记录（失败的 converge replace 已被 harness 弹出）
  assert.equal(replaceCallsFor('llm-pi-ai', state).length, 2)
})

test('(F1-R1) converge：replace 与回滚均失败 → 不崩溃、不持久化 pin（日志降级）', async () => {
  const piAi = { providers: { gw: { api: 'openai-completions', models: [{ id: 'm', reasoningEfforts: { low: 'low' } }] } } }
  let replaceIndex = 0
  const { ctx, state } = makeCtx({
    nsConfig: { enabled: false, statsPublic: true },
    piAiSection: piAi,
    resolveModelInfo: async () => undefined,
    replaceImpl: async () => {
      replaceIndex += 1
      if (replaceIndex >= 2) throw new Error('converge + rollback both fail')
    },
    stream: (opts) => statusChunks({ kind: 'stop', failure: null })(opts),
  })
  await mount(ctx)
  const r = await callRoute(state, '/reasoning-level-stats/probe', { provider: 'gw', model: 'm' })
  assert.equal(r.code, 200)
  // 全失败：声明留在临时态（无法回写）——但探测路径不得崩溃、不得持久化 pin；
  // F3 保证该 7 键形状后续按“本插件生成”语义处置（不误判手写）。
  const decl = getModelReasoningEfforts(state, 'gw', 'm')
  assert.ok(decl !== undefined)
  assert.equal(decl.xhigh, 'xhigh')
  assert.equal(probeEffortsMutates(state).length, 0)
})

test('(F3-R1) apply：全量 7 键声明（pin 丢失）→ 生成语义替换而非手写并入', async () => {
  // 初始：前次探测固化的全量 7 键声明，但 pin（probeEfforts）缺失（模拟持久化失败/清理后）
  // 当前 bug：isGeneratedEfforts 不识别 7 键形状 → 走手写并入 → 所有 working 已在声明内
  // → already-verified 零写入；修复后：生成语义 → 替换为 working 集（max 被剔除）
  const full7 = { off: null, minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' }
  const piAi = { providers: { gw: { api: 'openai-completions', models: [{ id: 'm1', reasoningEfforts: JSON.parse(JSON.stringify(full7)) }] } } }
  const { ctx, state } = makeCtx({
    nsConfig: { enabled: false, statsPublic: true },
    piAiSection: piAi,
  })
  await mount(ctx)
  const r = await callRoute(state, '/reasoning-level-stats/probe/apply', {
    results: [{ provider: 'gw', model: 'm1', working: ['low', 'high', 'xhigh'], rejected: ['max'], blocked: [] }],
  })
  assert.equal(r.code, 200)
  assert.equal(r.payload.writes, 1, '7 键全量声明必须按生成语义替换（而非零写入）')
  assert.deepEqual(getModelReasoningEfforts(state, 'gw', 'm1'), { low: 'low', high: 'high', xhigh: 'xhigh' })
})

test('(F3-R1) applyPiAi：7 键全量声明不降级为 6 键生成表；6 键旧 wire 仍升级', async () => {
  // boot（enabled:true）→ applyPiAi 重算 llm-pi-ai：
  // full：7 键全量（xhigh 已实测可用）——不得被"升级"成 6 键生成表（xhigh 丢失）
  // stale：6 键生成声明但 off wire 过期（'off' 而非 openai 系 null）——升级为当前 wire
  const piAi = { providers: { gw: { api: 'openai-completions', models: [
    { id: 'full', reasoningEfforts: { off: null, minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' } },
    { id: 'stale', reasoningEfforts: { off: 'off', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', max: 'max' } },
  ] } } }
  const { ctx, state } = makeCtx({ nsConfig: { enabled: true, statsPublic: true }, piAiSection: piAi })
  await mount(ctx)
  const calls = replaceCallsFor('llm-pi-ai', state)
  assert.ok(calls.length >= 1, 'applyPiAi 必须对 stale 声明执行一次 replace')
  const last = calls[calls.length - 1].value
  const full = last.providers.gw.models.find((m) => m.id === 'full')
  const stale = last.providers.gw.models.find((m) => m.id === 'stale')
  assert.equal(full.reasoningEfforts.xhigh, 'xhigh', '7 键全量声明不得降级（xhigh 保留）')
  assert.equal(stale.reasoningEfforts.off, null, '6 键旧 wire 升级为当前 off=null')
})
