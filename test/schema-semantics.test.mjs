/**
 * N4（R1 §0.5 非阻塞建议 → TDD 期望测试）+ 超长输入边界（QA 硬门槛：超长类 ≥1 用例）。
 *
 * N4 背景：生产写法 z.dict(z.dict(z.string()), z.string()) 的"string|null"语义依赖
 * 本引擎（schemastery 3.18.x）对未 required schema 的 nullable 直通行为；"未来严格
 * 引擎语义"无法在当前进程切换引擎验证，改为断言显式 z.union([z.string(), z.const(null)])
 * 写法在**当前引擎**下与生产写法的接受/拒绝行为等价——若未来引擎收紧 nullable 直通，
 * 本用例会先在生产 schema 上失败，提示 Developer 对齐写法（N4 建议）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isVolatile } from '@deepseek-ai/cosmokit'
import { makeCtx, mount, loadPlugin } from './harness.mjs'

// MAINT-035（schemastery 3.18.5）：volatile 字段经 Schema.resolve 后是可观察盒
//（cosmokit createVolatile——宿主 plainConfig 同源解包；生产读路径 describe().value
// 恒为解包后的普通数据）。测试直接 resolve 生产 schema 时按宿主同源语义解包。
const unwrapVolatile = (v) => (isVolatile(v) ? v.get() : v)

test('(N4) probeEfforts 值 schema：z.string() 与 z.union([z.string(), z.const(null)]) 行为等价', async () => {
  const { ctx, state } = makeCtx({ nsConfig: { enabled: false, statsPublic: true } })
  await mount(ctx)
  const z = (await import('@deepseek-ai/schemastery')).default
  const prod = (await loadPlugin()).Config
  assert.ok(prod, 'Config schema must be exported by the plugin entry (MAINT-035: 0.2.0 volatile declaration)')
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
    assert.deepEqual(a.probeEfforts, unwrapVolatile(b.probeEfforts))
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
  const schema = (await loadPlugin()).Config
  const long = 'x'.repeat(64 * 1024)
  const parsed = schema({ probeEfforts: { 'zai/m2': { low: long } } })
  assert.equal(unwrapVolatile(parsed.probeEfforts)['zai/m2'].low, long)
})

test('(R0-P3-1) 已实测：z.dict 隐式默认 {}——lastProbe.models / blockedReasons 字段在场而非缺席', async () => {
  const { ctx } = makeCtx({ nsConfig: { enabled: false, statsPublic: true } })
  await mount(ctx)
  const schema = (await loadPlugin()).Config
  const unwrap = unwrapVolatile
  // Config({}) → lastProbe = { models: {} }（不是「字段缺席」）：
  const empty = unwrap(schema({}).lastProbe)
  assert.deepEqual(empty.models, {}, 'z.dict 隐式默认 {}：空配置解析出 lastProbe.models={}（注释必须按事实描述）')
  // 旧数据（模型条目无 blockedReasons）→ 字段在场、空对象：
  const old = unwrap(schema({
    lastProbe: { t: 1, models: { 'a/b': { working: [], rejected: [], blocked: [], persisted: 'written' } } },
  }).lastProbe)
  const entry = old.models['a/b']
  assert.ok(Object.prototype.hasOwnProperty.call(entry, 'blockedReasons'), '旧数据解析后 blockedReasons 字段必须在场（空对象）——不是缺席')
  assert.deepEqual(entry.blockedReasons, {}, 'blockedReasons 空对象 = 未知原因降级路径（客户端 probeReasonText 已处理）')
  // 注释里保留 .default(undefined) 备选的事实依据：该 API 在本版本可用，但会再引入
  // 一种空值形状（parse(undefined) === undefined），故生产 schema 不采用。
  const z = (await import('@deepseek-ai/schemastery')).default
  const explicitUndefined = z.dict(z.string(), z.string()).default(undefined)
  assert.equal(explicitUndefined(undefined), undefined, '.default(undefined) 在 schemastery 3.18.5 可用（已实测）')
})
