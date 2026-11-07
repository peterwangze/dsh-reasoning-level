import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  targetEffortFor,
  planEffortSelection,
  createAgentEffortEnforcer,
} from '../lib/agent-selection.js'

const LEVELS = ['off', 'low', 'high', 'max']
const ROUTE = { provider: 'deepseek-account', model: 'deepseek-flash' }

function fakeAgent(initial, options = {}) {
  let selection = { ...initial }
  const calls = []
  const agent = {
    id: options.id ?? 'agent-1',
    calls,
    model: {
      current: options.current ?? (() => selection),
      select: options.select ?? ((next) => {
        calls.push(next)
        selection = { ...selection, ...next }
      }),
    },
  }
  return {
    agent,
    calls,
    set(next) { selection = { ...selection, ...next } },
    get() { return selection },
  }
}

function config(overrides = {}) {
  return { enabled: true, level: 'max', models: {}, ...overrides }
}

test('targetEffortFor: model override beats global level; disabled yields undefined', () => {
  assert.equal(targetEffortFor({ enabled: true, level: 'max', models: {} }, 'p', 'm'), 'max')
  assert.equal(targetEffortFor({ enabled: true, level: 'max', models: { 'p/m': 'low' } }, 'p', 'm'), 'low')
  assert.equal(targetEffortFor({ enabled: false, level: 'max', models: { 'p/m': 'low' } }, 'p', 'm'), undefined)
  assert.equal(targetEffortFor({ enabled: true, level: 'max', models: { 'p/m': '' } }, 'p', 'm'), 'max')
  assert.equal(targetEffortFor(undefined, 'p', 'm'), undefined)
  assert.equal(targetEffortFor({ enabled: true, level: 'max' }, '', 'm'), undefined)
})

test('planEffortSelection: stale high on first sight selects max', () => {
  const plan = planEffortSelection({
    config: config(),
    selection: { ...ROUTE, reasoningEffort: 'high' },
    supported: LEVELS,
    isRoot: true,
  })
  assert.deepEqual(plan, { action: 'select', reason: 'first-sight', effort: 'max' })
})

test('planEffortSelection: already max is aligned; same route later honors user choice', () => {
  const seen = { routeKey: 'deepseek-account/deepseek-flash', target: 'max' }
  assert.equal(planEffortSelection({
    config: config(),
    selection: { ...ROUTE, reasoningEffort: 'max' },
    supported: LEVELS,
    isRoot: true,
    seen,
  }).reason, 'aligned')
  assert.equal(planEffortSelection({
    config: config(),
    selection: { ...ROUTE, reasoningEffort: 'high' },
    supported: LEVELS,
    isRoot: true,
    seen,
  }).reason, 'user-choice')
})

test('planEffortSelection: route change and target change re-align', () => {
  const seen = { routeKey: 'deepseek-account/deepseek-flash', target: 'max' }
  assert.equal(planEffortSelection({
    config: config(),
    selection: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' },
    supported: LEVELS,
    isRoot: true,
    seen,
  }).reason, 'route-change')
  assert.equal(planEffortSelection({
    config: config({ level: 'low' }),
    selection: { ...ROUTE, reasoningEffort: 'max' },
    supported: LEVELS,
    isRoot: true,
    seen,
  }).reason, 'target-change')
})

test('planEffortSelection: unsupported and unknown capability are distinct', () => {
  assert.equal(planEffortSelection({
    config: config({ level: 'max' }),
    selection: { ...ROUTE, reasoningEffort: 'high' },
    supported: ['off', 'low', 'high'],
    isRoot: true,
  }).reason, 'unsupported')
  assert.equal(planEffortSelection({
    config: config({ level: 'max' }),
    selection: { ...ROUTE, reasoningEffort: 'high' },
    supported: undefined,
    isRoot: true,
  }).reason, 'capability-unknown')
})

test('planEffortSelection: subagents only fill a missing effort', () => {
  assert.equal(planEffortSelection({
    config: config(),
    selection: ROUTE,
    supported: LEVELS,
    isRoot: false,
  }).reason, 'missing-effort')
  assert.equal(planEffortSelection({
    config: config(),
    selection: { ...ROUTE, reasoningEffort: 'high' },
    supported: LEVELS,
    isRoot: false,
  }).reason, 'explicit-effort')
})

test('enforcer: root stale high selects max once; later user high is preserved', () => {
  const fake = fakeAgent({ ...ROUTE, reasoningEffort: 'high' })
  const enforcer = createAgentEffortEnforcer({
    getConfig: () => config(),
    syncEfforts: () => LEVELS,
    isRoot: () => true,
  })
  enforcer.created({ agent: fake.agent })
  assert.deepEqual(fake.calls, [{ ...ROUTE, reasoningEffort: 'max' }])
  assert.equal(enforcer.mode(), 'native')

  fake.set({ reasoningEffort: 'high' })
  enforcer.status({ status: 'running', agent: fake.agent })
  assert.equal(fake.calls.length, 1, 'same-route user choice must not be overridden')
  assert.equal(fake.get().reasoningEffort, 'high')
})

test('enforcer: route change selects max again', () => {
  const fake = fakeAgent({ ...ROUTE, reasoningEffort: 'high' })
  const enforcer = createAgentEffortEnforcer({
    getConfig: () => config(),
    syncEfforts: () => LEVELS,
    isRoot: () => true,
  })
  enforcer.created({ agent: fake.agent })
  fake.set({ provider: 'deepseek-official' })
  enforcer.status({ status: 'running', agent: fake.agent })
  assert.equal(fake.calls.at(-1).provider, 'deepseek-official')
  assert.equal(fake.calls.at(-1).reasoningEffort, 'max')
})

test('enforcer: model override beats global; disabled config never selects', () => {
  const fake = fakeAgent({ ...ROUTE, reasoningEffort: 'high' })
  const enforcer = createAgentEffortEnforcer({
    getConfig: () => config({ models: { 'deepseek-account/deepseek-flash': 'low' } }),
    syncEfforts: () => LEVELS,
    isRoot: () => true,
  })
  enforcer.created({ agent: fake.agent })
  assert.equal(fake.calls[0].reasoningEffort, 'low')

  const disabled = fakeAgent({ ...ROUTE, reasoningEffort: 'high' })
  const off = createAgentEffortEnforcer({
    getConfig: () => config({ enabled: false }),
    syncEfforts: () => LEVELS,
    isRoot: () => true,
  })
  off.created({ agent: disabled.agent })
  assert.equal(disabled.calls.length, 0)
})

test('enforcer: unsupported target never selects', () => {
  const fake = fakeAgent({ ...ROUTE, reasoningEffort: 'high' })
  const enforcer = createAgentEffortEnforcer({
    getConfig: () => config({ level: 'max' }),
    syncEfforts: () => ['off', 'low', 'high'],
    isRoot: () => true,
  })
  enforcer.created({ agent: fake.agent })
  assert.equal(fake.calls.length, 0)
})

test('enforcer: subagent explicit high is preserved; missing effort is filled', () => {
  const explicit = fakeAgent({ ...ROUTE, reasoningEffort: 'high' })
  const missing = fakeAgent(ROUTE)
  const enforcer = createAgentEffortEnforcer({
    getConfig: () => config(),
    syncEfforts: () => LEVELS,
    isRoot: () => false,
  })
  enforcer.created({ agent: explicit.agent })
  enforcer.created({ agent: missing.agent })
  assert.equal(explicit.calls.length, 0)
  assert.equal(missing.calls.length, 1)
  assert.equal(missing.calls[0].reasoningEffort, 'max')
})

test('enforcer: unknown capability defers, then selects once after resolve', async () => {
  const fake = fakeAgent({ ...ROUTE, reasoningEffort: 'high' })
  const resolved = Promise.withResolvers()
  const enforcer = createAgentEffortEnforcer({
    getConfig: () => config(),
    syncEfforts: () => undefined,
    resolveEfforts: () => resolved.promise,
    isRoot: () => true,
  })
  enforcer.created({ agent: fake.agent })
  assert.equal(fake.calls.length, 0, 'must not guess an unverified effort')

  resolved.resolve(LEVELS)
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(fake.calls, [{ ...ROUTE, reasoningEffort: 'max' }])
})

test('enforcer: user effort change during async resolve is never overwritten', async () => {
  const fake = fakeAgent({ ...ROUTE, reasoningEffort: 'high' })
  const resolved = Promise.withResolvers()
  const enforcer = createAgentEffortEnforcer({
    getConfig: () => config(),
    syncEfforts: () => undefined,
    resolveEfforts: () => resolved.promise,
    isRoot: () => true,
  })
  enforcer.created({ agent: fake.agent })
  fake.set({ reasoningEffort: 'low' })
  resolved.resolve(LEVELS)
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(fake.calls.length, 0)
  assert.equal(fake.get().reasoningEffort, 'low')
})

test('enforcer: sweep aligns agents created before settings injection', () => {
  const first = fakeAgent({ ...ROUTE, reasoningEffort: 'high' }, { id: 'first' })
  const second = fakeAgent({ provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' }, { id: 'second' })
  const enforcer = createAgentEffortEnforcer({
    getConfig: () => config(),
    syncEfforts: () => LEVELS,
    isRoot: () => true,
    listAgents: () => [first.agent, second.agent],
  })
  enforcer.sweep()
  assert.equal(first.calls.length, 1)
  assert.equal(second.calls.length, 1)
})

test('enforcer: 0.2.1-shaped agents are legacy no-ops', () => {
  const agent = { id: 'legacy', calls: [], model: {} }
  const enforcer = createAgentEffortEnforcer({
    getConfig: () => config(),
    syncEfforts: () => LEVELS,
    isRoot: () => true,
  })
  enforcer.created({ agent })
  enforcer.status({ status: 'running', agent })
  enforcer.sweep()
  assert.equal(agent.calls.length, 0)
  assert.equal(enforcer.mode(), 'legacy')
})

test('planEffortSelection: excluded target skips before capability check and does not consume first-sight', () => {
  assert.deepEqual(planEffortSelection({
    config: config({ level: 'max' }),
    selection: { ...ROUTE, reasoningEffort: 'high' },
    supported: LEVELS,
    isRoot: true,
    excluded: true,
  }), { action: 'skip', reason: 'excluded', effort: 'max' })
  // excluded 的判定先于能力未知——黑名单是确定性输入，不需要等预热。
  assert.equal(planEffortSelection({
    config: config({ level: 'max' }),
    selection: { ...ROUTE, reasoningEffort: 'high' },
    supported: undefined,
    isRoot: true,
    excluded: true,
  }).reason, 'excluded')
})

test('enforcer: excluded target never selects, later non-excluded target re-aligns (REVIEW R0 F1)', () => {
  const fake = fakeAgent({ ...ROUTE, reasoningEffort: 'high' })
  const excludedEfforts = new Set(['max'])
  const make = (level) => createAgentEffortEnforcer({
    getConfig: () => config({ level }),
    syncEfforts: () => LEVELS,
    isRoot: () => true,
    isExcluded: (provider, model, effort) => excludedEfforts.has(effort),
  })
  make('max').created({ agent: fake.agent })
  assert.equal(fake.calls.length, 0, '黑名单档绝不 select')

  // 目标改为非黑名单档（模拟用户把全局等级从 max 调到 low）→ 重新对齐；
  // excluded 跳过不落 seen，目标变化后仍按首见语义 select。
  make('low').status({ status: 'running', agent: fake.agent })
  assert.deepEqual(fake.calls, [{ ...ROUTE, reasoningEffort: 'low' }])
})

test('enforcer: throwing host objects are contained and reported', () => {
  const currents = fakeAgent({ ...ROUTE, reasoningEffort: 'high' }, {
    current: () => { throw new Error('current boom') },
  })
  const selects = fakeAgent({ ...ROUTE, reasoningEffort: 'high' }, {
    select: () => { throw new Error('select boom') },
  })
  const health = []
  const enforcer = createAgentEffortEnforcer({
    getConfig: () => config(),
    syncEfforts: () => LEVELS,
    isRoot: () => true,
    listAgents: () => [currents.agent, selects.agent],
    onHealth: (patch) => health.push(patch),
  })
  assert.doesNotThrow(() => enforcer.created({ agent: currents.agent }))
  assert.doesNotThrow(() => enforcer.created({ agent: selects.agent }))
  assert.doesNotThrow(() => enforcer.status({ status: 'running', agent: selects.agent }))
  assert.doesNotThrow(() => enforcer.sweep())
  assert.ok(health.some((entry) => entry.lastError === 'select boom'))
})
