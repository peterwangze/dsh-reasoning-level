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
  // P3-10（REVIEW-REL-012-R0/R1）：断言「没有记下所有权」而非「键必须缺失」——
  // 生产 schema 会把缺席的嵌套 object 物化成 `{}`，写死 `=== undefined` 在真机上不成立。
  assert.equal((applied.deepseekAccount ?? {}).level, undefined, '未持有所有权时不得落 level')
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

// ── 模型级默认（MAINT-041 第二面）─────────────────────────────────────────────
// 「全局默认」靠路由 config 同步；「模型级默认」靠 agent/request 注入，而注入要求
// supportedEfforts 非空。两条 DeepSeek 适配器的档位集合是**文档化**的
// （official 常量 OFF/LOW/HIGH/MAX；account README「每个模型都提供 off、low、high、max」），
// 因此 resolveModelInfo 给不出东西时必须按契约兜底，否则模型级默认对这两条路由静默失效。
// 五个用例锁定兜底的边界：生效 / 两条路由各自生效 / 词表外的档不注入 /
// 适配器未安装不臆造 / 真实上报更宽时以真实上报为准。
async function injectFor(options, provider, model) {
  const { ctx, state } = makeCtx(options)
  await mount(ctx)
  const onRequest = state.handlers.get('agent/request')
  assert.ok(onRequest !== undefined, 'agent/request handler must be registered')
  return onRequest({}, async () => ({ provider, model, maxTokens: 1 }))
}

test('(model-1) 账号版路由：模型级默认在 resolveModelInfo 无能力时仍注入', async () => {
  const cfg = await injectFor({
    nsConfig: { enabled: true, level: 'high', models: { 'deepseek-account/deepseek-v4-pro': 'max' }, statsPublic: true },
    deepseekAccountSection: { reasoningEffort: 'high' },
    resolveModelInfo: async () => undefined,
  }, 'deepseek-account', 'deepseek-v4-pro')
  assert.equal(cfg.reasoningEffort, 'max')
})

test('(model-2) API Key 版路由：同一兜底同样生效', async () => {
  const cfg = await injectFor({
    nsConfig: { enabled: true, level: 'high', models: { 'deepseek-official/deepseek-flash': 'low' }, statsPublic: true },
    deepseekSection: { reasoningEffort: 'high' },
    resolveModelInfo: async () => undefined,
  }, 'deepseek-official', 'deepseek-flash')
  assert.equal(cfg.reasoningEffort, 'low')
})

test('(model-3) 兜底只给文档化的 off/low/high/max：词表外的档不注入', async () => {
  const cfg = await injectFor({
    nsConfig: { enabled: true, level: 'high', models: { 'deepseek-account/deepseek-v4-pro': 'xhigh' }, statsPublic: true },
    deepseekAccountSection: { reasoningEffort: 'high' },
    resolveModelInfo: async () => undefined,
  }, 'deepseek-account', 'deepseek-v4-pro')
  assert.equal(cfg.reasoningEffort, undefined, 'DeepSeek 不认 xhigh，不得注入')
})

test('(model-4) 适配器未安装（设置节 undefined）→ 不臆造能力、不注入', async () => {
  const cfg = await injectFor({
    nsConfig: { enabled: true, level: 'high', models: { 'deepseek-account/deepseek-v4-pro': 'max' }, statsPublic: true },
    resolveModelInfo: async () => undefined,
  }, 'deepseek-account', 'deepseek-v4-pro')
  assert.equal(cfg.reasoningEffort, undefined)
})

test('(model-5) 适配器真实上报了更宽的档位 → 以真实上报为准（兜底不覆盖）', async () => {
  const cfg = await injectFor({
    nsConfig: { enabled: true, level: 'high', models: { 'deepseek-account/x': 'ultra' }, statsPublic: true },
    deepseekAccountSection: { reasoningEffort: 'high' },
    resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low' }, { id: 'ultra' }] } }),
  }, 'deepseek-account', 'x')
  assert.equal(cfg.reasoningEffort, 'ultra')
})

// ── 生产 schema 物化形状（REVIEW-REL-012-R0 P1）───────────────────────────────
// schemastery 会把**缺席的嵌套 object 字段物化成 `{}`**。旧 readAppliedDeepseek
// 只看「是不是对象」→ 永远判成「台账已存在」→ ledger.original 恒 undefined →
// 被 dsh-settings 的 cloneJsonShaped 剥掉 → original 从来没落过盘（真机 profile
// 实证：两条路由都只有 level）。以下三条用例锁死修正后的语义。
test('(account-7) 台账被物化成 {} 时，首写仍能捕获 original（不得写 undefined）', async () => {
  const { ctx, state } = makeCtx({
    // 宿主把缺失的嵌套对象物化成 {} —— 这正是生产 describe 读到的形状
    nsConfig: { enabled: true, level: 'max', applied: { routes: {}, deepseek: {}, deepseekAccount: {} }, statsPublic: true },
    deepseekAccountSection: { reasoningEffort: 'high' },
  })
  await mount(ctx)
  const applied = state.nsConfig.applied ?? {}
  assert.deepEqual(applied.deepseekAccount, { level: 'max', original: 'high' }, '物化空对象必须视同缺席，original 要真的记下来')
  assert.ok(Object.prototype.hasOwnProperty.call(applied.deepseekAccount, 'original'), 'original 键必须存在（null 也是值，undefined 会被序列化剥掉）')
})

test('(account-8) 升级用户台账缺 original（历史写入被剥）→ 还原走 unset，不写回我们自己的值', async () => {
  const { ctx, state } = makeCtx({
    // 历史 v0.9.0 写入后 original 丢失；当前 section 已是插件写的 max
    nsConfig: { enabled: true, level: 'max', applied: { routes: {}, deepseek: { level: 'max' } }, statsPublic: true },
    deepseekSection: { reasoningEffort: 'max' },
  })
  await mount(ctx)
  state.nsConfig.enabled = false
  const onUpdate = state.handlers.get('settings/document-updated')
  onUpdate('llm-reasoning')
  await settle()
  const write = lastEffortWrite(officialWrites(state))
  assert.deepEqual(write, { op: 'unset', path: ['reasoningEffort'] }, '缺 original 时必须 unset（回落适配器默认），不能把 max 再写一遍假装还原')
})

test('(account-9) 生产 Config 确认物化行为（防止未来引擎变更悄悄改变判据）', async () => {
  const { loadPlugin } = await import('./harness.mjs')
  const prod = (await loadPlugin()).Config
  assert.ok(prod, 'Config schema must be exported')
  const parsed = prod({})
  const applied = typeof parsed.applied?.get === 'function' ? parsed.applied.get() : parsed.applied
  const normalized = JSON.parse(JSON.stringify(applied ?? {}))
  assert.deepEqual(normalized.deepseekAccount ?? {}, {}, 'schemastery 会把缺席的 applied.deepseekAccount 物化成 {}（本用例记录事实）')
})
