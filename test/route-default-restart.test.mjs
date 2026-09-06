/**
 * MAINT-028 判别测试（RCA docs/retro/rca-MAINT-027-028.md §5.2；真实 lib/index.js
 * + store-harness 两段 apply(新 ctx) 共享同一 store 模拟重启——RCA P2 证明场景）。
 *
 * 判别维度（修复前必须 RED 的断言逐条标注；现状 GREEN 锁定断言同样标注）：
 *  (d1) 种子台账重启跟随：applied.routes 认领陈旧路由默认 high → level=max 升级
 *       —— 028-F1 修复前 RED（RCA P2-a）
 *  (d2) 两段重启：会话 1 写入 high + 台账落盘；会话 2（新 ctx）level=max 跟随升级
 *       —— 028-F1 修复前 RED（台账落盘 + hydrate 双断点）
 *  (e)  断裂维度唯一性锁定（现状 GREEN，防修复扩大化）：无先验值直写 max；同进程
 *       high→max 可升级；用户手改值（无台账）不被覆盖（D-1a 承诺）
 *  (f)  禁用可还原：插件写入后重启 + enabled=false → 路由默认被移除 + 台账清除
 *       —— 028-F1 修复前 RED（RCA §3.1 同族）
 *  (g)  llm-deepseek 对照：升级现状 GREEN（无门控直写）；台账落盘 + 重启后禁用
 *       还原（含用户先验值恢复，防数据丢失）—— 028-F1 修复前 RED（还原半边）
 *  (h)  (默认) 记账语义（RCA §2.2 假设 B / §4 F3(028)）：llm/stream 入口无显式
 *       等级的调用，记账 effort 仍为 null（「(默认)」聚合桶不变），但必须另记
 *       推导出的将物化路由默认（defaulted）—— 028-F3 修复前 RED；路由默认不被
 *       模型能力支持时不标注（不 over-claim，现状与修复后均 GREEN）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mount, callRoute } from './harness.mjs'
import { makeStoreCtx } from './store-harness.mjs'

// 真实环境防护（隔离）：本文件 (h) 驱动真实统计记账路径（settleRecord → 5s
// persistTimer → persistStats 落盘 $DSH_HOME/storages/reasoning-level-stats.json）。
// 不重定向 DSH_HOME 时，node:test 即便失败也会等待 pending timer 自然退出并写盘
// （实测：失败用例 wall 3098ms > 用例时长，timer 照常触发）——测试将读写用户
// 真实 ~/.dsh 统计文件。重定向至 %TEMP% 唯一临时目录（每进程新建，杜绝跨运行
// boot 恢复串读上轮落盘数据）：boot 恢复 existsSync=false，落盘写入临时区，
// 读写均零接触真实环境（本文件全部挂载统一隔离）。
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-reasoning-level-test-'))

const clone = (v) => JSON.parse(JSON.stringify(v))
const FULL7 = { off: null, minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' }
const settle = () => new Promise((resolve) => setImmediate(resolve))

/** glm-local 路由两模型（7 键声明 → supportedLevels = 全 7 档，任意 level 均 allSupport）。 */
function glmPiAi(reasoning) {
  const profile = { api: 'openai-completions', models: [
    { id: 'glm-5.3', reasoningEfforts: clone(FULL7) },
    { id: 'glm-5.3-flash', reasoningEfforts: clone(FULL7) },
  ] }
  if (reasoning !== undefined) profile.reasoning = reasoning
  return { providers: { 'glm-local': profile } }
}

test('(d1) 种子台账重启跟随：applied.routes={glm-local:high} + 磁盘 reasoning=high + level=max → 升级 max（028-F1，修复前 RED；RCA P2-a）', async () => {
  const store = {
    nsConfig: { enabled: true, level: 'max', applied: { routes: { 'glm-local': 'high' } } },
    piAi: glmPiAi('high'),
    deepseek: undefined,
  }
  const { ctx } = makeStoreCtx(store)
  await mount(ctx)
  assert.equal(store.piAi.providers['glm-local'].reasoning, 'max', '持久台账恢复认领后必须跟随全局等级升级（重启失忆 = 缺陷）')
})

test('(d2) 两段重启：会话 1 写 high + 台账落盘；会话 2 level=max 跟随升级（028-F1，修复前 RED）', async () => {
  const store = {
    nsConfig: { enabled: true, level: 'high' },
    piAi: glmPiAi(undefined),
    deepseek: undefined,
  }
  const s1 = makeStoreCtx(store)
  await mount(s1.ctx)
  // 现状 GREEN：无先验值（current===undefined）门控放行写 high
  assert.equal(store.piAi.providers['glm-local'].reasoning, 'high')
  // 028-F1（修复前 RED）：所有权台账必须持久化到 llm-reasoning.applied
  assert.deepEqual(store.nsConfig.applied, { routes: { 'glm-local': 'high' } }, '会话 1 的路由所有权写入必须落盘 applied.routes')
  // 重启：新 ctx（内存台账清空）共享同一 store；用户把全局等级改为 max
  store.nsConfig.level = 'max'
  const s2 = makeStoreCtx(store)
  await mount(s2.ctx)
  // 028-F1（修复前 RED）：重启后必须认领自己写入的 high 并升级到 max
  assert.equal(store.piAi.providers['glm-local'].reasoning, 'max', '重启后必须凭持久台账认领并跟随升级（RCA P2-a 卡死 = 缺陷）')
})

test('(e) 断裂维度唯一性锁定（现状 GREEN）：无先验直写 / 同进程可升级 / 用户手改不被覆盖（D-1a）', async () => {
  // e1 无先验值 → 直写 max（门控放行条件 current===undefined，现状与修复后均 GREEN）
  {
    const store = { nsConfig: { enabled: true, level: 'max' }, piAi: glmPiAi(undefined), deepseek: undefined }
    const { ctx } = makeStoreCtx(store)
    await mount(ctx)
    assert.equal(store.piAi.providers['glm-local'].reasoning, 'max', '无先验值必须直写（现状 GREEN，RCA P2-c）')
  }
  // e2 同进程 high→max（无重启，mineLevel 在内存可认领，现状与修复后均 GREEN——RCA P2-d）
  {
    const store = { nsConfig: { enabled: true, level: 'high' }, piAi: glmPiAi(undefined), deepseek: undefined }
    const { ctx, state } = makeStoreCtx(store)
    await mount(ctx)
    assert.equal(store.piAi.providers['glm-local'].reasoning, 'high')
    store.nsConfig.level = 'max'
    const onUpdate = state.handlers.get('settings/updated')
    assert.ok(onUpdate !== undefined, 'settings/updated handler must be registered')
    onUpdate('llm-reasoning')
    await settle(); await settle(); await settle()
    assert.equal(store.piAi.providers['glm-local'].reasoning, 'max', '同进程 high→max 必须可升级（现状 GREEN，RCA P2-d）')
  }
  // e3 用户手改值（无台账、值≠全局）不被覆盖——D-1a 承诺（现状与修复后均 GREEN）
  {
    const store = { nsConfig: { enabled: true, level: 'max' }, piAi: glmPiAi('low'), deepseek: undefined }
    const { ctx } = makeStoreCtx(store)
    await mount(ctx)
    assert.equal(store.piAi.providers['glm-local'].reasoning, 'low', '无可认领台账的用户手改值必须被尊重（D-1a：不覆盖）')
  }
})

test('(f) 禁用可还原：插件写入后重启 + enabled=false → 路由默认移除 + 台账清除（028-F1，修复前 RED；RCA §3.1 同族 / P2-e）', async () => {
  const store = {
    nsConfig: { enabled: true, level: 'high' },
    piAi: glmPiAi(undefined),
    deepseek: undefined,
  }
  const s1 = makeStoreCtx(store)
  await mount(s1.ctx)
  assert.equal(store.piAi.providers['glm-local'].reasoning, 'high')
  // 重启 + 禁用
  store.nsConfig.enabled = false
  const s2 = makeStoreCtx(store)
  await mount(s2.ctx)
  assert.equal(store.piAi.providers['glm-local'].reasoning, undefined, '重启后禁用必须移除插件写入的路由默认（还原失忆 = 缺陷）')
  assert.equal(store.nsConfig.applied?.routes?.['glm-local'], undefined, '还原后台账必须清除该路由')
})

test('(g) llm-deepseek 对照：升级现状 GREEN + 台账落盘 + 重启后禁用还原（028-F1，还原半边修复前 RED）', async () => {
  // g1 用户先验值 low：会话 1 升级 max（无门控直写，现状 GREEN）+ 台账记录 original=low（修复前 RED）
  {
    const store = {
      nsConfig: { enabled: true, level: 'max' },
      piAi: glmPiAi(undefined),
      deepseek: { reasoningEffort: 'low' },
    }
    const { ctx } = makeStoreCtx(store)
    await mount(ctx)
    assert.equal(store.deepseek.reasoningEffort, 'max', 'llm-deepseek 升级路径现状 GREEN（无所有权门控，RCA P2-b）')
    // 028-F1（修复前 RED）：deepseek 所有权台账落盘（level + 覆盖前原值）
    assert.deepEqual(store.nsConfig.applied?.deepseek, { level: 'max', original: 'low' }, 'deepseek 所有权必须落盘（含覆盖前原值）')
    // 重启 + 禁用 → 还原用户先验值 low（修复前 RED：还原失忆，停留在 max）
    store.nsConfig.enabled = false
    const s2 = makeStoreCtx(store)
    await mount(s2.ctx)
    assert.equal(store.deepseek.reasoningEffort, 'low', '重启后禁用必须还原覆盖前的用户值（数据不丢失）')
    assert.equal(store.nsConfig.applied?.deepseek, undefined, '还原后 deepseek 台账必须清除')
  }
  // g2 无先验值：会话 1 写 max → 重启 + 禁用 → unset（字段移除，修复前 RED）
  {
    const store = {
      nsConfig: { enabled: true, level: 'max' },
      piAi: glmPiAi(undefined),
      deepseek: {},
    }
    const { ctx } = makeStoreCtx(store)
    await mount(ctx)
    assert.equal(store.deepseek.reasoningEffort, 'max')
    store.nsConfig.enabled = false
    const s2 = makeStoreCtx(store)
    await mount(s2.ctx)
    assert.equal(store.deepseek.reasoningEffort, undefined, '重启后禁用必须 unset（插件写入且原值缺省）')
  }
})

test('(h) (默认) 记账另记将物化的路由默认：effort 恒 null + defaulted=路由默认（028-F3，修复前 RED）+ 不 over-claim 锁定', async () => {
  const drainStream = (onStream, provider, model) => {
    const wrapped = onStream(
      { provider, model, messages: [] },
      () => (async function* () { yield { type: 'finish', reason: { kind: 'stop', failure: null } } })(),
    )
    return (async () => { for await (const _chunk of wrapped) { /* drain：finish 触发 settleRecord */ } })()
  }
  // h1 路由默认 high + 模型 7 键声明（支持 high）：入口无显式等级 → 另记 defaulted='high'
  {
    const store = {
      nsConfig: { enabled: true, level: 'high' },
      piAi: glmPiAi('high'),
      deepseek: undefined,
    }
    const { ctx, state } = makeStoreCtx(store)
    await mount(ctx)
    const onStream = state.handlers.get('llm/stream')
    assert.ok(onStream !== undefined, 'llm/stream handler must be registered')
    await drainStream(onStream, 'glm-local', 'glm-5.3')
    const stats = await callRoute(state, '/reasoning-level-stats', {})
    const rec = stats.payload.recent[0]
    assert.equal(rec.effort, null, '(默认) 桶语义不变：入口无显式等级 effort 记 null（聚合键兼容）')
    // 028-F3（修复前 RED）：必须另记将物化的路由默认——wire 实际携带
    // options.reasoningEffort ?? profile.reasoning（物化发生在插件 hook 之后）
    assert.equal(rec.defaulted, 'high', '(默认) 记录必须携带推导出的路由默认（statsHint 复合标注数据源）')
    assert.equal(stats.payload.models['glm-local/glm-5.3'].efforts['(默认)'], 1, '聚合键保持 (默认)（持久化统计兼容，不重命名）')
  }
  // h2 不 over-claim：路由默认 xhigh 不在 6 键声明模型支持面内（宿主会按能力调整）→ 不标注
  {
    const GEN6 = { off: null, minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', max: 'max' }
    const store = {
      nsConfig: { enabled: true, level: 'high' },
      piAi: { providers: { 'glm-local': { api: 'openai-completions', reasoning: 'xhigh', models: [
        { id: 'glm-5.3', reasoningEfforts: clone(GEN6) },
      ] } } },
      deepseek: undefined,
    }
    const { ctx, state } = makeStoreCtx(store)
    await mount(ctx)
    const onStream = state.handlers.get('llm/stream')
    await drainStream(onStream, 'glm-local', 'glm-5.3')
    const stats = await callRoute(state, '/reasoning-level-stats', {})
    assert.equal(stats.payload.recent[0].defaulted, undefined, '路由默认不被模型能力支持时不标注（不 over-claim 宿主物化结果）')
  }
})
