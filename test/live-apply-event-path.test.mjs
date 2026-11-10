/**
 * FEAT-007 live-apply 事件路径判别测试（P0 活性缺陷修复）。
 *
 * 实证根因（隔离实例 dsh 0.2.1-rc.2，2026-11-10）：
 *  · `settings/document-updated` 在宿主 HMR 配置重载的 `runExclusive` 事务内
 *    同步派发（dsh-hmr `AsyncLocalStorage.run(true, op)`）；handler 同一 tick
 *    启动的 apply 继承该事务，其 `settings.mutate/replace` 再次进入
 *    `runExclusive` → `Error: HMR transactions cannot be nested` → live 写入
 *    不生效（boot 在事务外，所以成功）。
 *  · 自写事件（本插件写 host/台账后宿主再 emit）在同一 tick 内放大 apply，
 *    造成 live 变更后半秒级延迟与多轮无谓 apply。
 *
 * 修复（以 `lib/index.js` 代码为准）：
 *  · 事件 handler 只做缓存失效 + `scheduleApply` 合并调度（first-wins）：apply
 *    经 `AsyncLocalStorage.bind` 捕获的事务外上下文在下一 macrotask 执行；
 *  · 自写事件用 `selfWriteNs`（按 ns 栈）在源头抑制：只丢弃「当前正在写的 ns」
 *    的同步 emit，写窗口内其他 ns 的事件照常调度（不吞外部变更）；
 *  · 写路径另有 HMR 事务拒绝文本的有限重试：最多 3 次（0/20/20ms 间隔），
 *    每次尝试都整体跑在事务外，第 3 次仍失败才抛出。
 *
 * 判别策略：settings 桩在写落定后同步 emit（真实宿主形状）；用例只经真实写
 * API（update/mutate）驱动，不手工调用 handler。旧实现（handler 内同步
 * applyLevel + 无重试）在 live-1 判红（host 等级停在旧值）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeCtx, mount } from './harness.mjs'

const clone = (value) => JSON.parse(JSON.stringify(value))

/** 本次测试独占的 DSH_HOME（迁移/台账读面不碰真实用户目录）。 */
function tempHome() {
  const previous = process.env.DSH_HOME
  const home = mkdtempSync(join(tmpdir(), 'dsh-rl-live-'))
  process.env.DSH_HOME = home
  return {
    restore: () => {
      process.env.DSH_HOME = previous
      rmSync(home, { recursive: true, force: true })
    },
  }
}

const waitFor = async (predicate, timeoutMs = 2500, label = 'condition') => {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.fail(`等待超时：${label}（${timeoutMs}ms）`)
}

/** apply 成功次数（lib/index.js 收口 info 日志：`dsh-reasoning-level: applied,`）。 */
const appliedCount = (state) => state.logs.filter((entry) => entry.level === 'info'
  && typeof entry.args[0] === 'string'
  && entry.args[0].startsWith('dsh-reasoning-level: applied,')).length

const hostWriteCalls = (state, ns) => state.mutateCalls.filter((call) => call.ns === ns)

test('(live-1) HMR 事务内 settings 事件：apply 调度到事务外，host+台账收敛（旧实现 RED）', async () => {
  const env = tempHome()
  try {
    const hmr = new AsyncLocalStorage()
    const { ctx, state } = makeCtx({
      nsConfig: { enabled: true, level: 'low' },
      deepseekSection: { reasoningEffort: 'low' },
      emitSettingsEvents: true,
      // 模拟宿主 HMR：事务内启动的 settings 写被 runExclusive 拒绝。
      writeGuard: () => (hmr.getStore() === true ? new Error('HMR transactions cannot be nested') : undefined),
    })
    await mount(ctx)
    await waitFor(() => appliedCount(state) >= 1, 2000, 'boot apply')
    assert.equal(state.deepseekSection.reasoningEffort, 'low', '前置：boot 已按 level=low 收敛')

    // 真实宿主在 HMR 事务内写设置并 emit；handler 必须把 apply 调度到事务外。
    await hmr.run(true, async () => {
      await state.settings.update('llm-reasoning', { level: 'max' })
      assert.equal(state.deepseekSection.reasoningEffort, 'low', '事务内不得同步写 host')
    })

    // 旧实现：apply 沿事务上下文执行 → mutate 被拒 → host 永远停在 low（RED）。
    await waitFor(() => state.deepseekSection.reasoningEffort === 'max', 2500, 'host 等级收敛到 max')
    await waitFor(() => state.nsConfig.applied?.deepseek?.level === 'max', 2500, 'applied 台账收敛到 max')
    assert.deepEqual(state.nsConfig.applied.deepseek, { level: 'max', original: 'low' })
    assert.equal(state.eventHandlerErrors.length, 0, '事件派发不得向宿主抛错')
    assert.equal(state.logs.filter((entry) => entry.level === 'error').length, 0)
  } finally {
    env.restore()
  }
})

test('(live-2) HMR 事务拒绝文本 → 写路径重试一次并成功（最终无失败日志）', async () => {
  const env = tempHome()
  try {
    const { ctx, state } = makeCtx({
      nsConfig: { enabled: true, level: 'low' },
      deepseekSection: { reasoningEffort: 'low' },
      emitSettingsEvents: true,
      hmrNestedOnce: true,
    })
    await mount(ctx)
    await waitFor(() => appliedCount(state) >= 1, 2000, 'boot apply')
    // boot 无写（level/section 已一致），hmrNestedOnce 留给 live 首写。
    state.logs.length = 0

    await state.settings.update('llm-reasoning', { level: 'high' })
    await waitFor(() => state.deepseekSection.reasoningEffort === 'high', 2500, '重试后 host 收敛到 high')
    await waitFor(() => state.nsConfig.applied?.deepseek?.level === 'high', 2500, '重试后台账收敛')

    const retries = state.logs.filter((entry) => entry.level === 'warn'
      && typeof entry.args[0] === 'string'
      && entry.args[0].includes('retrying outside it'))
    assert.equal(retries.length, 1, '恰一次 HMR 事务写重试')
    assert.match(retries[0].args[0], /attempt 1/)
    const failedWrites = state.logs.filter((entry) => entry.level === 'warn'
      && typeof entry.args[0] === 'string'
      && (entry.args[0].includes('mutate failed') || entry.args[0].includes('replace failed')))
    assert.equal(failedWrites.length, 0, '重试成功后不得残留写失败日志')
    assert.deepEqual(state.nsConfig.applied.deepseek, { level: 'high', original: 'low' })
  } finally {
    env.restore()
  }
})

test('(live-3) selfWriteNs 源头抑制：一次 level 变更 host 只写一次、apply 次数有界', async () => {
  const env = tempHome()
  try {
    const { ctx, state } = makeCtx({
      nsConfig: { enabled: true, level: 'low' },
      deepseekSection: { reasoningEffort: 'low' },
      emitSettingsEvents: true,
    })
    await mount(ctx)
    await waitFor(() => appliedCount(state) >= 1, 2000, 'boot apply')
    // 让 boot 期事件与合并调度收口，再开始计数。
    await new Promise((resolve) => setTimeout(resolve, 600))
    state.logs.length = 0
    state.mutateCalls.length = 0

    await state.settings.update('llm-reasoning', { level: 'max' })
    await waitFor(() => state.deepseekSection.reasoningEffort === 'max', 2500, 'host 收敛到 max')
    await new Promise((resolve) => setTimeout(resolve, 700))

    assert.equal(hostWriteCalls(state, 'llm-deepseek').length, 1, '一次用户变更只写一次 host')
    const applies = appliedCount(state)
    assert.ok(applies >= 1, '至少一次 apply')
    assert.ok(applies <= 3, `apply 次数必须有界（实际 ${applies}）`)
    assert.deepEqual(state.nsConfig.applied.deepseek, { level: 'max', original: 'low' })
  } finally {
    env.restore()
  }
})

test('(live-4) 合并调度不吞外部事件：用户手改 host 配置最终收敛回插件配置', async () => {
  const env = tempHome()
  try {
    const { ctx, state } = makeCtx({
      nsConfig: { enabled: true, level: 'low' },
      deepseekSection: { reasoningEffort: 'low' },
      emitSettingsEvents: true,
    })
    await mount(ctx)
    await waitFor(() => appliedCount(state) >= 1, 2000, 'boot apply')

    await state.settings.update('llm-reasoning', { level: 'max' })
    await waitFor(() => state.deepseekSection.reasoningEffort === 'max', 2500, 'host 收敛到 max')

    // 用户经宿主设置手改 llm-deepseek：事件与其他调度 first-wins 合并，不得丢。
    await state.settings.mutate('llm-deepseek', [{ op: 'set', path: ['reasoningEffort'], value: 'medium' }])
    assert.equal(state.deepseekSection.reasoningEffort, 'medium', '手改已落盘')
    await waitFor(() => state.deepseekSection.reasoningEffort === 'max', 2500, '合并调度后收敛回配置等级 max')
    assert.deepEqual(state.nsConfig.applied.deepseek, { level: 'max', original: 'low' })
  } finally {
    env.restore()
  }
})

test('(live-5) 写窗口内其他 ns 事件不吞：写 llm-deepseek 期间到达的 llm-reasoning 变更仍被应用', async () => {
  const env = tempHome()
  try {
    // 在插件写 llm-deepseek 的同步窗口里模拟「用户又改了 llm-reasoning」：
    // 旧实现用全局 selfWriteDepth 会把该事件一并吞掉 → 最终停在 max（RED）；
    // selfWriteNs 只抑制同名 ns → 事件排队，level=high 最终生效。
    let injected = false
    const { ctx, state } = makeCtx({
      nsConfig: { enabled: true, level: 'low' },
      deepseekSection: { reasoningEffort: 'low' },
      emitSettingsEvents: true,
      writeGuard: () => {
        if (!injected && state.nsConfig.level === 'max') {
          injected = true
          // 同步改配置并同步 emit（不走 await，确保落在写同步栈内）。
          void state.settings.update('llm-reasoning', { level: 'high' })
        }
        return undefined
      },
    })
    await mount(ctx)
    await waitFor(() => appliedCount(state) >= 1, 2000, 'boot apply')

    await state.settings.update('llm-reasoning', { level: 'max' })
    await waitFor(() => state.deepseekSection.reasoningEffort === 'high', 3000, '写窗口内 llm-reasoning 事件最终生效')
    assert.equal(state.deepseekSection.reasoningEffort, 'high', 'level=high 不得被写窗口吞掉')
    assert.deepEqual(state.nsConfig.applied.deepseek, { level: 'high', original: 'low' })
  } finally {
    env.restore()
  }
})

test('(live-6) 陈旧所有权台账自愈：host 已等于目标 level 时仍修复 applied（旧实现 RED）', async () => {
  const env = tempHome()
  try {
    // 真实隔离压力复现：5 轮 low↔max 后 host=max 但 applied.deepseek.level=low。
    // 旧实现只在 section.reasoningEffort !== level 时写 host+台账，host 已是目标
    // → 走「无变化」分支，陈旧台账永不修复；关闭插件时 revert 所有权判定失败。
    const { ctx, state } = makeCtx({
      nsConfig: { enabled: true, level: 'max', applied: { deepseek: { level: 'low', original: null } } },
      deepseekSection: { reasoningEffort: 'max' },
      emitSettingsEvents: true,
    })
    await mount(ctx)
    await waitFor(() => state.nsConfig.applied?.deepseek?.level === 'max', 2500, '陈旧台账自愈到 max')
    assert.equal(state.deepseekSection.reasoningEffort, 'max', 'host 已等于目标时保持原值')
    assert.equal(hostWriteCalls(state, 'llm-deepseek').length, 0, '无 host 变更时不得 mutate')
    assert.equal(state.nsConfig.applied.deepseek.original, null, '自愈必须保留原 original')

    // 再走一轮 max → low → max：最终台账必须是 max（不得停在中间态）。
    await state.settings.update('llm-reasoning', { level: 'low' })
    await waitFor(() => state.deepseekSection.reasoningEffort === 'low', 2500, 'low 生效')
    await waitFor(() => state.nsConfig.applied?.deepseek?.level === 'low', 2500, '台账跟随 low')
    await state.settings.update('llm-reasoning', { level: 'max' })
    await waitFor(() => state.deepseekSection.reasoningEffort === 'max', 2500, 'max 生效')
    await waitFor(() => state.nsConfig.applied?.deepseek?.level === 'max', 2500, '最终台账 max')
    assert.equal(state.nsConfig.applied.deepseek.level, 'max')
  } finally {
    env.restore()
  }
})

const INPUT_ROUTE = 'glm-local'
const INPUT_MODEL = 'glm-5.3'
const INPUT_KEY = `${INPUT_ROUTE}/${INPUT_MODEL}`
const FULL7 = { off: null, minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' }
const inputSection = () => ({
  providers: {
    [INPUT_ROUTE]: {
      reasoning: 'high',
      models: [{ id: INPUT_MODEL, name: 'GLM 5.3', input: ['text', 'image'], reasoningEfforts: clone(FULL7) }],
    },
  },
})

test('(live-7) appliedInputs 崩溃一致性：host 已是目标 input 时仍修复陈旧台账（旧实现 RED）', async () => {
  const env = tempHome()
  try {
    // 崩溃场景：host 已写 [text,image]，但 appliedInputs 停在 written=[text]。
    // 旧实现 plan.changed=false → continue → updated=0 → return，台账永不修复；
    // 关闭插件时撤销所有权判断失败。修复后应只修台账、不 replace 宿主。
    const { ctx, state } = makeCtx({
      nsConfig: {
        enabled: true,
        level: 'high',
        modelInput: { [INPUT_KEY]: ['text', 'image'] },
        appliedInputs: { [INPUT_KEY]: { written: ['text'], previous: null } },
      },
      piAiSection: inputSection(),
      emitSettingsEvents: true,
    })
    await mount(ctx)
    await waitFor(() => state.nsConfig.appliedInputs?.[INPUT_KEY]?.written?.length === 2, 2500, '陈旧 appliedInputs 自愈')
    assert.deepEqual(state.nsConfig.appliedInputs[INPUT_KEY], { written: ['text', 'image'], previous: null })
    assert.equal(state.replaceCalls.filter((call) => call.ns === 'llm-pi-ai').length, 0, 'host 已是目标时不得 replace')
    assert.deepEqual(state.piAiSection.providers[INPUT_ROUTE].models[0].input, ['text', 'image'])

    // 一轮 image off：撤销回原始缺省（previous=null）并清空台账。
    await state.settings.update('llm-reasoning', { modelInput: {} })
    await waitFor(() => state.piAiSection.providers[INPUT_ROUTE].models[0].input === undefined, 2500, 'off 后 input 撤销')
    await waitFor(() => Object.keys(state.nsConfig.appliedInputs ?? {}).length === 0, 2500, 'off 后台账清空')

    // 再 on：重新写回 [text,image]，previous=null，台账跟随。
    await state.settings.update('llm-reasoning', { modelInput: { [INPUT_KEY]: ['text', 'image'] } })
    await waitFor(() => Array.isArray(state.piAiSection.providers[INPUT_ROUTE].models[0].input), 2500, 'on 后 input 写回')
    await waitFor(() => state.nsConfig.appliedInputs?.[INPUT_KEY]?.written?.length === 2, 2500, 'on 后台账跟随')
    assert.deepEqual(state.nsConfig.appliedInputs[INPUT_KEY], { written: ['text', 'image'], previous: null })
  } finally {
    env.restore()
  }
})

test('(live-8) applied.routes 陈旧台账自愈：host route reasoning 已是目标时仍修复（旧实现 RED）', async () => {
  const env = tempHome()
  try {
    // 崩溃/自写场景：host route reasoning 已是 max，但 applied.routes[route]=low。
    // 旧实现只在 `current !== level` 分支写 host+台账 → host 已等于目标时跳过，
    // 陈旧路由台账永不修复；关闭插件时 revertPiAiCore 所有权判定失败。
    const { ctx, state } = makeCtx({
      nsConfig: { enabled: true, level: 'max', applied: { routes: { [INPUT_ROUTE]: 'low' } } },
      piAiSection: {
        providers: {
          [INPUT_ROUTE]: {
            reasoning: 'max',
            models: [{ id: INPUT_MODEL, name: 'GLM 5.3', reasoningEfforts: clone(FULL7) }],
          },
        },
      },
      emitSettingsEvents: true,
    })
    await mount(ctx)
    await waitFor(() => state.nsConfig.applied?.routes?.[INPUT_ROUTE] === 'max', 2500, '陈旧 routes 台账自愈')
    assert.equal(state.piAiSection.providers[INPUT_ROUTE].reasoning, 'max', 'host 已是目标时保持原值')
    assert.equal(state.replaceCalls.filter((call) => call.ns === 'llm-pi-ai').length, 0, '无 host 变更时不得 replace')

    // 再走一轮 max → low → max：最终路由台账必须跟随。
    await state.settings.update('llm-reasoning', { level: 'low' })
    await waitFor(() => state.piAiSection.providers[INPUT_ROUTE].reasoning === 'low', 2500, 'low 生效')
    await waitFor(() => state.nsConfig.applied?.routes?.[INPUT_ROUTE] === 'low', 2500, '台账跟随 low')
    await state.settings.update('llm-reasoning', { level: 'max' })
    await waitFor(() => state.piAiSection.providers[INPUT_ROUTE].reasoning === 'max', 2500, 'max 生效')
    await waitFor(() => state.nsConfig.applied?.routes?.[INPUT_ROUTE] === 'max', 2500, '最终台账 max')
    assert.equal(state.nsConfig.applied.routes[INPUT_ROUTE], 'max')
  } finally {
    env.restore()
  }
})

test('(live-9) 负向：host 是用户值 high 时不得把 applied.routes 自愈成 max（旧实现 RED）', async () => {
  const env = tempHome()
  try {
    // R2 P2-1：旧实现只要 persistedLevel !== level 就修台账，即使 host 是用户值
    // high（从未写过 max）→ 台账谎称写过 max。修复后仅 host===level 才自愈；
    // host 不等且非本插件所有权 → 不写、不 claim。
    const { ctx, state } = makeCtx({
      nsConfig: { enabled: true, level: 'max', applied: { routes: { [INPUT_ROUTE]: 'low' } } },
      piAiSection: {
        providers: {
          [INPUT_ROUTE]: {
            reasoning: 'high',
            models: [{ id: INPUT_MODEL, name: 'GLM 5.3', reasoningEfforts: clone(FULL7) }],
          },
        },
      },
      emitSettingsEvents: true,
    })
    await mount(ctx)
    await waitFor(() => appliedCount(state) >= 1, 2000, 'boot apply')
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(state.piAiSection.providers[INPUT_ROUTE].reasoning, 'high', '用户值不得被覆盖')
    assert.equal(state.nsConfig.applied.routes[INPUT_ROUTE], 'low', '未写 host 不得声称写过 max')
    assert.equal(state.replaceCalls.filter((call) => call.ns === 'llm-pi-ai').length, 0, '无所有权时不得 replace')
  } finally {
    env.restore()
  }
})

test('(live-10) deepseek mutate 失败：不得先落台账（旧实现 RED）', async () => {
  const env = tempHome()
  try {
    // R2 P2-2：旧实现先 persist 台账再 mutate；mutate 失败会留下「声称写过」的
    // 陈旧台账。修复后 host 不等 → 先 mutate，成功才落；失败保持旧台账/宿主。
    const { ctx, state } = makeCtx({
      nsConfig: { enabled: true, level: 'max', applied: { deepseek: { level: 'low', original: null } } },
      deepseekSection: { reasoningEffort: 'low' },
      // 只拒宿主 llm-deepseek 的 mutate，放行 llm-reasoning 台账写：旧实现「先
      // 落台账再写 host」会真的把 applied.deepseek 改成 max（可判别 RED），而不是
      // 被全拒守卫一起挡住导致新旧都停在 low。
      writeGuard: (request) => (request?.ns === 'llm-deepseek' ? new Error('boom') : undefined),
    })
    await mount(ctx)
    await waitFor(() => appliedCount(state) >= 1, 2000, 'apply 完成')
    await new Promise((resolve) => setTimeout(resolve, 400))
    assert.equal(state.deepseekSection.reasoningEffort, 'low', 'mutate 失败时 host 不变')
    assert.equal(state.nsConfig.applied.deepseek.level, 'low', 'mutate 失败不得落台账')
    assert.equal(state.mutateCalls.filter((call) => call.ns === 'llm-reasoning').length, 0, '失败前不得先写台账')
    assert.ok(state.logs.some((entry) => entry.level === 'warn'
      && typeof entry.args[0] === 'string'
      && entry.args[0].includes('mutate failed')), '失败必须留 warn 日志')
  } finally {
    env.restore()
  }
})
