/**
 * MAINT-041 判别测试：账号版 DeepSeek 适配器（路由 `deepseek-account`，设置 ns
 * `llm-deepseek-account`）的默认等级同步。
 *
 * 报障事实（用户 2026-10-22，截图 sha256:3a3bf30e）：全局默认设为 max，但
 * `DeepSeek-V4.1-Flash` 的输入区控件仍显示 **High**。
 *
 * 根因：该路由不在 `llm-pi-ai.providers` 里（探测显示 `not-in-pi-ai-config`），
 * 默认等级只由 `llm-deepseek-account.reasoningEffort` 决定（适配器默认 high）。
 * 修复前插件只同步 `llm-deepseek`（API Key 版），账号版完全没有被写过 —— 所以
 * 「全局默认等级」对账号管理的模型 100% 不生效。
 *
 * 本测试锁定五条边界，每条在旧实现下都红：
 *  account-1 全局 max → 写 `llm-deepseek-account.reasoningEffort`，并落台账；
 *  account-2 两个 DeepSeek 适配器同时存在时各写各的（互不干扰）；
 *  account-3 适配器未安装（设置节 undefined）→ 不写、不落台账（不能凭空创建）；
 *  account-4 全局切到 DeepSeek 不支持的档（xhigh）→ 还原介入前原值（high）；
 *  account-5 用户手改过则关闭时不还原（所有权门控语义与路由默认一致）；
 *  account-6 探测结局：账号版路由的模型归 `official-adapter`（不再误报「其他适配器」）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeCtx, mount, callRoute } from './harness.mjs'

const ACCOUNT_NS = 'llm-deepseek-account'
const OFFICIAL_NS = 'llm-deepseek'

const settle = async () => { await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r)) }

const accountWrites = (state) => state.mutateCalls.filter((call) => call.ns === ACCOUNT_NS)
const officialWrites = (state) => state.mutateCalls.filter((call) => call.ns === OFFICIAL_NS)
const lastEffortWrite = (calls) => {
  const call = calls[calls.length - 1]
  if (call === undefined) return undefined
  return call.ops.find((op) => Array.isArray(op.path) && op.path[0] === 'reasoningEffort')
}

test('(account-1) 全局 max → 写 llm-deepseek-account.reasoningEffort 并落所有权台账', async () => {
  const { ctx, state } = makeCtx({
    nsConfig: { enabled: true, level: 'max', statsPublic: true },
    deepseekAccountSection: { reasoningEffort: 'high' },
  })
  await mount(ctx)
  const write = lastEffortWrite(accountWrites(state))
  assert.ok(write !== undefined, 'llm-deepseek-account 必须被写入（旧实现一次都不写）')
  assert.deepEqual(write, { op: 'set', path: ['reasoningEffort'], value: 'max' })
  const applied = state.nsConfig.applied ?? {}
  assert.deepEqual(applied.deepseekAccount, { level: 'max', original: 'high' }, '原值 high 必须进台账（关闭时才能还原）')
})

test('(account-2) 两个 DeepSeek 适配器各写各的，互不覆盖', async () => {
  const { ctx, state } = makeCtx({
    nsConfig: { enabled: true, level: 'max', statsPublic: true },
    deepseekSection: { reasoningEffort: 'low' },
    deepseekAccountSection: { reasoningEffort: 'high' },
  })
  await mount(ctx)
  assert.equal(lastEffortWrite(officialWrites(state))?.value, 'max')
  assert.equal(lastEffortWrite(accountWrites(state))?.value, 'max')
  const applied = state.nsConfig.applied ?? {}
  assert.deepEqual(applied.deepseek, { level: 'max', original: 'low' })
  assert.deepEqual(applied.deepseekAccount, { level: 'max', original: 'high' })
})

test('(account-3) 账号适配器未安装（设置节 undefined）→ 不写、不落台账', async () => {
  const { ctx, state } = makeCtx({
    nsConfig: { enabled: true, level: 'max', statsPublic: true },
  })
  await mount(ctx)
  assert.equal(accountWrites(state).length, 0, '未安装的适配器不得被写入')
  const applied = state.nsConfig.applied ?? {}
  assert.equal(applied.deepseekAccount, undefined, '未持有所有权时不得落台账')
})

test('(account-4) 全局档不被该适配器支持（xhigh）→ 还原介入前原值', async () => {
  const { ctx, state } = makeCtx({
    nsConfig: { enabled: true, level: 'high', statsPublic: true },
    deepseekAccountSection: { reasoningEffort: 'low' },
  })
  await mount(ctx)
  assert.equal(lastEffortWrite(accountWrites(state))?.value, 'high')
  // 切到 DeepSeek 词表外的档（DeepSeek 只认 off/low/high/max）
  state.nsConfig.level = 'xhigh'
  const onUpdate = state.handlers.get('settings/document-updated')
  assert.ok(onUpdate !== undefined, 'settings/document-updated handler must be registered')
  onUpdate('llm-reasoning')
  await settle()
  const write = lastEffortWrite(accountWrites(state))
  assert.deepEqual(write, { op: 'set', path: ['reasoningEffort'], value: 'low' }, '必须还原到介入前的 low')
  assert.equal((state.nsConfig.applied ?? {}).deepseekAccount, undefined, '还原后必须清除所有权')
})

test('(account-5) 用户手改过该值 → 关闭插件时不还原（所有权门控）', async () => {
  const { ctx, state } = makeCtx({
    nsConfig: { enabled: true, level: 'max', statsPublic: true },
    deepseekAccountSection: { reasoningEffort: 'high' },
  })
  await mount(ctx)
  assert.equal(accountWrites(state).length, 1)
  // 用户在宿主设置里把手改成 low（不是插件写的 max）
  state.deepseekAccountSection = { ...state.deepseekAccountSection, reasoningEffort: 'low' }
  state.nsConfig.enabled = false
  const onUpdate = state.handlers.get('settings/document-updated')
  assert.ok(onUpdate !== undefined, 'settings/document-updated handler must be registered')
  onUpdate('llm-reasoning')
  await settle()
  assert.equal(accountWrites(state).length, 1, '用户手改的值不得被插件覆盖')
  assert.deepEqual(state.deepseekAccountSection.reasoningEffort, 'low')
})

test('(account-6) 探测结局：账号版路由归 official-adapter，不误报「其他适配器」', async () => {
  const { ctx, state } = makeCtx({
    nsConfig: { enabled: false, statsPublic: true },
    deepseekAccountSection: { reasoningEffort: 'high' },
    // 探针池里不存在这个模型 → 每档都失败；关键看 persisted 归因
    resolveModelInfo: async () => undefined,
  })
  await mount(ctx)
  const r = await callRoute(state, '/reasoning-level-stats/probe', { provider: 'deepseek-account', model: 'deepseek-v4-pro' })
  assert.equal(r.code, 200)
  assert.equal(
    r.payload.persisted,
    'skipped:official-adapter',
    '账号版适配器管辖的模型应归 official-adapter（修复前是 not-in-pi-ai-config）',
  )
})
