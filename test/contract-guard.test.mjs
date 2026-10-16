/**
 * MAINT-036 判别测试：宿主契约自检 fail-loud + settings 可选注入。
 *
 * 防护目标（三次升级事故的共性形态——「升级即静默失效」）：
 *  · 服务面漂移（方法缺失/改名）→ 旧形态 = 调用恒 throw 或恒 undefined、
 *    钩子永不触发；新形态 = boot 契约自检捕获 → log error + contractHealth
 *    降级 + 数据面自禁用（stats 端点仍活），宿主进程零伤害。
 *  · 0.1.x 旧宿主（register/get 形态，Config 导出不接线）→ describe() 永无
 *    llm-reasoning 描述符 → boot 重试耗尽 fail-loud 自禁用。
 *  · settings 服务缺席（极简 profile）→ 静态 inject 不再含 'settings'，
 *    插件行可加载，数据面自禁用，contractHealth 如实上报。
 *
 * 实证基座：0.2.0-rc.2 SettingsForms 方法面 = configure/describe/update/
 * replace/mutate（dsh-settings lib/index.js L322-497）；cordis 4.0.5 ctx.inject
 * 回调式可选注入（dsh-llm-pi-ai L2532 先例）。
 *
 * 桩说明：settingsMissing 经一次性 makeCtx 取内建 SettingsForms 桩再摘方法
 * （记录面落在此抛弃态上——负相路径本就自禁用，无写调用发生，断言不受影响；
 * 挂载态 state（routes/handlers/configureCalls）来自测试自己的 makeCtx）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { makeCtx, mount, loadPlugin, callRoute } from './harness.mjs'
import * as hostCompat from '../lib/host-compat.js'

const STATS = '/reasoning-level-stats'

/** 契约完整的内建桩上摘除若干 settings 方法（模拟服务面漂移）。 */
function settingsMissing(...methods) {
  const { ctx } = makeCtx()
  for (const method of methods) delete ctx.settings[method]
  return ctx.settings
}

/** describe() 永不含 llm-reasoning 描述符的旧宿主（0.1.x）形态桩。 */
function legacyHostSettings() {
  return {
    configure() { return () => {} },
    describe() {
      return [
        { ns: 'llm-pi-ai', user: undefined, value: {}, revision: 0 },
        { ns: 'llm-deepseek', user: undefined, value: undefined, revision: 0 },
        { ns: 'agent-default-model', user: undefined, value: undefined, revision: 0 },
      ]
    },
    update() { return Promise.resolve() },
    replace() { return Promise.resolve() },
    mutate() { return Promise.resolve() },
  }
}

// ── A. 消费面方法缺失 → 自禁用 + contractHealth 上报 ────────────────────────
test('(guard-1) settings.mutate 缺席 → 数据面自禁用（无事件注册/无迁移）+ health 上报', async () => {
  const { ctx, state } = makeCtx({ settingsImpl: settingsMissing('mutate') })
  await mount(ctx)
  const { payload } = await callRoute(state, STATS)
  assert.equal(payload.contractHealth.ok, false)
  assert.ok(payload.contractHealth.missing.includes('settings.mutate'))
  // 自禁用：事件候选未注册、configure 未调用、迁移标记未落盘
  assert.equal(state.handlers.has('settings/document-updated'), false)
  assert.equal(state.handlers.has('settings/updated'), false)
  assert.equal(state.configureCalls.length, 0)
  assert.equal(existsSync(join(process.env.DSH_HOME, 'storages', 'reasoning-level-migrated.json')), false)
})

test('(guard-2) llm.stream 非函数 → 同一自禁用路径（llm 面纳入自检）', async () => {
  const { ctx, state } = makeCtx({ stream: 'not-a-function' })
  await mount(ctx)
  const { payload } = await callRoute(state, STATS)
  assert.equal(payload.contractHealth.ok, false)
  assert.ok(payload.contractHealth.missing.includes('llm.stream'))
  assert.equal(state.handlers.has('settings/document-updated'), false)
})

// ── B. 旧宿主（entry 永不出现）→ boot 重试耗尽 fail-loud ────────────────────
test('(guard-3) describe 永无 llm-reasoning 描述符（0.1.x 形态）→ 重试耗尽自禁用 + health 降级', async () => {
  // timeoutImpl 同步驱动重试链：boot → 5 次重试 → 耗尽降级（不抛出）
  const { ctx, state } = makeCtx({ settingsImpl: legacyHostSettings(), timeoutImpl: (fn) => fn() })
  await mount(ctx)
  const { payload } = await callRoute(state, STATS)
  assert.equal(payload.contractHealth.ok, false)
  assert.ok(payload.contractHealth.missing.some((m) => m.includes('llm-reasoning')))
})

// ── C. settings 服务缺席（可选注入不触发）→ 端点仍活 + health 如实降级 ──────
test('(guard-4) 极简 profile 无 settings 服务 → stats 端点仍响应 + contractHealth 降级', async () => {
  const { ctx, state } = makeCtx({ deferInject: true })
  await mount(ctx)
  const { payload } = await callRoute(state, STATS)
  assert.equal(payload.contractHealth.ok, false)
  assert.ok(payload.contractHealth.missing.some((m) => m.includes('settings service')))
})

// ── D. 正常路径 + 静态/可选注入声明（MAINT-036 解耦面）───────────────────────
test('(guard-5) 正常路径 contractHealth.ok=true；静态 inject = [llm, timer]（settings 可选化）', async () => {
  const mod = await loadPlugin()
  assert.deepEqual(mod.inject, ['llm', 'timer'])
  assert.deepEqual([...hostCompat.HOST_SERVICES.serverInject], ['llm', 'timer'])
  assert.deepEqual([...hostCompat.HOST_SERVICES.optionalInject], ['settings'])
  const { ctx, state } = makeCtx()
  await mount(ctx)
  assert.deepEqual(state.injectCalls, [['settings']])
  const { payload } = await callRoute(state, STATS)
  assert.equal(payload.contractHealth.ok, true)
  assert.deepEqual(payload.contractHealth.missing, [])
  assert.ok(typeof payload.contractHealth.checkedAt === 'number')
})
