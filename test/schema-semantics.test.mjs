/**
 * N4（R1 §0.5 非阻塞建议 → TDD 期望测试）+ 超长输入边界（QA 硬门槛：超长类 ≥1 用例）。
 *
 * N4 背景：生产写法 z.dict(z.dict(z.string()), z.string()) 的"string|null"语义依赖
 * 本引擎（schemastery 3.18.1）对未 required schema 的 nullable 直通行为；"未来严格
 * 引擎语义"无法在当前进程切换引擎验证，改为断言显式 z.union([z.string(), z.const(null)])
 * 写法在**当前引擎**下与生产写法的接受/拒绝行为等价——若未来引擎收紧 nullable 直通，
 * 本用例会先在生产 schema 上失败，提示 Developer 对齐写法（N4 建议）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeCtx, mount } from './harness.mjs'

test('(N4) probeEfforts 值 schema：z.string() 与 z.union([z.string(), z.const(null)]) 行为等价', async () => {
  const { ctx, state } = makeCtx({ nsConfig: { enabled: false, statsPublic: true } })
  await mount(ctx)
  const z = (await import('@deepseek-ai/schemastery')).default
  const prod = state.schemas.get('llm-reasoning')
  assert.ok(prod, 'Config schema must be registered')
  const explicit = z.object({
    probeEfforts: z.dict(z.dict(z.string(), z.union([z.string(), z.const(null)])), z.string()).default({}),
  })
  const cases = [
    { 'zai/m2': { off: 'disabled', low: 'low' } },
    { 'openai/m3': { off: null, low: 'low' } },
    { 'gateway/m9': { minimal: 'minimal', max: 'max' } },
    { 'gateway/m9': { low: 'x'.repeat(8) } }, // 线值词表外字符串：两者都放行（等价性对照）
  ]
  for (const probeEfforts of cases) {
    const a = explicit({ probeEfforts })
    const b = prod({ probeEfforts })
    assert.deepEqual(a.probeEfforts, b.probeEfforts)
  }
  // 非字符串：两者一致拒绝
  for (const bad of [123, true, { nested: 1 }, ['low']]) {
    assert.throws(() => explicit({ probeEfforts: { 'zai/m2': { off: bad } } }))
    assert.throws(() => prod({ probeEfforts: { 'zai/m2': { off: bad } } }))
  }
})

test('(bound-1) 超长输入：probeEfforts 值 64KB 字符串经 schema 接受，内容不改写', async () => {
  const { ctx, state } = makeCtx({ nsConfig: { enabled: false, statsPublic: true } })
  await mount(ctx)
  const schema = state.schemas.get('llm-reasoning')
  const long = 'x'.repeat(64 * 1024)
  const parsed = schema({ probeEfforts: { 'zai/m2': { low: long } } })
  assert.equal(parsed.probeEfforts['zai/m2'].low, long)
})
