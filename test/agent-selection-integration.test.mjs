import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeCtx, mount } from './harness.mjs'

function fakeAgent(initial, options = {}) {
  let selection = { ...initial }
  const calls = []
  return {
    id: options.id ?? 'root-agent',
    calls,
    model: {
      current: () => selection,
      select: (next) => {
        calls.push(next)
        selection = { ...selection, ...next }
      },
    },
    get() { return selection },
  }
}

function pluginConfig(overrides = {}) {
  return {
    enabled: true,
    level: 'max',
    models: {},
    syncDefaultAgent: false,
    ...overrides,
  }
}

test('MAINT-042: boot sweep aligns pre-existing root agent; a post-boot agent is aligned by agent/status(running)', async () => {
  const bootAgent = fakeAgent({ provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' }, { id: 'boot' })
  const roots = [bootAgent] // 注册表随 agent 创建增长（真实宿主：announce 前 enter）
  const { ctx, state } = makeCtx({
    nsConfig: pluginConfig(),
    services: { agents: { list: () => [...roots], roots: () => [...roots] } },
  })
  await mount(ctx)
  // boot sweep 路径：settings 注入前已存在的 agent 在 applyLevel 后对齐。
  assert.deepEqual(bootAgent.calls, [{
    provider: 'deepseek-account',
    model: 'deepseek-flash',
    reasoningEffort: 'max',
  }])

  // status 路径：boot 之后新创建的 agent（已入注册表 = root，新对象 = 首见）
  // 在 running 窗口对齐——这才是 status 路径的独立断言面（REVIEW R0 F8）。
  const lateAgent = fakeAgent({ provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' }, { id: 'late' })
  roots.push(lateAgent)
  state.handlers.get('agent/status')({ status: 'running', agent: lateAgent })
  assert.deepEqual(lateAgent.calls, [{
    provider: 'deepseek-account',
    model: 'deepseek-flash',
    reasoningEffort: 'max',
  }])
})

test('MAINT-042 (REVIEW R0 F2): native path + per-model override → waterfall returns the SAME config untouched', async () => {
  // 这正是 0.2.2 守卫崩溃形状的钉子：若 hostHasNativeAgentSelection() 的
  // early-return 被删，legacy 分支会注入 reasoningEffort:'max' → 宿主
  // preStep 守卫 throw 整步失败。断言 = 原对象原样返回且无 effort 字段。
  const agent = fakeAgent({ provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'max' })
  const { ctx, state } = makeCtx({
    nsConfig: pluginConfig({ models: { 'deepseek-account/deepseek-flash': 'max' } }),
    deepseekAccountSection: {},
    services: { agents: { list: () => [agent], roots: () => [agent] } },
  })
  await mount(ctx)
  const onRequest = state.handlers.get('agent/request')
  const config = { provider: 'deepseek-account', model: 'deepseek-flash' }
  const result = await onRequest({}, async () => config)
  assert.equal(result, config, '原生面在场时必须原对象返回（不改写、不复制）')
  assert.equal(result.reasoningEffort, undefined, '瀑布里绝不注入 effort（0.2.2 等值守卫）')
})

test('MAINT-042 (REVIEW R0 F3): agents service PRESENT but 0.2.1-shaped (no AgentModel) → legacy injection still works', async () => {
  // 钉 hostHasNativeAgentSelection 的判据 = 方法在场，不是注册表在场：
  // 'registry-presence = native' 型回归会静默杀死 0.2.1 的模型级默认注入。
  const legacyAgent = { id: 'legacy-root', model: {} }
  const { ctx, state } = makeCtx({
    nsConfig: pluginConfig({ models: { 'deepseek-account/deepseek-flash': 'max' } }),
    deepseekAccountSection: {},
    services: { agents: { list: () => [legacyAgent], roots: () => [legacyAgent] } },
  })
  await mount(ctx)
  const onRequest = state.handlers.get('agent/request')
  const result = await onRequest({}, async () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }))
  assert.equal(result.reasoningEffort, 'max', '注册表在场但无 AgentModel → legacy 注入路径必须保留')
})

test('MAINT-042: 0.2.1 hosts (no agents service at all) keep legacy agent/request injection', async () => {
  const { ctx, state } = makeCtx({
    nsConfig: pluginConfig({ models: { 'deepseek-account/deepseek-flash': 'max' } }),
    deepseekAccountSection: {},
  })
  await mount(ctx)
  const onRequest = state.handlers.get('agent/request')
  const result = await onRequest({}, async () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }))
  assert.equal(result.reasoningEffort, 'max', 'legacy 宿主继续由瀑布补模型级默认')
})

test('MAINT-042: explicit subagent effort is not overridden by status event', async () => {
  const child = fakeAgent({ provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'low' }, { id: 'child' })
  const root = fakeAgent({ provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' }, { id: 'root' })
  const { ctx, state } = makeCtx({
    nsConfig: pluginConfig(),
    services: { agents: { list: () => [root, child], roots: () => [root] } },
  })
  await mount(ctx)
  state.handlers.get('agent/status')({ status: 'running', agent: child })
  assert.equal(child.calls.length, 0, '子 agent 显式 low 必须保留')
})
