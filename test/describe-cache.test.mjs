/**
 * R0-P1-1（REVIEW-MAINT-035+036-R0）判别测试：describe 结果缓存。
 *
 * 防护目标：宿主 SettingsForms.describe() 无缓存（每次全量 profile 目录磁盘
 * 读 + YAML 解析 + 全 entry schema toJSON，Reviewer 实测 ~8.5ms/次）——
 * agent/request 与 llm/stream 热路径逐调用触发 = 每请求 10-40ms 额外延迟
 * （违反「请求路径零影响」自宣誓）。修复 = describeEntries 缓存 + settings
 * 变更事件失效（宿主对所有写者 emit，含本插件自身写）+ TTL 兜底。
 *
 * 判别性：旧码（无缓存，185692f/fbf0f2c 状态）下 cache-1 判红——每次
 * agent/request 都使 describeCalls 递增；事件失效路径（cache-2）同判。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeCtx, mount } from './harness.mjs'

const settle = () => new Promise((resolve) => setImmediate(resolve))

/** 驱动 agent/request 钩子（热路径代表——注入判定读 configOf）。 */
async function driveAgentRequest(state) {
  const handler = state.handlers.get('agent/request')
  assert.ok(typeof handler === 'function', 'agent/request handler registered')
  await handler({ provider: 'glm-local', model: 'glm-5.3' }, async () => ({}))
}

test('(cache-1) 热路径零 describe 放大：10× agent/request 在 TTL 窗口内全部命中缓存', async () => {
  const { ctx, state } = makeCtx({ piAiSection: { providers: { 'glm-local': { models: [{ id: 'glm-5.3', reasoningEfforts: { high: 'high' } }] } } } })
  await mount(ctx)
  await settle()
  state.describeCalls = 0
  for (let i = 0; i < 10; i++) await driveAgentRequest(state)
  await settle()
  assert.equal(state.describeCalls, 0)
})

test('(cache-2) settings 变更事件（任意 ns）失效缓存 → 下次读取走宿主新鲜面并重新缓存', async () => {
  const { ctx, state } = makeCtx({ piAiSection: { providers: { 'glm-local': { models: [{ id: 'glm-5.3', reasoningEfforts: { high: 'high' } }] } } } })
  await mount(ctx)
  await settle()
  state.describeCalls = 0
  await driveAgentRequest(state)
  await settle()
  assert.equal(state.describeCalls, 0, '前置：缓存命中')
  // 无关 ns 的设置变更（其他插件）也应失效——保守失效面
  state.handlers.get('settings/document-updated')('some-other-ns')
  state.describeCalls = 0
  await driveAgentRequest(state)
  await settle()
  assert.equal(state.describeCalls, 1, '事件失效后恰好一次新鲜 describe')
  // 重新缓存：后续热路径再次零 describe
  state.describeCalls = 0
  for (let i = 0; i < 5; i++) await driveAgentRequest(state)
  await settle()
  assert.equal(state.describeCalls, 0)
})

test('(cache-3) 历史名 settings/updated 候选同样失效（跨代容错路径不漏失效）', async () => {
  const { ctx, state } = makeCtx({ piAiSection: { providers: { 'glm-local': { models: [{ id: 'glm-5.3', reasoningEfforts: { high: 'high' } }] } } } })
  await mount(ctx)
  await settle()
  assert.ok(typeof state.handlers.get('settings/updated') === 'function', '历史候选已注册')
  // 用无关 ns 隔离失效路径（ns 命中时 applyLevel 的同步读会竞争计数器——
  // 该 applyLevel 路径由 settings-face-2 候选测试覆盖）
  state.handlers.get('settings/updated')('some-other-ns')
  state.describeCalls = 0
  await driveAgentRequest(state)
  await settle()
  assert.equal(state.describeCalls, 1)
})
