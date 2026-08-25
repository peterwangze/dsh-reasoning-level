/**
 * DEV-002 F8 最小回归测试：v0.7.0 一键探测/固化核心逻辑。
 * MAINT-013（0.7.1）：黑名单语义修正——探测拒绝仅作为该次探测结果的 rejected
 * 列表返回，不入黑名单、不持久化；持久化 probeBlacklist 兼容保留但不再装载；
 * 真实调用拒绝经自愈仅入会话内存黑名单；/probe 探测开始即重置该模型黑名单。
 *
 * 覆盖（对应 R0 报告 F8 建议用例 a-d）：
 *  (a) probeModelLevels 分类：ok / rejected(UNSUPPORTED_REASONING_EFFORT) / blocked(aborted)；
 *      候选全量重测、拒绝等级不入黑名单（零持久化、内存黑名单仍为空）；
 *  (b) applyProbeResults：用户手写声明跳过、working 白名单、pin 台账；
 *  (c) MAINT-013：持久化 probeBlacklist 不装载；真实调用拒绝仅内存态（注入跳过）；
 *      /probe 起始重置该模型黑名单 → 注入恢复；探测拒绝不入黑名单；
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

test('(a) probeModelLevels：ok/rejected/blocked 分类；拒绝等级仅入结果列表（不入黑名单、不持久化）；MAINT-014 discovery 探测', async () => {
  const reasons = {
    low: { kind: 'stop', failure: null },
    high: { kind: 'error', failure: { code: 'UNSUPPORTED_REASONING_EFFORT', message: 'gateway does not support reasoning effort "high"' } },
    medium: { kind: 'aborted', failure: null },
    __dsh_discovery__: { kind: 'error', failure: { code: 'UNSUPPORTED_REASONING_EFFORT', message: 'reasoning effort "__dsh_discovery__" is not supported. Valid values: [\'low\',\'medium\',\'high\']' } },
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
  assert.equal(r.payload.working.join(','), 'low')
  assert.equal(r.payload.rejected.join(','), 'high')
  assert.equal(r.payload.blocked.join(','), 'medium')
  assert.equal(r.payload.key, 'p/m')
  // MAINT-013：候选不受任何黑名单过滤——每次探测全量重测所有候选等级
  // MAINT-014：额外包含 discovery 请求（__dsh_discovery__）
  assert.deepEqual(probed.sort(), ['__dsh_discovery__', 'high', 'low', 'medium'])
  // 拒绝等级仅作为该次探测结果的 rejected 列表返回：零黑名单持久化，内存黑名单为空
  assert.equal(blacklistMutates(state).length, 0)
  const stats = await callRoute(state, '/reasoning-level-stats', {})
  assert.deepEqual(stats.payload.blacklist, {})
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
  // MAINT-014：xhigh 不再被 GENERATED_LEVELS 过滤——以等级名自身作为线值固化
  // （off='disabled'、low='low'、xhigh='xhigh'；high 被拒绝不入固化）
  assert.deepEqual(state.replaceCalls[0].value.providers.zai.models[0].reasoningEfforts, { off: 'disabled', low: 'low', xhigh: 'xhigh' })
  // pin 持久化：probeEfforts 写入（T1 注释修正——按 R1 §0.5：旧 schema 在本机
  // schemastery 3.18.1 下经 Schema.from(null)→any() 直通，'disabled' 实际能落盘，
  // 代价是线值零校验；并非"校验失败静默不落盘"）
  const pe = probeEffortsMutates(state)
  assert.equal(pe.length, 1)
  assert.deepEqual(pe[0].ops[0].value, { 'zai/m2': { off: 'disabled', low: 'low', xhigh: 'xhigh' } })
  // F1：schema 接受含 'disabled' 与 xhigh 的 probeEfforts（用真实注册的 Config schema 校验）
  const schema = state.schemas.get(NS)
  assert.ok(schema, 'Config schema must be registered')
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
  // 值 schema 明确为 string|null：非字符串值被拒绝（旧 union 的 null 成员经
  // Schema.from(null) 编译为 any()，任意值都会通过——线值完全未校验）
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
  // boot 不装载持久化黑名单：settings 中既有 probeBlacklist {'a/b': ['low']} 被忽略
  // （兼容保留、零数据破坏），内存黑名单为空
  assert.deepEqual(await statsBlacklist(), {})

  // 真实调用被网关拒绝 → 自愈降级：仅会话内存态标记（注入跳过），零持久化
  const onError = state.handlers.get('agent/request-error')
  assert.ok(onError, 'agent/request-error handler must be registered')
  await onError({ provider: 'a', agent: { options: { model: 'b' } }, failure: { code: 'UNSUPPORTED_REASONING_EFFORT', message: 'reasoning effort "high"' } }, async () => {})
  assert.deepEqual(await statsBlacklist(), { 'a/b': ['high'] })
  assert.equal(blacklistMutates(state).length, 0)

  // 注入路径（agent/request）：黑名单等级被跳过（自愈仍生效）
  const onRequest = state.handlers.get('agent/request')
  assert.ok(onRequest, 'agent/request handler must be registered')
  const cfg1 = await onRequest({}, async () => ({ provider: 'a', model: 'b', maxTokens: 1 }))
  assert.equal(cfg1.reasoningEffort, undefined)

  // /probe：探测开始即重置该 provider/model 的既有黑名单 → 全量重测
  const r = await callRoute(state, '/reasoning-level-stats/probe', { provider: 'a', model: 'b' })
  assert.deepEqual(r.payload.working, ['high'])
  assert.deepEqual(r.payload.rejected, ['low'])
  // 探测中的拒绝不入黑名单（测量不是调用）：探测后内存黑名单为空、零持久化
  assert.deepEqual(await statsBlacklist(), {})
  assert.equal(blacklistMutates(state).length, 0)
  // 重置后注入恢复：同一等级再次可注入
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
  // 失败路径：不发出 probeEfforts 持久化（内存台账未落、磁盘未改，无分叉）
  assert.equal(probeEffortsMutates(state).length, 0)
  // 重试成功：出本次写入事件顺序为 replace -> mutate（先落盘再持久化台账）
  fail = false
  const r2 = await callRoute(state, '/reasoning-level-stats/probe/apply', { results })
  assert.equal(r2.payload.writes, 1)
  const order = state.events.slice(-2)
  assert.deepEqual(order, ['replace:llm-pi-ai', 'mutate:' + NS])
})

// ── MAINT-014：探测等级发现增强 ──────────────────────────────────────────────

test('MAINT-014: discovery 解析网关拒绝响应中的 valid-values 列表，非标准档进入候选', async () => {
  // 模型无目录声明，discovery 返回 valid values 含非标准档 'ultra'
  const probed = []
  const { ctx, state } = makeCtx({
    nsConfig: { enabled: false, statsPublic: true },
    resolveModelInfo: async () => undefined,
    stream: (opts) => {
      probed.push(opts.reasoningEffort)
      if (opts.reasoningEffort === '__dsh_discovery__') {
        return statusChunks({
          kind: 'error',
          failure: { code: 'UNSUPPORTED_REASONING_EFFORT', message: 'reasoning effort "__dsh_discovery__" is not supported. Valid values: [\'low\',\'medium\',\'high\',\'ultra\']' },
        })(opts)
      }
      return statusChunks({ kind: 'stop', failure: null })(opts)
    },
  })
  await mount(ctx)
  const r = await callRoute(state, '/reasoning-level-stats/probe', { provider: 'p', model: 'm' })
  assert.equal(r.code, 200)
  // discovery 发现的 'ultra' 必须出现在候选结果中（不过 LEVELS 过滤）
  assert.ok(r.payload.working.includes('ultra'), 'discovery-found ultra must be in working')
  assert.ok(r.payload.working.includes('low'), 'standard level low must also be in working')
  assert.ok(r.payload.working.includes('high'), 'standard level high must also be in working')
  assert.ok(r.payload.working.includes('medium'), 'standard level medium must also be in working')
  // discovery 请求本身应在探测中出现
  assert.ok(probed.includes('__dsh_discovery__'), 'discovery probe must be issued')
})

test('MAINT-014: discovery 无有效等级列表时回退现有候选逻辑（不导致探测整体失败）', async () => {
  const probed = []
  const { ctx, state } = makeCtx({
    nsConfig: { enabled: false, statsPublic: true },
    resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } }),
    stream: (opts) => {
      probed.push(opts.reasoningEffort)
      if (opts.reasoningEffort === '__dsh_discovery__') {
        // 错误但不含可解析的等级列表
        return statusChunks({
          kind: 'error',
          failure: { code: 'INTERNAL_ERROR', message: 'internal server error' },
        })(opts)
      }
      return statusChunks({ kind: 'stop', failure: null })(opts)
    },
  })
  await mount(ctx)
  const r = await callRoute(state, '/reasoning-level-stats/probe', { provider: 'p', model: 'm' })
  assert.equal(r.code, 200)
  // 回退到目录声明：low、high 可用
  assert.deepEqual(r.payload.working.sort(), ['high', 'low'])
  assert.equal(r.payload.error, undefined)
  assert.ok(probed.includes('__dsh_discovery__'), 'discovery probe was attempted')
})

test('MAINT-014: resolveModelInfo 返回的非标准档不被 LEVELS 过滤丢弃', async () => {
  const probed = []
  const { ctx, state } = makeCtx({
    nsConfig: { enabled: false, statsPublic: true },
    resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low' }, { id: 'high' }, { id: 'ultra' }] } }),
    stream: (opts) => {
      probed.push(opts.reasoningEffort)
      if (opts.reasoningEffort === '__dsh_discovery__') {
        // discovery 无有用信息，不干扰测试
        return statusChunks({
          kind: 'error',
          failure: { code: 'UNSUPPORTED_REASONING_EFFORT', message: 'no' },
        })(opts)
      }
      return statusChunks({ kind: 'stop', failure: null })(opts)
    },
  })
  await mount(ctx)
  const r = await callRoute(state, '/reasoning-level-stats/probe', { provider: 'p', model: 'm' })
  assert.equal(r.code, 200)
  // LEVELS 过滤已移除（MAINT-014）：resolveModelInfo 声明的 'ultra' 应进入候选
  assert.ok(r.payload.working.includes('ultra'), 'ultra from resolveModelInfo must not be filtered by LEVELS')
  assert.ok(r.payload.working.includes('low'))
  assert.ok(r.payload.working.includes('high'))
})

test('MAINT-014: applyProbeResults 固化非标准 working 等级（线值=等级名自身）', async () => {
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
  // 标准档使用生成线值（off->disabled 因 openai-completions 非 zai/deepseek 路由 → null）；
  // 非标准档 ultra/custom 以等级名自身为线值
  assert.deepEqual(state.replaceCalls[0].value.providers.gateway.models[0].reasoningEfforts, {
    off: null,
    low: 'low',
    ultra: 'ultra',
    custom: 'custom',
  })
  // probeEfforts 持久化同样含非标准档
  const pe = probeEffortsMutates(state)
  assert.equal(pe.length, 1)
  assert.deepEqual(pe[0].ops[0].value, { 'gateway/m4': { off: null, low: 'low', ultra: 'ultra', custom: 'custom' } })
})

test('MAINT-014: discovery 发现级与目录声明并集——目录声明标准档+discovery 非标准档共存', async () => {
  const probed = []
  const { ctx, state } = makeCtx({
    nsConfig: { enabled: false, statsPublic: true },
    resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } }),
    stream: (opts) => {
      probed.push(opts.reasoningEffort)
      if (opts.reasoningEffort === '__dsh_discovery__') {
        return statusChunks({
          kind: 'error',
          failure: { code: 'UNSUPPORTED_REASONING_EFFORT', message: 'reasoning effort "__dsh_discovery__" is not supported. Available: low, high, ultra, turbo.' },
        })(opts)
      }
      return statusChunks({ kind: 'stop', failure: null })(opts)
    },
  })
  await mount(ctx)
  const r = await callRoute(state, '/reasoning-level-stats/probe', { provider: 'p', model: 'm' })
  assert.equal(r.code, 200)
  // 目录声明贡献 low、high（LEVELS 保留过滤）
  // discovery 贡献 ultra、turbo（不过 LEVELS）
  assert.ok(r.payload.working.includes('low'), 'standard low from directory')
  assert.ok(r.payload.working.includes('high'), 'standard high from directory')
  assert.ok(r.payload.working.includes('ultra'), 'non-standard ultra from discovery')
  assert.ok(r.payload.working.includes('turbo'), 'non-standard turbo from discovery')
  assert.ok(probed.includes('__dsh_discovery__'), 'discovery probe was issued')
})
